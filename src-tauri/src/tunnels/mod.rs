//! Túneles (port forwarding) por servidor: local (-L), remoto (-R) y SOCKS5 (-D).
//! DUEÑO: agente Túneles.
//!
//! - Definiciones guardadas por servidor en `<config_dir>/terview/tunnels.json` (`store`).
//! - En marcha por sesión (`manager`), con estado y contadores → evento `tunnel://status`.
//! - Los canales `forwarded-tcpip` del servidor llegan por `ssh::handler` → `remote`.

mod io;
mod manager;
mod remote;
mod socks;
mod store;
pub mod types;

#[cfg(test)]
mod tests;

use tauri::{AppHandle, State};

use crate::error::AppResult;

use manager::Sessions;
pub use manager::TunnelManager;
pub use remote::on_forwarded_tcpip;
use types::{TunnelDef, TunnelStatus};

/// Túneles guardados de un servidor.
#[tauri::command]
pub async fn tunnels_list(
    manager: State<'_, TunnelManager>,
    profile_id: String,
) -> AppResult<Vec<TunnelDef>> {
    Ok(manager.defs.list(&profile_id))
}

/// Crea (id "") o actualiza un túnel. Si estaba activo y cambió su conexión, se reinicia.
#[tauri::command]
pub async fn tunnels_save(
    app: AppHandle,
    manager: State<'_, TunnelManager>,
    tunnel: TunnelDef,
) -> AppResult<TunnelDef> {
    let saved = manager.defs.save(tunnel)?;
    manager.restart_changed(&Sessions::App(app), &saved).await;
    Ok(saved)
}

/// Borra un túnel guardado (y lo para donde esté activo).
#[tauri::command]
pub async fn tunnels_delete(
    app: AppHandle,
    manager: State<'_, TunnelManager>,
    id: String,
) -> AppResult<()> {
    manager.stop_everywhere(&Sessions::App(app), &id).await;
    manager.defs.delete(&id)
}

/// Activa un túnel en una sesión conectada. Errores claros (puerto ocupado, servidor que no permite…).
#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    manager: State<'_, TunnelManager>,
    session_id: String,
    tunnel_id: String,
) -> AppResult<TunnelStatus> {
    manager
        .start(&Sessions::App(app), &session_id, &tunnel_id)
        .await
}

#[tauri::command]
pub async fn tunnel_stop(
    app: AppHandle,
    manager: State<'_, TunnelManager>,
    session_id: String,
    tunnel_id: String,
) -> AppResult<()> {
    manager
        .stop(&Sessions::App(app), &session_id, &tunnel_id)
        .await;
    Ok(())
}

/// Estado de los túneles en marcha (o con error) de una sesión.
#[tauri::command]
pub async fn tunnels_status(
    manager: State<'_, TunnelManager>,
    session_id: String,
) -> AppResult<Vec<TunnelStatus>> {
    Ok(manager.statuses(&session_id))
}
