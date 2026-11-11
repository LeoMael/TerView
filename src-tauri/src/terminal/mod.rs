//! Terminales (shell con PTY) sobre un canal SSH. DUEÑO: agente Terminal.
//!
//! Datos del servidor → interfaz: por el `Channel` recibido en `term_open`,
//! enviando `InvokeResponseBody::Raw(bytes)` (llega como ArrayBuffer en JS).
//! Cuando la shell termina: evento global `EV_TERMINAL_EXIT` con `TerminalExit`.

pub mod shell;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::ssh::SessionStore;
use crate::types::{TerminalExit, EV_TERMINAL_EXIT};

pub use shell::{spawn_shell, TerminalHandle};

struct TermEntry {
    handle: TerminalHandle,
    #[allow(dead_code)]
    session_id: String,
}

/// Terminales abiertas: termId → shell.
#[derive(Default)]
pub struct TerminalStore {
    terms: Mutex<HashMap<String, TermEntry>>,
}

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
        let map = self.lock();
        for e in map.values().filter(|e| e.session_id == session_id) {
            e.handle.close();
        }
    }
}

/// Abre una shell interactiva. Devuelve `termId`.
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    sessions: State<'_, SessionStore>,
    terms: State<'_, TerminalStore>,
    session_id: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<String> {
    let session = sessions.get(&session_id).await?;
    let term_id = uuid::Uuid::new_v4().to_string();

    let exit_id = term_id.clone();
    let handle = spawn_shell(
        session,
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

    terms.insert(term_id.clone(), session_id, handle);
    Ok(term_id)
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
