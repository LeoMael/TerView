//! Terminales (shell con PTY) sobre un canal SSH. DUEÑO: agente Terminal.
//!
//! Datos del servidor → interfaz: por el `Channel` recibido en `term_open`,
//! enviando `InvokeResponseBody::Raw(bytes)` (llega como ArrayBuffer en JS).
//! Cuando la shell termina: evento global `EV_TERMINAL_EXIT` con `TerminalExit`.

pub mod shell;
pub mod tmux;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::ssh::SessionStore;
use crate::ssh::SshSession;
use crate::types::{TermOpened, TerminalExit, TmuxList, TmuxOpen, EV_TERMINAL_EXIT};

pub use shell::{spawn_terminal, ShellStart, TerminalHandle};
use tmux::{ProbeResult, TmuxProbe};

struct TermEntry {
    handle: TerminalHandle,
    #[allow(dead_code)]
    session_id: String,
}

/// Terminales abiertas: termId → shell.
#[derive(Default)]
pub struct TerminalStore {
    terms: Mutex<HashMap<String, TermEntry>>,
    /// tmux en cada sesión. «No instalado» se recuerda poco tiempo: si el usuario lo instala,
    /// una terminal abierta poco después ya lo usa.
    tmux: Mutex<HashMap<String, CachedProbe>>,
}

#[derive(Clone)]
enum CachedProbe {
    Found(TmuxProbe),
    Missing(std::time::Instant),
}

/// Cuánto se recuerda que una sesión no tiene tmux (evita comprobarlo en cada terminal nueva).
const MISSING_TTL: std::time::Duration = std::time::Duration::from_secs(20);

impl TerminalStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, TermEntry>> {
        self.terms.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, term_id: &str) -> AppResult<TerminalHandle> {
        self.lock()
            .get(term_id)
            .map(|e| e.handle.clone())
            .ok_or_else(|| AppError::NotFound(format!("terminal {term_id}")))
    }

    /// Registra la terminal salvo que ya haya terminado (evita entradas huérfanas).
    fn insert(&self, term_id: String, session_id: String, handle: TerminalHandle) {
        let mut map = self.lock();
        if !handle.is_finished() {
            map.insert(term_id, TermEntry { handle, session_id });
        }
    }

    fn remove(&self, term_id: &str) -> Option<TerminalHandle> {
        self.lock().remove(term_id).map(|e| e.handle)
    }

    /// Cierra todas las terminales de una sesión.
    pub fn close_session(&self, session_id: &str) {
        {
            let map = self.lock();
            for e in map.values().filter(|e| e.session_id == session_id) {
                e.handle.close();
            }
        }
        self.tmux_cache().remove(session_id);
    }

    fn tmux_cache(&self) -> std::sync::MutexGuard<'_, HashMap<String, CachedProbe>> {
        self.tmux.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Busca tmux en la sesión (con caché).
    async fn probe_tmux(&self, session_id: &str, session: &SshSession) -> AppResult<ProbeResult> {
        match self.tmux_cache().get(session_id).cloned() {
            Some(CachedProbe::Found(p)) => return Ok(ProbeResult::Found(p)),
            Some(CachedProbe::Missing(at)) if at.elapsed() < MISSING_TTL => return Ok(ProbeResult::NotInstalled),
            _ => {}
        }
        let r = tmux::probe(session).await?;
        let cached = match &r {
            ProbeResult::Found(p) => CachedProbe::Found(p.clone()),
            ProbeResult::NotInstalled => CachedProbe::Missing(std::time::Instant::now()),
        };
        self.tmux_cache().insert(session_id.to_string(), cached);
        Ok(r)
    }
}

/// Decide cómo arrancar la terminal según la petición de tmux y lo que hay en el servidor.
async fn choose_start(
    terms: &TerminalStore,
    session_id: &str,
    session: &SshSession,
    req: Option<TmuxOpen>,
    rows: u32,
    opened: &mut TermOpened,
) -> AppResult<ShellStart> {
    let Some(req) = req else { return Ok(ShellStart::Shell) };
    if !tmux::valid_name(&req.name) {
        return Err(AppError::Invalid(format!("nombre de sesión tmux no válido: {}", req.name)));
    }
    match terms.probe_tmux(session_id, session).await {
        Ok(ProbeResult::Found(p)) if p.supported() => {
            let cmd = tmux::attach_command(&p, &req.name, rows, req.replay)?;
            opened.tmux = Some(req.name);
            Ok(ShellStart::Exec(cmd))
        }
        Ok(ProbeResult::Found(p)) => {
            opened.tmux_problem = Some(format!(
                "la versión de tmux del servidor ({}) es muy antigua: hace falta la 1.8 o una más nueva",
                p.version_text
            ));
            Ok(ShellStart::Shell)
        }
        Ok(ProbeResult::NotInstalled) => {
            opened.tmux_missing = true;
            opened.tmux_problem = Some("tmux no está instalado en el servidor".into());
            Ok(ShellStart::Shell)
        }
        Err(e) => {
            log::info!("terminal: no se pudo comprobar tmux: {e}");
            opened.tmux_problem = Some(format!("no se pudo comprobar si hay tmux: {e}"));
            Ok(ShellStart::Shell)
        }
    }
}

/// Abre una shell interactiva.
/// Con `tmux`, la abre dentro de esa sesión tmux (o se engancha si ya existe); si el servidor no
/// tiene tmux se abre una shell normal y `TermOpened` lo indica.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // firma del comando (la interfaz la llama así)
pub async fn term_open(
    app: AppHandle,
    sessions: State<'_, SessionStore>,
    terms: State<'_, TerminalStore>,
    session_id: String,
    cols: u32,
    rows: u32,
    tmux: Option<TmuxOpen>,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<TermOpened> {
    let session = sessions.get(&session_id).await?;
    let term_id = uuid::Uuid::new_v4().to_string();
    let mut opened = TermOpened {
        term_id: term_id.clone(),
        tmux: None,
        tmux_missing: false,
        tmux_problem: None,
    };
    let start = choose_start(&terms, &session_id, &session, tmux, rows, &mut opened).await?;

    let exit_id = term_id.clone();
    let handle = spawn_terminal(
        session,
        start,
        cols,
        rows,
        move |bytes| {
            if let Err(e) = on_data.send(InvokeResponseBody::Raw(bytes)) {
                log::debug!("terminal: no se pudo enviar a la interfaz: {e}");
            }
        },
        move |code| {
            app.state::<TerminalStore>().remove(&exit_id);
            let _ = app.emit(
                EV_TERMINAL_EXIT,
                TerminalExit {
                    term_id: exit_id,
                    code,
                },
            );
        },
    )
    .await?;

    terms.insert(term_id, session_id, handle);
    Ok(opened)
}

/// Sesiones tmux de SSHorus que siguen vivas en el servidor.
#[tauri::command]
pub async fn term_tmux_list(sessions: State<'_, SessionStore>, session_id: String) -> AppResult<TmuxList> {
    let session = sessions.get(&session_id).await?;
    tmux::list(session).await
}

/// Termina sesiones tmux de SSHorus (cerrar la terminal a propósito o limpiar las que quedaron).
#[tauri::command]
pub async fn term_tmux_kill(
    sessions: State<'_, SessionStore>,
    session_id: String,
    names: Vec<String>,
) -> AppResult<()> {
    let session = sessions.get(&session_id).await?;
    tmux::kill(session, &names).await
}

/// Envía lo que el usuario teclea (texto UTF-8 tal cual lo da xterm.js `onData`).
#[tauri::command]
pub async fn term_write(terms: State<'_, TerminalStore>, term_id: String, data: String) -> AppResult<()> {
    terms.get(&term_id)?.write(data.into_bytes())
}

#[tauri::command]
pub async fn term_resize(
    terms: State<'_, TerminalStore>,
    term_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    terms.get(&term_id)?.resize(cols, rows)
}

#[tauri::command]
pub async fn term_close(terms: State<'_, TerminalStore>, term_id: String) -> AppResult<()> {
    match terms.remove(&term_id) {
        Some(handle) => {
            handle.close();
            Ok(())
        }
        None => Err(AppError::NotFound(format!("terminal {term_id}"))),
    }
}
