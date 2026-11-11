//! Biblioteca de comandos: "Mis comandos" guardados (~/.config/terview/commands.json)
//! y ejecución aparte con captura de salida (canal exec). DUEÑO: agente Comandos.

mod exec;
mod store;
#[cfg(test)]
mod tests;

use tauri::State;

use crate::error::AppResult;
use crate::ssh::SessionStore;
use crate::types::{ExecResult, Snippet};

pub use store::SnippetStore;

#[tauri::command]
pub async fn snippets_load(store: State<'_, SnippetStore>) -> AppResult<Vec<Snippet>> {
    Ok(store.list())
}

/// Crea o actualiza (id "" = nuevo; se asigna UUID). Devuelve el guardado.
#[tauri::command]
pub async fn snippets_save(store: State<'_, SnippetStore>, snippet: Snippet) -> AppResult<Snippet> {
    store.save(snippet)
}

#[tauri::command]
pub async fn snippets_delete(store: State<'_, SnippetStore>, id: String) -> AppResult<()> {
    store.delete(&id)
}

/// Ejecuta `command` en un canal exec aparte (sin PTY) y captura stdout/stderr/código.
/// Límite de tiempo `timeout_secs` (1..=600) y de salida (2 MB por flujo → `truncated`).
#[tauri::command]
pub async fn exec_capture(
    sessions: State<'_, SessionStore>,
    session_id: String,
    command: String,
    timeout_secs: u32,
) -> AppResult<ExecResult> {
    let session = sessions.get(&session_id).await?;
    exec::run(&session, &command, timeout_secs).await
}
