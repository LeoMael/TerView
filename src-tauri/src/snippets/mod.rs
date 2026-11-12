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

/// Como `exec_capture`, pero escribe `stdin` en la entrada estándar del comando y luego envía EOF.
/// Pensado para pasar contraseñas (sudo -S, chpasswd) sin que aparezcan en la línea de comandos.
/// El contenido de `stdin` nunca se registra ni aparece en errores; se borra de memoria al terminar.
#[tauri::command]
pub async fn exec_capture_stdin(
    sessions: State<'_, SessionStore>,
    session_id: String,
    command: String,
    stdin: String,
    timeout_secs: u32,
) -> AppResult<ExecResult> {
    let mut stdin = stdin.into_bytes();
    let result = match sessions.get(&session_id).await {
        Ok(session) => exec::run_with_stdin(&session, &command, &stdin, timeout_secs).await,
        Err(e) => Err(e),
    };
    wipe(&mut stdin);
    result
}

/// Sobrescribe el búfer con ceros (lo mejor que se puede hacer sin dependencias extra).
fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        // SAFETY: `b` es una referencia válida y alineada a un u8 del propio búfer.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}
