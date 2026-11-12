//! Transferencias masivas (cola + trabajadores en paralelo). DUEÑO: agente Transferencias.
//!
//! Progreso → interfaz: evento global `EV_TRANSFER_UPDATE` con `Vec<TransferJob>` (solo los
//! que cambiaron, como mucho cada ~200 ms). Al limpiar: `EV_TRANSFER_REMOVED` con ids.
//!
//! Estructura:
//! - `engine`: cola, planificador, reintentos, pausa/cancelación y emisor (sin Tauri).
//! - `copy`:   copia de un archivo con peticiones SFTP encadenadas.
//! - `pool`:   reserva de canales SFTP por sesión.
//! - `paths`:  rutas y recorrido de carpetas locales.
//! - `policy`: política de conflictos (sobrescribir / omitir / más nuevo / preguntar).
//!
//! Política "preguntar": el trabajo que choca suelta su turno y queda en cola con la nota
//! `ASK_MSG`; se emite `EV_TRANSFER_CONFLICT` (`ConflictQuestion`) y la interfaz responde con
//! `transfer_resolve_conflict`. Las preguntas que dejan de estar pendientes (respondidas en
//! bloque, canceladas o pausadas) se avisan con `EV_TRANSFER_CONFLICT_DONE` (ids de trabajo).

mod copy;
mod engine;
mod paths;
mod policy;
mod pool;
#[cfg(test)]
mod tests;

use std::sync::{Arc, OnceLock};

use futures::future::BoxFuture;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

pub use engine::{Engine, TransferEnv};
pub use policy::{Conflict, ConflictQuestion};

/// Payload: `ConflictQuestion`. El destino existe y la política es "preguntar".
pub const EV_TRANSFER_CONFLICT: &str = "transfer://conflict";
/// Payload: `Vec<String>` con ids de trabajos cuya pregunta ya no está pendiente.
pub const EV_TRANSFER_CONFLICT_DONE: &str = "transfer://conflict-done";

use crate::error::{AppError, AppResult};
use crate::ssh::{SessionStore, SshSession};
use crate::storage::SettingsStore;
use crate::types::{SessionClosed, TransferJob, EV_SESSION_CLOSED, EV_TRANSFER_REMOVED, EV_TRANSFER_UPDATE};

/// Puente entre el motor y Tauri.
struct TauriEnv {
    app: AppHandle,
}

impl TransferEnv for TauriEnv {
    fn session<'a>(&'a self, id: &'a str) -> BoxFuture<'a, AppResult<Arc<SshSession>>> {
        Box::pin(async move {
            match self.app.try_state::<SessionStore>() {
                Some(store) => store.get(id).await,
                None => Err(AppError::SessionNotFound(id.to_string())),
            }
        })
    }

    fn concurrency(&self) -> usize {
        self.app
            .try_state::<SettingsStore>()
            .map(|s| s.get().transfer_concurrency as usize)
            .unwrap_or(4)
    }

    fn conflict_policy(&self) -> Conflict {
        self.app
            .try_state::<SettingsStore>()
            .map(|s| Conflict::parse(&s.get().transfer_conflict))
            .unwrap_or_default()
    }

    fn auto_reconnect(&self) -> bool {
        self.app
            .try_state::<SettingsStore>()
            .map(|s| s.get().auto_reconnect)
            .unwrap_or(true)
    }

    fn emit_update(&self, jobs: Vec<TransferJob>) {
        if let Err(e) = self.app.emit(EV_TRANSFER_UPDATE, jobs) {
            log::warn!("no se pudo emitir progreso: {e}");
        }
    }

    fn emit_removed(&self, ids: Vec<String>) {
        if let Err(e) = self.app.emit(EV_TRANSFER_REMOVED, ids) {
            log::warn!("no se pudo emitir limpieza: {e}");
        }
    }

    fn emit_conflict(&self, question: ConflictQuestion) {
        if let Err(e) = self.app.emit(EV_TRANSFER_CONFLICT, question) {
            log::warn!("no se pudo emitir conflicto: {e}");
        }
    }

    fn emit_conflict_done(&self, job_ids: Vec<String>) {
        if let Err(e) = self.app.emit(EV_TRANSFER_CONFLICT_DONE, job_ids) {
            log::warn!("no se pudo emitir conflicto resuelto: {e}");
        }
    }
}

/// Estado global de transferencias. El motor se crea con el primer comando (necesita el AppHandle).
#[derive(Default)]
pub struct TransferManager {
    engine: OnceLock<Arc<Engine>>,
}

impl TransferManager {
    pub(crate) fn engine(&self, app: &AppHandle) -> Arc<Engine> {
        self.engine
            .get_or_init(|| {
                let engine = Engine::new(Arc::new(TauriEnv { app: app.clone() }));
                // Pérdida definitiva (reconexión agotada/desactivada o desconexión): lo que
                // esperaba la reconexión pasa a error.
                let weak = Arc::downgrade(&engine);
                app.listen_any(EV_SESSION_CLOSED, move |ev| {
                    let Ok(p) = serde_json::from_str::<SessionClosed>(ev.payload()) else { return };
                    if let Some(engine) = weak.upgrade() {
                        tauri::async_runtime::spawn(async move { engine.session_closed(&p.session_id) });
                    }
                });
                engine
            })
            .clone()
    }

    /// La sesión se reconectó (mismo id, conexión nueva): los trabajos que esperaban siguen
    /// y los que fallaron por la caída se reanudan desde el último byte confirmado.
    /// Lo llama el módulo SSH después de reemplazar la conexión en `SessionStore`.
    pub fn resume_session(&self, session_id: &str) {
        if let Some(engine) = self.engine.get() {
            let engine = engine.clone();
            let id = session_id.to_string();
            tauri::async_runtime::spawn(async move { engine.resume_session(&id) });
        }
    }

    /// Trabajos de la cola (vacío si aún no se usó).
    pub fn list(&self) -> Vec<TransferJob> {
        self.engine.get().map(|e| e.list()).unwrap_or_default()
    }

    /// Suelta los canales SFTP de una sesión que se cerró (si el motor ya existe).
    pub fn forget_session(&self, session_id: &str) {
        if let Some(engine) = self.engine.get() {
            engine.forget_session(session_id);
        }
    }
}

/// Sube archivos y/o carpetas locales (recursivo) a `remote_dir`. Devuelve `batchId`.
#[tauri::command]
pub async fn transfer_upload(
    app: AppHandle,
    sessions: State<'_, SessionStore>,
    transfers: State<'_, TransferManager>,
    _settings: State<'_, SettingsStore>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> AppResult<String> {
    if local_paths.is_empty() {
        return Err(AppError::Invalid("No hay nada que subir".into()));
    }
    sessions.get(&session_id).await?;
    Ok(transfers.engine(&app).upload(session_id, local_paths, remote_dir))
}

/// Descarga archivos y/o carpetas remotas (recursivo) a `local_dir`. Devuelve `batchId`.
#[tauri::command]
pub async fn transfer_download(
    app: AppHandle,
    sessions: State<'_, SessionStore>,
    transfers: State<'_, TransferManager>,
    _settings: State<'_, SettingsStore>,
    session_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
) -> AppResult<String> {
    if remote_paths.is_empty() {
        return Err(AppError::Invalid("No hay nada que descargar".into()));
    }
    sessions.get(&session_id).await?;
    Ok(transfers.engine(&app).download(session_id, remote_paths, local_dir))
}

/// ¿El lote terminó del todo? (recorrido de carpetas acabado y nada en marcha ni en cola).
/// A diferencia de los eventos de progreso, sabe si el recorrido aún puede añadir trabajos.
#[tauri::command]
pub async fn transfer_batch_finished(transfers: State<'_, TransferManager>, batch_id: String) -> AppResult<bool> {
    Ok(transfers.engine.get().is_none_or(|e| e.batch_finished(&batch_id)))
}

#[tauri::command]
pub async fn transfer_list(transfers: State<'_, TransferManager>) -> AppResult<Vec<TransferJob>> {
    Ok(transfers.engine.get().map(|e| e.list()).unwrap_or_default())
}

/// `ids` puede contener ids de trabajos o de lotes (batchId).
#[tauri::command]
pub async fn transfer_pause(app: AppHandle, transfers: State<'_, TransferManager>, ids: Vec<String>) -> AppResult<()> {
    transfers.engine(&app).pause(&ids);
    Ok(())
}

#[tauri::command]
pub async fn transfer_resume(app: AppHandle, transfers: State<'_, TransferManager>, ids: Vec<String>) -> AppResult<()> {
    transfers.engine(&app).resume(&ids);
    Ok(())
}

#[tauri::command]
pub async fn transfer_cancel(app: AppHandle, transfers: State<'_, TransferManager>, ids: Vec<String>) -> AppResult<()> {
    transfers.engine(&app).cancel(&ids);
    Ok(())
}

/// Reintenta trabajos con error (reanuda desde lo ya transferido).
#[tauri::command]
pub async fn transfer_retry(app: AppHandle, transfers: State<'_, TransferManager>, ids: Vec<String>) -> AppResult<()> {
    transfers.engine(&app).retry(&ids);
    Ok(())
}

/// Quita de la lista los trabajos terminados (done / canceled / error).
#[tauri::command]
pub async fn transfer_clear_finished(app: AppHandle, transfers: State<'_, TransferManager>) -> AppResult<()> {
    transfers.engine(&app).clear_finished();
    Ok(())
}

/// Preguntas de conflicto pendientes (para la interfaz al abrirse o recargar).
#[tauri::command]
pub async fn transfer_conflicts(transfers: State<'_, TransferManager>) -> AppResult<Vec<ConflictQuestion>> {
    Ok(transfers.engine.get().map(|e| e.conflicts()).unwrap_or_default())
}

/// Responde una pregunta de conflicto. `answer`: "overwrite" | "skip" | "rename" | "newer".
/// Con `apply_to_all` vale para todos los conflictos de ese lote (pendientes y futuros).
#[tauri::command]
pub async fn transfer_resolve_conflict(
    app: AppHandle,
    transfers: State<'_, TransferManager>,
    job_id: String,
    answer: String,
    apply_to_all: bool,
) -> AppResult<()> {
    let Some(choice) = Conflict::parse_answer(&answer) else {
        return Err(AppError::Invalid(format!("Respuesta no válida: {answer}")));
    };
    transfers.engine(&app).resolve(&job_id, choice, apply_to_all);
    Ok(())
}
