//! Ejecutar un comando en un canal `exec` aparte (sin PTY) y capturar su salida.
//!
//! Cómo se detiene el comando remoto (al cancelar o al vencer el tiempo):
//! 1. Se pide al servidor la señal TERM por el propio canal. OpenSSH 7.9 o más nuevo la envía a todo
//!    el grupo de procesos del comando; servidores más viejos (y otros) la ignoran.
//! 2. Si el canal no se cierra en un momento, se abre OTRO canal y se ejecuta `kill -TERM -GRUPO`,
//!    y después se repite con KILL (la señal KILL también se pide por el canal).
//!    Cerrar el canal no basta: sin PTY, el proceso remoto sigue vivo.
//!
//! Para saber qué grupo matar, el comando no se envía tal cual: se envía un arranque corto
//! (ver [`bootstrap`]) que escribe su PID en stderr (esa línea se quita antes de devolver la salida),
//! lee el comando real por stdin y lo ejecuta con el shell de login del usuario, como antes.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use russh::client::Msg;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Sig};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;
use crate::types::ExecResult;

/// Límite por flujo (stdout y stderr por separado).
pub const MAX_STREAM_BYTES: usize = 2 * 1024 * 1024;

/// Línea que el arranque escribe en stderr: `__TERVIEW_PID__=<pid>`.
const PID_MARK: &[u8] = b"__TERVIEW_PID__=";
/// Si stderr ya tiene esto y aún no apareció la marca, se deja de buscar.
const MARK_SEARCH_LIMIT: usize = 64 * 1024;

/// Espera tras pedir TERM (y luego KILL) antes de pasar al siguiente paso.
const GRACE: Duration = Duration::from_millis(1500);
/// Espera final tras el último intento.
const LAST_WAIT: Duration = Duration::from_millis(1000);
/// Tiempo máximo del canal auxiliar que ejecuta `kill`.
const KILL_EXEC_TIMEOUT: Duration = Duration::from_secs(5);

pub fn clamp_timeout(secs: u32) -> u64 {
    u64::from(secs.clamp(1, 600))
}

/// Añade `data` a `buf` sin pasar de `MAX_STREAM_BYTES`. Devuelve true si hubo que recortar.
fn push_limited(buf: &mut Vec<u8>, data: &[u8]) -> bool {
    let room = MAX_STREAM_BYTES.saturating_sub(buf.len());
    if data.len() <= room {
        buf.extend_from_slice(data);
        false
    } else {
        buf.extend_from_slice(&data[..room]);
        true
    }
}

// ───────────── Arranque y marca de PID ─────────────

/// Comando corto que se envía al servidor en lugar del comando real (`len` = bytes del comando real).
///
/// - Va entre comillas simples para el shell de login (bash, zsh, fish, tcsh, dash, busybox…): dentro NO
///   puede haber comillas simples, barras invertidas, «!» ni saltos de línea.
/// - Escribe su PID en stderr. El servidor crea un grupo de procesos nuevo para cada canal y este `sh`
///   suele ser su jefe (bash, zsh y dash le ceden su PID con `exec`; fish y tcsh le dan un grupo propio):
///   todo lo que lance el comando queda en ese grupo.
/// - El comando real llega por stdin: `dd` lee exactamente `len` bytes; lo que venga después en stdin
///   (contraseñas de `execStdin`) queda para el comando.
/// - `exec "$SHELL" -c` ejecuta el comando con el shell de login del usuario, con el mismo PID.
pub fn bootstrap(len: usize) -> String {
    format!(
        "sh -c 'echo __TERVIEW_PID__=$$ >&2; \
         c=$(dd bs=1 count={len} 2>/dev/null); \
         [ -n \"$c\" ] || {{ echo TerView: no se pudo leer el comando >&2; exit 127; }}; \
         exec \"${{SHELL:-/bin/sh}}\" -c \"$c\"'"
    )
}

/// Proceso remoto que hay que detener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteTarget {
    pub pid: u32,
}

impl RemoteTarget {
    /// Script para otro canal: envía `sig` al grupo `-PID` y, si no existe (el proceso no es jefe de
    /// grupo), solo al proceso. Un grupo con ese número solo puede ser el de este comando.
    /// Solo números y palabras fijas: sirve con cualquier shell de login. `kill -SEÑAL -GRUPO` (sin `--`)
    /// funciona en bash, dash y busybox.
    pub fn kill_command(&self, sig: &str) -> String {
        format!("sh -c 'kill -{sig} -{p} 2>/dev/null || kill -{sig} {p} 2>/dev/null; exit 0'", p = self.pid)
    }
}

/// Busca la línea de la marca en `stderr`, la quita y devuelve el PID.
/// None si todavía no está completa (o no es válida: en ese caso no se toca nada).
pub fn take_pid_mark(stderr: &mut Vec<u8>) -> Option<RemoteTarget> {
    let start = stderr.windows(PID_MARK.len()).position(|w| w == PID_MARK)?;
    let rest = &stderr[start + PID_MARK.len()..];
    let nl = rest.iter().position(|&b| b == b'\n')?;
    let text = std::str::from_utf8(&rest[..nl]).ok()?.trim_end_matches('\r');
    let pid = text.trim().parse::<u32>().ok().filter(|&n| n > 1)?;
    stderr.drain(start..start + PID_MARK.len() + nl + 1);
    Some(RemoteTarget { pid })
}

// ───────────── Ejecuciones en curso (para cancelar desde la interfaz) ─────────────

/// Ejecuciones en curso con identificador, para poder cancelarlas (`exec_cancel`).
#[derive(Default)]
pub struct ExecRegistry {
    running: Mutex<HashMap<String, CancellationToken>>,
}

/// Registro de una ejecución: al soltarlo se quita de la lista.
pub struct ExecTicket<'a> {
    registry: &'a ExecRegistry,
    id: String,
    pub token: CancellationToken,
}

impl Drop for ExecTicket<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.registry.running.lock() {
            map.remove(&self.id);
        }
    }
}

impl ExecRegistry {
    /// Anota una ejecución nueva. Error si el identificador está vacío o ya está en uso.
    pub fn register(&self, id: &str) -> AppResult<ExecTicket<'_>> {
        let id = id.trim();
        if id.is_empty() {
            return Err(AppError::Invalid("Identificador de ejecución vacío".into()));
        }
        let mut map = self.running.lock().map_err(|_| AppError::Invalid("Registro de ejecuciones bloqueado".into()))?;
        if map.contains_key(id) {
            return Err(AppError::Invalid("Ya hay una ejecución con ese identificador".into()));
        }
        let token = CancellationToken::new();
        map.insert(id.to_string(), token.clone());
        Ok(ExecTicket { registry: self, id: id.to_string(), token })
    }

    /// Pide cancelar. Devuelve false si ya terminó o no existe.
    pub fn cancel(&self, id: &str) -> bool {
        let Ok(map) = self.running.lock() else { return false };
        match map.get(id.trim()) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }
}

// ───────────── Ejecución ─────────────

/// Ejecuta `command` y espera a que termine o venza `timeout_secs` (1..=600).
pub async fn run(session: &SshSession, command: &str, timeout_secs: u32) -> AppResult<ExecResult> {
    run_inner(session, command, None, timeout_secs, None, true).await
}

/// Como [`run`], pero escribe `stdin` en la entrada estándar del comando y después envía EOF.
///
/// `stdin` puede contener contraseñas: NUNCA se registra ni se incluye en mensajes de error.
/// Se escribe a la vez que se lee la salida (un comando que no lee su entrada no bloquea la lectura).
pub async fn run_with_stdin(
    session: &SshSession,
    command: &str,
    stdin: &[u8],
    timeout_secs: u32,
) -> AppResult<ExecResult> {
    run_inner(session, command, Some(stdin), timeout_secs, None, true).await
}

/// Como [`run`] / [`run_with_stdin`], pero se puede cancelar con `cancel`: entonces se detiene el
/// proceso remoto y devuelve `AppError::Canceled`.
pub async fn run_cancellable(
    session: &SshSession,
    command: &str,
    stdin: Option<&[u8]>,
    timeout_secs: u32,
    cancel: &CancellationToken,
) -> AppResult<ExecResult> {
    run_inner(session, command, stdin, timeout_secs, Some(cancel), true).await
}

/// Lo que se va leyendo del canal.
#[derive(Default)]
struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
    exit_code: Option<u32>,
    signal: Option<String>,
    target: Option<RemoteTarget>,
    mark_search_done: bool,
}

enum Flow {
    Continue,
    Closed,
    Rejected,
}

impl Output {
    fn handle(&mut self, msg: Option<ChannelMsg>) -> Flow {
        let Some(msg) = msg else { return Flow::Closed };
        match msg {
            ChannelMsg::Data { data } => self.truncated |= push_limited(&mut self.stdout, &data),
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                self.truncated |= push_limited(&mut self.stderr, &data);
                if !self.mark_search_done {
                    if let Some(t) = take_pid_mark(&mut self.stderr) {
                        self.target = Some(t);
                        self.mark_search_done = true;
                    } else if self.stderr.len() > MARK_SEARCH_LIMIT {
                        self.mark_search_done = true;
                    }
                }
            }
            ChannelMsg::ExitStatus { exit_status } => self.exit_code = Some(exit_status),
            ChannelMsg::ExitSignal { signal_name, .. } => self.signal = Some(format!("{signal_name:?}")),
            ChannelMsg::Failure => return Flow::Rejected,
            ChannelMsg::Close => return Flow::Closed,
            _ => {}
        }
        Flow::Continue
    }
}

/// Lee del canal hasta que se cierre (true) o pase `wait` (false).
async fn read_until_closed(reader: &mut ChannelReadHalf, out: &mut Output, wait: Duration) -> bool {
    let until = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(until, reader.wait()).await {
            Err(_) => return false,
            Ok(msg) => match out.handle(msg) {
                Flow::Continue => {}
                Flow::Closed | Flow::Rejected => return true,
            },
        }
    }
}

/// Ejecuta `command` (sin arranque) en otro canal y espera a que termine. Errores ignorados.
async fn exec_aux(session: &SshSession, command: &str) {
    let job = async {
        let channel = session.open_channel().await.ok()?;
        channel.exec(true, command.as_bytes()).await.ok()?;
        let (mut reader, writer) = channel.split();
        while let Some(msg) = reader.wait().await {
            if matches!(msg, ChannelMsg::Close) {
                break;
            }
        }
        let _ = writer.close().await;
        Some(())
    };
    let _ = tokio::time::timeout(KILL_EXEC_TIMEOUT, job).await;
}

/// Detiene el comando remoto: TERM, espera, KILL. Ver el comentario del módulo.
/// `channel_signals` = false solo en pruebas (simula un servidor que ignora las señales del canal).
async fn stop_remote(
    session: &SshSession,
    reader: &mut ChannelReadHalf,
    writer: &ChannelWriteHalf<Msg>,
    out: &mut Output,
    channel_signals: bool,
) {
    for (sig, sig_name) in [(Sig::TERM, "TERM"), (Sig::KILL, "KILL")] {
        if channel_signals {
            let _ = writer.signal(sig).await;
            if read_until_closed(reader, out, GRACE).await {
                return;
            }
        }
        // Respaldo: el servidor ignoró la señal (o el proceso la ignora). Si aún no llegó la marca,
        // se le da un momento (el arranque la escribe enseguida).
        if out.target.is_none() && read_until_closed(reader, out, Duration::from_millis(300)).await {
            return;
        }
        if let Some(t) = out.target {
            exec_aux(session, &t.kill_command(sig_name)).await;
            if read_until_closed(reader, out, if sig_name == "KILL" { LAST_WAIT } else { GRACE }).await {
                return;
            }
        }
    }
}

pub(super) async fn run_inner(
    session: &SshSession,
    command: &str,
    stdin: Option<&[u8]>,
    timeout_secs: u32,
    cancel: Option<&CancellationToken>,
    channel_signals: bool,
) -> AppResult<ExecResult> {
    if command.trim().is_empty() {
        return Err(AppError::Invalid("El comando está vacío".into()));
    }
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return Err(AppError::Canceled);
    }
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(clamp_timeout(timeout_secs));

    let channel = session.open_channel().await?;
    channel.exec(true, bootstrap(command.len())).await?;
    let (mut reader, writer) = channel.split();

    // Por stdin va primero el comando real (lo lee el arranque) y después, si hay, la entrada del usuario
    // con EOF. Sin entrada no se envía EOF (como antes: el comando ve una entrada abierta sin datos).
    // Todo se escribe en paralelo con la lectura.
    let write_stdin = async {
        // Errores de escritura (p. ej. el comando ya terminó y cerró el canal) se ignoran:
        // el resultado real llega por el código de salida. Nunca se formatea `data`.
        if writer.data(command.as_bytes()).await.is_err() {
            return;
        }
        if let Some(data) = stdin
            && writer.data(data).await.is_ok()
        {
            let _ = writer.eof().await;
        }
    };
    tokio::pin!(write_stdin);
    let mut writing = true;

    let never = CancellationToken::new();
    let cancel_token = cancel.unwrap_or(&never);

    let mut out = Output::default();
    let mut timed_out = false;
    let mut canceled = false;

    loop {
        let msg = tokio::select! {
            () = &mut write_stdin, if writing => {
                writing = false;
                continue;
            }
            () = cancel_token.cancelled() => {
                canceled = true;
                break;
            }
            r = tokio::time::timeout_at(deadline, reader.wait()) => r,
        };
        match msg {
            Err(_) => {
                timed_out = true;
                break;
            }
            Ok(msg) => match out.handle(msg) {
                Flow::Continue => {}
                Flow::Closed => break,
                Flow::Rejected => {
                    let _ = writer.close().await;
                    return Err(AppError::Ssh("el servidor rechazó la ejecución del comando".into()));
                }
            },
        }
    }

    if timed_out || canceled {
        stop_remote(session, &mut reader, &writer, &mut out, channel_signals).await;
        let _ = writer.eof().await;
        let _ = writer.close().await;
    }
    if canceled {
        return Err(AppError::Canceled);
    }

    let mut stderr_text = String::from_utf8_lossy(&out.stderr).into_owned();
    if let (None, Some(sig)) = (out.exit_code, out.signal) {
        if !stderr_text.is_empty() && !stderr_text.ends_with('\n') {
            stderr_text.push('\n');
        }
        stderr_text.push_str(&format!("[terminado por la señal {sig}]\n"));
    }

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: stderr_text,
        exit_code: out.exit_code,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        truncated: out.truncated,
        timed_out,
    })
}
