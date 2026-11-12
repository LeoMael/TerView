//! Tipos de los túneles (espejo de `src/api/tunnels.ts`).

use serde::{Deserialize, Serialize};

/// Payload: `TunnelStatus`. Cambios de estado al momento; contadores como mucho una vez por segundo.
pub const EV_TUNNEL_STATUS: &str = "tunnel://status";

/// Tipo de túnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TunnelKind {
    /// `-L`: un puerto de tu PC lleva a `destino` visto desde el servidor.
    #[default]
    Local,
    /// `-R`: un puerto del servidor lleva a `destino` visto desde tu PC.
    Remote,
    /// `-D`: proxy SOCKS5 en tu PC que sale a la red por el servidor.
    Socks,
}

/// Definición guardada de un túnel (por servidor).
///
/// - Local / SOCKS: `bind_*` es dónde se escucha en tu PC.
/// - Remoto: `bind_*` es dónde escucha el servidor; `dest_*` está en tu PC (o tu red).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub profile_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: TunnelKind,
    #[serde(default)]
    pub bind_host: String,
    #[serde(default)]
    pub bind_port: u16,
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Starting,
    Active,
    /// La conexión SSH se cayó y se está reconectando: se reanuda solo.
    Waiting,
    Stopped,
    Error,
}

/// Estado en vivo de un túnel dentro de una sesión.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub session_id: String,
    pub tunnel_id: String,
    pub state: TunnelState,
    /// Motivo del error / de la espera.
    pub message: Option<String>,
    /// Último fallo de una conexión concreta (el túnel sigue activo).
    pub last_error: Option<String>,
    /// Conexiones abiertas ahora.
    pub connections: u32,
    /// Conexiones atendidas desde que se activó.
    pub total_connections: u64,
    /// De tu PC hacia el servidor.
    pub bytes_up: u64,
    /// Del servidor hacia tu PC.
    pub bytes_down: u64,
    /// Puerto real en escucha (útil si se pidió el 0).
    pub bound_port: Option<u16>,
    /// Unix ms.
    pub started_at: u64,
}
