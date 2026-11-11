//! Copia de UN archivo por SFTP con peticiones encadenadas (pipelining).
//!
//! Subida: se leen bloques del disco en una tarea aparte y se envían escrituras sin esperar
//! la respuesta, con ~4 MB en vuelo. Al llegar al final se envían también `fsetstat`
//! (fecha/permisos/tamaño) y `close` sin esperar: un archivo pequeño cuesta 2 viajes.
//! Bajada: igual con lecturas encadenadas; los datos se escriben en orden en el disco.
//!
//! El progreso es el prefijo CONFIRMADO (`Ctrl::progress`): todo lo anterior está en el
//! destino, así que pausar/reintentar continúa desde ahí.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::task::{Context, Poll, Waker};

use futures::stream::{FuturesOrdered, StreamExt};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::paths::{local_io_message, remote_parent};
use super::pool::Chan;

/// Por qué se detuvo un trabajo en marcha.
pub const STOP_PAUSE: u8 = 1;
pub const STOP_CANCEL: u8 = 2;

/// Control de un trabajo en marcha (compartido entre el motor y la copia).
#[derive(Default)]
pub struct Ctrl {
    pub token: CancellationToken,
    pub stop: AtomicU8,
    /// Bytes confirmados en el destino.
    pub progress: AtomicU64,
    /// Ya se abrió/creó el destino (cancelar debe borrarlo).
    pub touched: AtomicBool,
}

impl Ctrl {
    pub fn new(start: u64) -> Self {
        let c = Ctrl::default();
        c.progress.store(start, Ordering::Relaxed);
        c
    }
    pub fn stop_with(&self, why: u8) {
        // Cancelar gana a pausar.
        self.stop.fetch_max(why, Ordering::SeqCst);
        self.token.cancel();
    }
}

#[derive(Debug)]
pub enum CopyError {
    /// Pausado o cancelado por el usuario.
    Stopped,
    /// El canal falló (cortes, tiempo de espera): se puede reintentar con otro canal.
    Transient(String),
    /// Error definitivo (permisos, no existe, disco lleno…).
    Fatal(String),
    /// La conexión SSH se cayó y se espera una reconexión: el trabajo vuelve a la cola
    /// (sin gastar reintentos) y continúa desde lo ya confirmado.
    Disconnected,
}

pub type CopyResult<T> = Result<T, CopyError>;

/// Traduce un error SFTP a español y decide si es reintentable.
pub fn sftp_err(e: SftpError) -> CopyError {
    match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoConnection | StatusCode::ConnectionLost => {
                CopyError::Transient("Se perdió la conexión".into())
            }
            StatusCode::NoSuchFile => CopyError::Fatal("No existe en el servidor".into()),
            StatusCode::PermissionDenied => CopyError::Fatal("Permiso denegado en el servidor".into()),
            StatusCode::OpUnsupported => CopyError::Fatal("El servidor no admite la operación".into()),
            _ => {
                let msg = s.error_message.trim();
                if msg.is_empty() || msg.eq_ignore_ascii_case("failure") {
                    CopyError::Fatal("El servidor rechazó la operación".into())
                } else {
                    CopyError::Fatal(format!("El servidor rechazó la operación: {msg}"))
                }
            }
        },
        SftpError::Timeout => CopyError::Transient("El servidor no respondió a tiempo".into()),
        SftpError::IO(m) => CopyError::Transient(format!("Error de red: {m}")),
        SftpError::UnexpectedBehavior(m) => CopyError::Transient(format!("El canal SFTP se cerró ({m})")),
        SftpError::Limited(m) => CopyError::Fatal(format!("Límite del servidor: {m}")),
        SftpError::UnexpectedPacket => CopyError::Transient("Respuesta inesperada del servidor".into()),
    }
}

/// Segundos Unix de una fecha local.
pub fn unix_secs_u64(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

pub fn is_no_such_file(e: &SftpError) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
}

fn local_err(e: std::io::Error) -> CopyError {
    CopyError::Fatal(local_io_message(&e))
}

type Op<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Hace el primer `poll` ahora mismo: la petición SFTP sale en este orden exacto
/// (las funciones de `RawSftpSession` envían en su primer poll).
fn send_now<'a, T: Send + 'a>(mut fut: Op<'a, T>) -> Op<'a, T> {
    let mut cx = Context::from_waker(Waker::noop());
    match fut.as_mut().poll(&mut cx) {
        Poll::Ready(v) => Box::pin(std::future::ready(v)),
        Poll::Pending => fut,
    }
}

/// Espera `fut` salvo que el trabajo se detenga antes.
async fn or_stop<T>(token: &CancellationToken, fut: impl Future<Output = T>) -> CopyResult<T> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(CopyError::Stopped),
        v = fut => Ok(v),
    }
}

/// Crea las carpetas remotas que falten (mkdir -p). Ignora "ya existe".
pub async fn remote_mkdir_p(chan: &Chan, dir: &str) -> Result<(), SftpError> {
    let mut missing = Vec::new();
    let mut cur = dir.trim_end_matches('/').to_string();
    while !cur.is_empty() && cur != "/" {
        match chan.raw.stat(cur.clone()).await {
            Ok(a) if a.attrs.is_dir() => break,
            Ok(_) => break, // existe pero no es carpeta: mkdir fallará con su error
            Err(e) if is_no_such_file(&e) => {
                missing.push(cur.clone());
                cur = remote_parent(&cur);
            }
            Err(e) => return Err(e),
        }
    }
    for d in missing.iter().rev() {
        remote_mkdir(chan, d).await?;
    }
    Ok(())
}

/// mkdir que ignora "ya existe" (OpenSSH responde Failure; se comprueba con stat).
pub async fn remote_mkdir(chan: &Chan, dir: &str) -> Result<(), SftpError> {
    match chan.raw.mkdir(dir.to_string(), FileAttributes::empty()).await {
        Ok(_) => Ok(()),
        Err(e) => match chan.raw.stat(dir.to_string()).await {
            Ok(a) if a.attrs.is_dir() => Ok(()),
            _ => Err(e),
        },
    }
}

/// Tamaño actual del destino (None si no existe o no se puede saber).
pub async fn remote_size(chan: &Chan, path: &str) -> Option<u64> {
    chan.raw.stat(path.to_string()).await.ok().and_then(|a| a.attrs.size)
}

pub async fn local_size(path: &Path) -> Option<u64> {
    tokio::fs::metadata(path).await.ok().map(|m| m.len())
}

#[cfg(unix)]
fn local_mode(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o7777
}
#[cfg(not(unix))]
fn local_mode(meta: &std::fs::Metadata) -> u32 {
    if meta.permissions().readonly() { 0o444 } else { 0o644 }
}

fn unix_secs(t: std::io::Result<std::time::SystemTime>) -> Option<u32> {
    t.ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs().min(u32::MAX as u64) as u32)
}

/// Sube `local` → `remote` empezando en `offset`. Devuelve el tamaño final.
pub async fn upload_file(chan: &Chan, local: &Path, remote: &str, offset: u64, ctrl: &Ctrl) -> CopyResult<u64> {
    let meta = tokio::fs::metadata(local).await.map_err(local_err)?;
    if !meta.is_file() {
        return Err(CopyError::Fatal("No es un archivo normal".into()));
    }
    let mode = local_mode(&meta);
    let mtime = unix_secs(meta.modified());
    let atime = unix_secs(meta.accessed()).or(mtime);

    let mut flags = OpenFlags::CREATE | OpenFlags::WRITE;
    if offset == 0 {
        flags |= OpenFlags::TRUNCATE;
    }
    let create_attrs = FileAttributes {
        permissions: Some(mode & 0o777),
        ..FileAttributes::empty()
    };
    let open = |a: FileAttributes| chan.raw.open(remote.to_string(), flags, a);
    let handle = match or_stop(&ctrl.token, open(create_attrs.clone())).await? {
        Ok(h) => h.handle,
        // Falta la carpeta (p. ej. no se pudo crear antes): mkdir -p y otra vez.
        Err(e) if is_no_such_file(&e) => {
            or_stop(&ctrl.token, remote_mkdir_p(chan, &remote_parent(remote)))
                .await?
                .map_err(sftp_err)?;
            or_stop(&ctrl.token, open(create_attrs)).await?.map_err(sftp_err)?.handle
        }
        Err(e) => return Err(sftp_err(e)),
    };

    ctrl.touched.store(true, Ordering::Relaxed);
    let result = upload_body(chan, local, &handle, offset, mode, atime, mtime, ctrl).await;
    if result.is_err() {
        // Cerrar sin esperar (el canal puede estar roto).
        let raw = &chan.raw;
        drop(send_now(Box::pin(raw.close(handle))));
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn upload_body(
    chan: &Chan,
    local: &Path,
    handle: &str,
    offset: u64,
    mode: u32,
    atime: Option<u32>,
    mtime: Option<u32>,
    ctrl: &Ctrl,
) -> CopyResult<u64> {
    let chunk = chan.write_chunk;
    let depth = Chan::depth(chunk);

    // Lector del disco en su propia tarea: así las lecturas locales se solapan con la red.
    let (tx, mut rx) = mpsc::channel::<std::io::Result<Vec<u8>>>(4);
    let path = local.to_path_buf();
    let reader = tokio::spawn(async move {
        let mut f = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => {
                let _ = tx.send(Err(e)).await;
                return;
            }
        };
        if offset > 0
            && let Err(e) = f.seek(std::io::SeekFrom::Start(offset)).await
        {
            let _ = tx.send(Err(e)).await;
            return;
        }
        loop {
            let mut buf = vec![0u8; chunk];
            let mut n = 0;
            while n < chunk {
                match f.read(&mut buf[n..]).await {
                    Ok(0) => break,
                    Ok(k) => n += k,
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                }
            }
            if n == 0 {
                return; // fin: se cierra el canal
            }
            buf.truncate(n);
            let last = n < chunk;
            if tx.send(Ok(buf)).await.is_err() || last {
                return;
            }
        }
    });

    let raw = &chan.raw;
    // (bytes de datos, resultado). Las operaciones finales llevan 0 bytes.
    let mut inflight: FuturesOrdered<Op<'_, (u64, Result<(), SftpError>)>> = FuturesOrdered::new();
    let mut next = offset;
    let mut acked = offset;
    let mut eof = false;
    let mut finished = false;

    let outcome: CopyResult<u64> = loop {
        if finished && inflight.is_empty() {
            break Ok(acked);
        }
        tokio::select! {
            biased;
            _ = ctrl.token.cancelled() => break Err(CopyError::Stopped),
            Some((len, res)) = inflight.next(), if !inflight.is_empty() => {
                if let Err(e) = res {
                    break Err(sftp_err(e));
                }
                acked += len;
                ctrl.progress.store(acked, Ordering::Relaxed);
            }
            msg = rx.recv(), if !eof && inflight.len() < depth => match msg {
                Some(Ok(buf)) => {
                    let len = buf.len() as u64;
                    let at = next;
                    next += len;
                    let h = handle.to_string();
                    inflight.push_back(send_now(Box::pin(async move {
                        (len, raw.write(h, at, buf).await.map(|_| ()))
                    })));
                }
                Some(Err(e)) => break Err(local_err(e)),
                None => {
                    eof = true;
                    finished = true;
                    // Tamaño final (recorta restos si el destino era más largo), fecha y permisos.
                    let attrs = FileAttributes {
                        size: Some(next),
                        permissions: (mode & 0o111 != 0).then_some(mode & 0o7777),
                        atime,
                        mtime,
                        ..FileAttributes::empty()
                    };
                    let h = handle.to_string();
                    inflight.push_back(send_now(Box::pin(async move {
                        // Un fallo al poner la fecha no invalida la copia.
                        let _ = raw.fsetstat(h, attrs).await;
                        (0, Ok(()))
                    })));
                    let h = handle.to_string();
                    inflight.push_back(send_now(Box::pin(async move {
                        (0, raw.close(h).await.map(|_| ()))
                    })));
                }
            },
        }
    };
    reader.abort();
    outcome
}

/// Baja `remote` → `local` empezando en `offset`. `size` es el tamaño conocido del remoto.
#[allow(clippy::too_many_arguments)]
pub async fn download_file(
    chan: &Chan,
    remote: &str,
    local: &Path,
    offset: u64,
    size: u64,
    mode: Option<u32>,
    mtime: Option<u32>,
    ctrl: &Ctrl,
) -> CopyResult<u64> {
    let raw = &chan.raw;
    let handle = or_stop(&ctrl.token, raw.open(remote.to_string(), OpenFlags::READ, FileAttributes::empty()))
        .await?
        .map_err(sftp_err)?
        .handle;

    let result = download_body(chan, &handle, local, offset, size, ctrl).await;
    match &result {
        Ok(_) => {}
        Err(_) => {
            drop(send_now(Box::pin(raw.close(handle))));
            return result;
        }
    }
    // Fecha y bit de ejecución (lo demás queda con los permisos por defecto del usuario).
    let path = local.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&path) {
            if let Some(m) = mtime {
                let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(m as u64);
                let _ = f.set_modified(t);
            }
            #[cfg(unix)]
            if let Some(mode) = mode
                && mode & 0o111 != 0
                && let Ok(meta) = f.metadata()
            {
                use std::os::unix::fs::PermissionsExt;
                let cur = meta.permissions().mode();
                let _ = f.set_permissions(std::fs::Permissions::from_mode(cur | (mode & 0o111)));
            }
        }
        #[cfg(not(unix))]
        let _ = mode;
    })
    .await;
    result
}

async fn download_body(chan: &Chan, handle: &str, local: &Path, offset: u64, size: u64, ctrl: &Ctrl) -> CopyResult<u64> {
    let raw = &chan.raw;
    let mut opts = tokio::fs::OpenOptions::new();
    opts.write(true).create(true);
    if offset == 0 {
        opts.truncate(true);
    }
    let file = match opts.open(local).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = local.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(local_err)?;
            }
            opts.open(local).await.map_err(local_err)?
        }
        Err(e) => return Err(local_err(e)),
    };
    ctrl.touched.store(true, Ordering::Relaxed);

    // Escritor de disco en un hilo aparte: la red no espera al disco.
    // `written` = bytes ya escritos (contiguos desde `offset`) → es el progreso real.
    let written = Arc::new(AtomicU64::new(offset));
    let (wtx, mut wrx) = mpsc::channel::<Vec<u8>>(16);
    let mut std_file = file.into_std().await;
    let w = written.clone();
    let writer = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::{Seek, Write};
        if offset > 0 {
            std_file.set_len(offset)?;
            std_file.seek(std::io::SeekFrom::Start(offset))?;
        }
        while let Some(buf) = wrx.blocking_recv() {
            std_file.write_all(&buf)?;
            w.fetch_add(buf.len() as u64, Ordering::Relaxed);
        }
        std_file.flush()
    });

    let chunk = chan.read_chunk as u64;
    let depth = Chan::depth(chan.read_chunk);
    type ReadOut = (u64, u64, Result<Vec<u8>, SftpError>);
    let mut inflight: FuturesOrdered<Op<'_, ReadOut>> = FuturesOrdered::new();
    let mut next = offset;
    let mut close: Option<Op<'_, Result<(), SftpError>>> = None;

    let outcome: CopyResult<()> = loop {
        while close.is_none() && inflight.len() < depth && next < size {
            let len = chunk.min(size - next);
            let at = next;
            next += len;
            let h = handle.to_string();
            inflight.push_back(send_now(Box::pin(async move {
                let r = raw.read(h, at, len as u32).await.map(|d| d.data);
                (at, len, r)
            })));
        }
        if close.is_none() && next >= size {
            // Todas las lecturas ya salieron: el close va detrás, sin esperar.
            let h = handle.to_string();
            close = Some(send_now(Box::pin(async move { raw.close(h).await.map(|_| ()) })));
        }
        if inflight.is_empty() {
            break Ok(());
        }
        let item = tokio::select! {
            biased;
            _ = ctrl.token.cancelled() => break Err(CopyError::Stopped),
            Some(item) = inflight.next() => item,
        };
        ctrl.progress.store(written.load(Ordering::Relaxed), Ordering::Relaxed);
        let (at, len, res) = item;
        match res {
            // EOF: el archivo se acortó.
            Ok(data) if data.is_empty() => break Ok(()),
            Ok(data) => {
                let n = data.len() as u64;
                if wtx.send(data).await.is_err() {
                    break Ok(()); // el escritor falló: su error se recoge abajo
                }
                if n < len {
                    // Lectura corta: se descarta lo encadenado y se sigue desde el hueco.
                    if close.is_some() {
                        // El handle ya se cerró: no se puede seguir leyendo con él.
                        break Err(CopyError::Transient("Lectura incompleta del servidor".into()));
                    }
                    inflight = FuturesOrdered::new();
                    next = at + n;
                }
            }
            Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => break Ok(()),
            Err(e) => break Err(sftp_err(e)),
        }
    };
    // Terminar de escribir lo recibido (también al pausar: así se conserva).
    drop(wtx);
    let wres = writer.await;
    let done = written.load(Ordering::Relaxed);
    ctrl.progress.store(done, Ordering::Relaxed);
    let outcome = match (outcome, wres) {
        (Err(e), _) => Err(e),
        (Ok(()), Ok(Ok(()))) => Ok(done),
        (Ok(()), Ok(Err(e))) => Err(local_err(e)),
        (Ok(()), Err(_)) => Err(CopyError::Fatal("Falló la escritura en disco".into())),
    };
    if outcome.is_ok()
        && let Some(c) = close
    {
        // Un fallo al cerrar una lectura no invalida los datos.
        let _ = or_stop(&ctrl.token, c).await;
    }
    outcome
}
