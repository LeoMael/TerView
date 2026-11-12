//! Biblioteca de comandos: "Mis comandos" guardados (~/.config/terview/commands.json)
//! y ejecución aparte con captura de salida (canal exec). DUEÑO: agente Comandos.

pub(crate) mod exec;
mod store;
#[cfg(test)]
mod tests;

use tauri::State;

use crate::error::AppResult;
use crate::ssh::SessionStore;
use crate::types::{ExecResult, Snippet};

pub use exec::ExecRegistry;
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
/// Al vencer el tiempo se detiene también el proceso remoto.
/// `exec_id` (opcional, lo elige la interfaz) permite cancelarlo con `exec_cancel`; entonces
/// devuelve el error `Canceled`.
#[tauri::command]
pub async fn exec_capture(
    sessions: State<'_, SessionStore>,
    registry: State<'_, ExecRegistry>,
    session_id: String,
    command: String,
    timeout_secs: u32,
    exec_id: Option<String>,
) -> AppResult<ExecResult> {
    run_registered(&sessions, &registry, &session_id, &command, None, timeout_secs, exec_id.as_deref()).await
}

/// Como `exec_capture`, pero escribe `stdin` en la entrada estándar del comando y luego envía EOF.
/// Pensado para pasar contraseñas (sudo -S, chpasswd) sin que aparezcan en la línea de comandos.
/// El contenido de `stdin` nunca se registra ni aparece en errores; se borra de memoria al terminar.
#[tauri::command]
pub async fn exec_capture_stdin(
    sessions: State<'_, SessionStore>,
    registry: State<'_, ExecRegistry>,
    session_id: String,
    command: String,
    stdin: String,
    timeout_secs: u32,
    exec_id: Option<String>,
) -> AppResult<ExecResult> {
    let mut stdin = stdin.into_bytes();
    let result =
        run_registered(&sessions, &registry, &session_id, &command, Some(&stdin), timeout_secs, exec_id.as_deref())
            .await;
    wipe(&mut stdin);
    result
}

/// Cancela una ejecución en curso (`exec_capture` / `exec_capture_stdin` con `exec_id`):
/// detiene el proceso remoto. Devuelve false si ya había terminado o no existe.
#[tauri::command]
pub async fn exec_cancel(registry: State<'_, ExecRegistry>, exec_id: String) -> AppResult<bool> {
    Ok(registry.cancel(&exec_id))
}

async fn run_registered(
    sessions: &SessionStore,
    registry: &ExecRegistry,
    session_id: &str,
    command: &str,
    stdin: Option<&[u8]>,
    timeout_secs: u32,
    exec_id: Option<&str>,
) -> AppResult<ExecResult> {
    let ticket = exec_id.map(|id| registry.register(id)).transpose()?;
    let session = sessions.get(session_id).await?;
    match &ticket {
        Some(t) => exec::run_cancellable(&session, command, stdin, timeout_secs, &t.token).await,
        None => match stdin {
            Some(data) => exec::run_with_stdin(&session, command, data, timeout_secs).await,
            None => exec::run(&session, command, timeout_secs).await,
        },
    }
}

/// Sobrescribe el búfer con ceros (lo mejor que se puede hacer sin dependencias extra).
fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        // SAFETY: `b` es una referencia válida y alineada a un u8 del propio búfer.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}
