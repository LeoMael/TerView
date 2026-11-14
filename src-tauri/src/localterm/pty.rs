//! PTY del propio equipo con `portable-pty` (Linux y macOS con su PTY; Windows con ConPTY).
//!
//! Tres hilos por terminal: uno lee la salida, otro escribe lo que teclea el usuario (así una
//! escritura grande nunca bloquea al motor) y otro espera a que el proceso termine.
//! Al cerrar se termina el proceso **y sus hijos**: en Linux y macOS, todo su grupo de procesos
//! (y en Linux además todo lo que siga en su sesión); en Windows, el árbol con `taskkill /T`.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{AppError, AppResult};

/// Tras pedir que termine (SIGHUP), cuánto se espera antes de forzarlo.
const KILL_GRACE: Duration = Duration::from_millis(1500);
/// Tras salir el proceso, cuánto se espera a que llegue lo último de su salida.
const DRAIN_WAIT: Duration = Duration::from_millis(400);

enum WriteCmd {
    Data(Vec<u8>),
    Stop,
}

/// Mando de una terminal local en marcha. Clonable.
#[derive(Clone)]
pub struct LocalPty {
    inner: Arc<Inner>,
}

struct Inner {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    tx: mpsc::Sender<WriteCmd>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    finished: Arc<AtomicBool>,
    closing: AtomicBool,
}

fn pty_err(e: impl std::fmt::Display) -> AppError {
    AppError::Io(format!("terminal local: {e}"))
}

/// Arranca `cmd` dentro de un PTY nuevo. `on_data` recibe la salida; `on_exit` se llama una vez,
/// al terminar, con el código de salida (None si lo terminó una señal).
pub fn spawn(
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
    on_data: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
) -> AppResult<LocalPty> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(pty_err)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        AppError::Io(format!("no se pudo iniciar el programa: {e}"))
    })?;
    // El extremo del hijo se cierra aquí: si no, la lectura nunca vería el final.
    drop(pair.slave);

    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
    let mut writer = pair.master.take_writer().map_err(pty_err)?;
    let finished = Arc::new(AtomicBool::new(false));

    // Escritura: un hilo propio con cola.
    let (tx, rx) = mpsc::channel::<WriteCmd>();
    std::thread::Builder::new()
        .name("localterm-write".into())
        .spawn(move || {
            while let Ok(WriteCmd::Data(d)) = rx.recv() {
                if writer.write_all(&d).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        })
        .map_err(pty_err)?;

    // Lectura: hasta que el PTY se cierre.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("localterm-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => on_data(buf[..n].to_vec()),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = done_tx.send(());
        })
        .map_err(pty_err)?;

    let inner = Arc::new(Inner {
        master: Mutex::new(Some(pair.master)),
        tx,
        killer: Mutex::new(killer),
        pid,
        finished: finished.clone(),
        closing: AtomicBool::new(false),
    });

    // Espera del proceso.
    let weak = Arc::downgrade(&inner);
    std::thread::Builder::new()
        .name("localterm-wait".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(st) if st.signal().is_some() => None,
                Ok(st) => Some(st.exit_code()),
                Err(_) => None,
            };
            // Lo último que escribió el programa (si nadie más mantiene el PTY abierto).
            let _ = done_rx.recv_timeout(DRAIN_WAIT);
            finished.store(true, Ordering::SeqCst);
            if let Some(inner) = weak.upgrade() {
                let _ = inner.tx.send(WriteCmd::Stop);
                // Cerrar el PTY: en Windows desbloquea la lectura; en Unix avisa (SIGHUP) a lo que quede.
                inner.master.lock().unwrap_or_else(|p| p.into_inner()).take();
            }
            on_exit(code);
        })
        .map_err(pty_err)?;

    Ok(LocalPty { inner })
}

impl LocalPty {
    pub fn write(&self, data: Vec<u8>) -> AppResult<()> {
        if self.is_finished() {
            return Err(AppError::NotFound("la terminal ya terminó".into()));
        }
        self.inner
            .tx
            .send(WriteCmd::Data(data))
            .map_err(|_| AppError::NotFound("la terminal ya terminó".into()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        let g = self.inner.master.lock().unwrap_or_else(|p| p.into_inner());
        match g.as_ref() {
            Some(m) => m
                .resize(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
                .map_err(pty_err),
            None => Err(AppError::NotFound("la terminal ya terminó".into())),
        }
    }

    pub fn is_finished(&self) -> bool {
        self.inner.finished.load(Ordering::SeqCst)
    }

    /// Termina el programa y todo lo que lanzó. Pide el cierre al momento (SIGHUP / taskkill) y,
    /// en otro hilo, fuerza lo que siga vivo poco después.
    pub fn close(&self) {
        if self.inner.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.inner.tx.send(WriteCmd::Stop);
        if self.inner.finished.load(Ordering::SeqCst) {
            return;
        }
        kill_tree(&self.inner, false);
        // Cerrar el PTY también avisa a lo que quede en la sesión.
        self.inner.master.lock().unwrap_or_else(|p| p.into_inner()).take();
        let inner = self.inner.clone();
        let _ = std::thread::Builder::new().name("localterm-close".into()).spawn(move || {
            let step = Duration::from_millis(50);
            let mut waited = Duration::ZERO;
            while waited < KILL_GRACE && !inner.finished.load(Ordering::SeqCst) {
                std::thread::sleep(step);
                waited += step;
            }
            // Lo que no hizo caso (o los hijos que siguen vivos) se termina a la fuerza.
            kill_tree(&inner, true);
        });
    }
}

#[cfg(unix)]
fn kill_tree(inner: &Inner, force: bool) {
    let Some(pid) = inner.pid.and_then(|p| i32::try_from(p).ok()) else {
        let _ = inner.killer.lock().unwrap_or_else(|p| p.into_inner()).kill();
        return;
    };
    let sig = if force { libc::SIGKILL } else { libc::SIGHUP };
    // portable-pty crea el proceso como líder de su sesión y de su grupo (pgid = sid = pid).
    let mut targets = session_members(pid);
    targets.retain(|&p| p != pid);
    // Si el líder ya terminó, su pid podría volver a usarse: entonces solo se toca a los de su sesión.
    let leader_alive = !inner.finished.load(Ordering::SeqCst);
    // SAFETY: solo se envían señales a procesos; los pid salen del propio hijo o de su sesión.
    unsafe {
        if leader_alive {
            libc::killpg(pid, sig);
            if force {
                libc::kill(pid, sig);
            }
        }
        for p in targets {
            libc::kill(p, sig);
        }
    }
}

/// Procesos que siguen en la sesión `sid` (Linux: se leen de /proc). En otros sistemas, ninguno:
/// basta con el grupo de procesos y el SIGHUP que manda el sistema al cerrar el PTY.
#[cfg(unix)]
fn session_members(sid: i32) -> Vec<i32> {
    #[cfg(target_os = "linux")]
    {
        let mut out = Vec::new();
        let Ok(dir) = std::fs::read_dir("/proc") else { return out };
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
            if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                && super::aicli::stat_session(&stat) == Some(sid)
            {
                out.push(pid);
            }
        }
        out
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = sid;
        Vec::new()
    }
}

#[cfg(windows)]
fn kill_tree(inner: &Inner, force: bool) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if let Some(pid) = inner.pid {
        // /T: también los procesos hijos. Sin /F la primera vez (cierre amable).
        let mut c = std::process::Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T"]);
        if force {
            c.arg("/F");
        }
        let _ = c
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    if force {
        let _ = inner.killer.lock().unwrap_or_else(|p| p.into_inner()).kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::RecvTimeoutError;

    fn sh(script: &str) -> CommandBuilder {
        let mut c = CommandBuilder::new("/bin/sh");
        c.args(["-c", script]);
        c
    }

    #[test]
    fn salida_y_codigo() {
        let (dtx, drx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Option<u32>>();
        let on_data = move |b| {
            let _ = dtx.send(b);
        };
        let _t = spawn(sh("printf hola; exit 3"), 80, 24, on_data, move |c| {
            let _ = etx.send(c);
        })
        .unwrap();
        assert_eq!(erx.recv_timeout(Duration::from_secs(10)).unwrap(), Some(3));
        let out: Vec<u8> = drx.try_iter().flatten().collect();
        assert!(String::from_utf8_lossy(&out).contains("hola"));
    }

    #[test]
    fn escribir_llega_al_programa() {
        let (dtx, drx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Option<u32>>();
        let on_data = move |b| {
            let _ = dtx.send(b);
        };
        let t = spawn(sh("read x; printf \"<%s>\" \"$x\""), 80, 24, on_data, move |c| {
            let _ = etx.send(c);
        })
        .unwrap();
        t.write(b"sshorus\r".to_vec()).unwrap();
        assert_eq!(erx.recv_timeout(Duration::from_secs(10)).unwrap(), Some(0));
        let out: Vec<u8> = drx.try_iter().flatten().collect();
        assert!(String::from_utf8_lossy(&out).contains("<sshorus>"));
    }

    #[test]
    fn cerrar_termina_tambien_los_hijos() {
        let dir = std::env::temp_dir().join(format!("sshorus-pty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("hijo.pid");
        // Un hijo en segundo plano que ignora SIGHUP (tiene que caer igual) y otro en primer plano.
        let script = format!("trap '' HUP; sleep 60 & echo $! > '{}'; sleep 60", pidfile.display());
        let (etx, erx) = mpsc::channel::<Option<u32>>();
        let t = spawn(sh(&script), 80, 24, |_| {}, move |c| {
            let _ = etx.send(c);
        })
        .unwrap();
        let mut child_pid = None;
        for _ in 0..100 {
            if let Some(p) = std::fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
                child_pid = Some(p);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let child_pid = child_pid.expect("el script no arrancó");
        t.close();
        match erx.recv_timeout(Duration::from_secs(10)) {
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => panic!("el proceso no terminó al cerrar"),
            Err(e) => panic!("{e}"),
        }
        // El hijo en segundo plano también termina (como mucho tras la espera de cortesía).
        let mut alive = true;
        for _ in 0..80 {
            // SAFETY: señal 0 = solo comprobar si existe.
            alive = unsafe { libc::kill(child_pid, 0) } == 0;
            if !alive {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!alive, "el proceso hijo sigue vivo tras cerrar la terminal");
    }
}
