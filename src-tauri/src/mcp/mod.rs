//! Servidor MCP de TerView: asistentes de IA (Claude Code, Claude Desktop…) trabajan con tus
//! servidores usando las conexiones guardadas, sin ver nunca contraseñas ni llaves.
//!
//! Piezas:
//! - `http`: transporte HTTP local (127.0.0.1 + token) con el SDK oficial `rmcp`.
//! - `server`: lista de herramientas y paso de cada llamada a `core`.
//! - `core`: permisos, aprobación, ejecución con límites y registro (sin Tauri: se prueba aparte).
//! - `policy`: reglas de acceso y comandos peligrosos. `config`: `mcp.json`. `audit`: registro.
//! - `approval` y `ui`: diálogos y peticiones a la interfaz. `backend`: el motor de la app.
//! - `vuln`: resumen de los informes del escáner de vulnerabilidades para el asistente.
//! - `bridge`: puente stdio (`terview-mcp`), compartido con `src/bin/terview-mcp.rs`.
//!
//! Apagado por defecto. Se activa en Ajustes → Asistentes de IA (MCP).

pub mod approval;
pub mod audit;
pub mod backend;
// El puente se usa en el binario `terview-mcp` (con #[path]) y aquí solo en las pruebas.
#[allow(dead_code)] // el binario sí lo usa todo (y allí se avisaría de lo que sobre)
pub mod bridge;
pub mod config;
pub mod core;
pub mod diff;
pub mod http;
pub mod policy;
pub mod server;
pub mod template;
pub mod ui;
pub mod vuln;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod e2e_tests;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::storage::secrets;
use crate::storage::vault::Vault;
use approval::{ApprovalRequest, Decision, PendingApprovals};
use audit::{AuditEntry, AuditLog};
use backend::TauriBackend;
use config::{McpConfig, McpConfigStore};
use policy::Access;
use ui::UiBridge;

/// Id del token en la bóveda o el llavero.
pub const TOKEN_ID: &str = secrets::MCP_TOKEN_USER;
/// Payload: `AuditEntry`. Una acción del asistente empezó, cambió o terminó.
pub const EV_ACTIVITY: &str = "mcp://activity";
/// Payload: `McpStatus`. El servidor se encendió, se apagó o falló.
pub const EV_STATUS: &str = "mcp://status";

/// Nombre del programa puente.
pub fn bridge_file_name() -> String {
    format!("terview-mcp{}", std::env::consts::EXE_SUFFIX)
}

/// Token nuevo: «tv_» + 64 caracteres hexadecimales (32 bytes al azar).
pub fn new_token() -> AppResult<Zeroizing<String>> {
    let mut b = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut b[..]).map_err(|e| AppError::Invalid(format!("no se pudo generar el token: {e}")))?;
    let mut s = Zeroizing::new(String::with_capacity(67));
    s.push_str("tv_");
    for byte in b.iter() {
        s.push_str(&format!("{byte:02x}"));
    }
    Ok(s)
}

// ───────────────────────── Puerta: bloqueo y token ─────────────────────────

/// El token se lee de la bóveda o el llavero la primera vez y se guarda en memoria hasta que
/// TerView se bloquea (como el resto de secretos).
#[derive(Default)]
pub struct AppGate {
    cache: Mutex<Option<Zeroizing<String>>>,
}

impl AppGate {
    pub fn forget(&self) {
        *self.cache.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn set(&self, token: Zeroizing<String>) {
        *self.cache.lock().unwrap_or_else(|p| p.into_inner()) = Some(token);
    }
}

impl http::Gate for AppGate {
    fn locked(&self) -> bool {
        let locked = Vault::global().status().locked;
        if locked {
            self.forget();
        }
        locked
    }

    fn token(&self) -> Option<Zeroizing<String>> {
        if let Some(t) = self.cache.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            return Some(t);
        }
        match secrets::get_secret(TOKEN_ID) {
            Ok(Some(t)) if !t.is_empty() => {
                let t = Zeroizing::new(t);
                self.set(t.clone());
                Some(t)
            }
            Ok(_) => None,
            Err(e) => {
                log::warn!("MCP: no se pudo leer el token: {e}");
                None
            }
        }
    }
}

// ───────────────────────── Estado de la app ─────────────────────────

struct Running {
    port: u16,
    ct: CancellationToken,
}

pub struct McpState {
    pub core: Arc<core::McpCore<TauriBackend>>,
    pub pending: Arc<PendingApprovals>,
    pub ui: Arc<UiBridge>,
    pub gate: Arc<AppGate>,
    running: Mutex<Option<Running>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub url: String,
    /// Por qué no está en marcha (puerto ocupado…).
    pub error: Option<String>,
    pub approval_timeout_secs: u32,
    pub bridge_path: String,
    pub bridge_found: bool,
    /// La app corre como AppImage: la ruta del puente cambia en cada arranque.
    pub app_image: bool,
    pub audit_path: Option<String>,
}

/// Configuración lista para copiar en el cliente.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub claude_code_stdio: String,
    pub claude_code_http: String,
    pub claude_desktop_json: String,
    pub url: String,
    pub token: String,
}

impl McpState {
    pub fn new(app: &AppHandle) -> Self {
        let pending = Arc::new(PendingApprovals::default());
        let ui = Arc::new(UiBridge::default());
        let audit = AuditLog::load();
        let emitter = app.clone();
        audit.set_notify(move |e| {
            let _ = emitter.emit(EV_ACTIVITY, e);
        });
        let backend = TauriBackend { app: app.clone(), pending: pending.clone(), ui: ui.clone() };
        let core = Arc::new(core::McpCore::new(backend, McpConfigStore::load(), audit));
        McpState {
            core,
            pending,
            ui,
            gate: Arc::new(AppGate::default()),
            running: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    fn config(&self) -> McpConfig {
        self.core.config.get()
    }

    pub fn status(&self) -> McpStatus {
        let cfg = self.config();
        let running = self.running.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|r| r.port);
        let port = running.unwrap_or(cfg.port);
        let bridge = bridge_path();
        McpStatus {
            enabled: cfg.enabled,
            running: running.is_some(),
            port,
            url: format!("http://127.0.0.1:{port}{}", http::MCP_PATH),
            error: self.last_error.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            approval_timeout_secs: cfg.approval_timeout_secs,
            bridge_found: bridge.as_ref().is_some_and(|p| p.is_file()),
            bridge_path: bridge.map(|p| p.display().to_string()).unwrap_or_else(bridge_file_name),
            app_image: std::env::var_os("APPIMAGE").is_some(),
            audit_path: self.core.audit.path().map(|p| p.display().to_string()),
        }
    }

    fn set_error(&self, e: Option<String>) {
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = e;
    }

    /// Apaga el servidor HTTP (si estaba encendido) y deniega lo pendiente.
    pub fn stop(&self, app: &AppHandle) {
        if let Some(r) = self.running.lock().unwrap_or_else(|p| p.into_inner()).take() {
            r.ct.cancel();
            log::info!("MCP: servidor apagado");
        }
        for id in self.pending.deny_all() {
            let _ = app.emit(backend::EV_APPROVAL_DONE, id);
        }
    }

    /// Enciende el servidor en el puerto de los ajustes (lo reinicia si ya estaba).
    pub fn start(&self, app: &AppHandle) -> AppResult<()> {
        self.stop(app);
        let port = self.config().port;
        let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(e) => {
                let msg = format!("No se pudo abrir el puerto {port} en 127.0.0.1: {e}. Prueba con otro puerto.");
                self.set_error(Some(msg.clone()));
                return Err(AppError::Network(msg));
            }
        };
        listener.set_nonblocking(true)?;
        let ct = CancellationToken::new();
        *self.running.lock().unwrap_or_else(|p| p.into_inner()) = Some(Running { port, ct: ct.clone() });
        self.set_error(None);
        let core = self.core.clone();
        let gate: Arc<dyn http::Gate> = self.gate.clone();
        tauri::async_runtime::spawn(async move {
            match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => http::serve(l, core, gate, ct).await,
                Err(e) => log::error!("MCP: no se pudo usar el puerto: {e}"),
            }
        });
        log::info!("MCP: escuchando en http://127.0.0.1:{port}{}", http::MCP_PATH);
        Ok(())
    }

    fn emit_status(&self, app: &AppHandle) -> McpStatus {
        let s = self.status();
        let _ = app.emit(EV_STATUS, &s);
        s
    }
}

/// Ruta esperada del puente: junto al programa de TerView.
pub fn bridge_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.with_file_name(bridge_file_name()))
}

/// Al arrancar la app: si el MCP estaba encendido, se enciende.
pub fn start_if_enabled(app: &AppHandle) {
    let Some(state) = app.try_state::<McpState>() else { return };
    if state.config().enabled
        && let Err(e) = state.start(app)
    {
        log::warn!("MCP: {e}");
    }
}

/// La bóveda cambió de estado (lo llama `storage::lock`): se olvida el token de la memoria y, si
/// se bloqueó, se deniega lo que esperaba tu permiso.
pub fn on_vault_change(app: &AppHandle) {
    let Some(state) = app.try_state::<McpState>() else { return };
    // Siempre se vuelve a leer de donde esté ahora (bóveda nueva, quitada u «Olvidé mi PIN»).
    state.gate.forget();
    if Vault::global().status().locked {
        for id in state.pending.deny_all() {
            let _ = app.emit(backend::EV_APPROVAL_DONE, id);
        }
    }
}

/// Lee el token o crea uno si no hay (o se perdió con «Olvidé mi PIN»).
async fn ensure_token(state: &McpState) -> AppResult<Zeroizing<String>> {
    let existing = blocking(|| secrets::get_secret(TOKEN_ID)).await?;
    if let Some(t) = existing.filter(|t| !t.is_empty()) {
        return Ok(Zeroizing::new(t));
    }
    regenerate(state).await
}

async fn regenerate(state: &McpState) -> AppResult<Zeroizing<String>> {
    let token = new_token()?;
    let t = token.clone();
    blocking(move || secrets::set_secret(TOKEN_ID, &t)).await?;
    state.gate.set(token.clone());
    Ok(token)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("tarea interna interrumpida: {e}")))?
}

fn shell_arg(s: &str) -> String {
    if s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-./:=@\\".contains(&b)) {
        s.to_string()
    } else if cfg!(windows) {
        format!("\"{s}\"")
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

// ───────────────────────── Comandos de la interfaz ─────────────────────────

#[tauri::command]
pub async fn mcp_status(state: State<'_, McpState>) -> AppResult<McpStatus> {
    Ok(state.status())
}

/// Enciende o apaga el servidor MCP. Al encenderlo por primera vez se crea el token.
#[tauri::command]
pub async fn mcp_set_enabled(app: AppHandle, state: State<'_, McpState>, enabled: bool) -> AppResult<McpStatus> {
    if enabled {
        ensure_token(&state).await?;
    }
    state.core.config.update(|c| c.enabled = enabled)?;
    if enabled {
        // Si el puerto está ocupado, queda encendido con el error a la vista.
        let _ = state.start(&app);
    } else {
        state.stop(&app);
        state.set_error(None);
    }
    Ok(state.emit_status(&app))
}

#[tauri::command]
pub async fn mcp_set_port(app: AppHandle, state: State<'_, McpState>, port: u16) -> AppResult<McpStatus> {
    if port < 1024 {
        return Err(AppError::Invalid("Usa un puerto entre 1024 y 65535".into()));
    }
    state.core.config.update(|c| c.port = port)?;
    if state.config().enabled {
        let _ = state.start(&app);
    }
    Ok(state.emit_status(&app))
}

#[tauri::command]
pub async fn mcp_set_approval_timeout(state: State<'_, McpState>, secs: u32) -> AppResult<McpConfig> {
    state.core.config.update(|c| c.approval_timeout_secs = secs)
}

#[tauri::command]
pub async fn mcp_config(state: State<'_, McpState>) -> AppResult<McpConfig> {
    Ok(state.config())
}

#[tauri::command]
pub async fn mcp_set_access(state: State<'_, McpState>, server_id: String, access: Access) -> AppResult<McpConfig> {
    state.core.config.update(|c| {
        c.access.insert(server_id, access);
    })
}

/// Borra una regla «Permitir siempre» de un servidor (o todas si `key` es None).
#[tauri::command]
pub async fn mcp_forget_rule(state: State<'_, McpState>, server_id: String, key: Option<String>) -> AppResult<McpConfig> {
    state.core.config.update(|c| match key {
        Some(k) => {
            if let Some(set) = c.remembered.get_mut(&server_id) {
                set.remove(&k);
            }
        }
        None => {
            c.remembered.remove(&server_id);
        }
    })
}

/// El token actual (para verlo o copiarlo). TerView tiene que estar desbloqueado.
#[tauri::command]
pub async fn mcp_get_token(state: State<'_, McpState>) -> AppResult<String> {
    Ok(ensure_token(&state).await?.to_string())
}

/// Crea un token nuevo: los clientes configurados con el anterior dejan de funcionar.
#[tauri::command]
pub async fn mcp_regenerate_token(app: AppHandle, state: State<'_, McpState>) -> AppResult<String> {
    let t = regenerate(&state).await?;
    log::info!("MCP: token regenerado");
    state.emit_status(&app);
    Ok(t.to_string())
}

/// Configuración para copiar en Claude Code y Claude Desktop (lleva el token).
#[tauri::command]
pub async fn mcp_client_config(state: State<'_, McpState>) -> AppResult<ClientConfig> {
    let token = ensure_token(&state).await?;
    let st = state.status();
    let bridge = st.bridge_path.clone();
    let desktop = serde_json::json!({
        "mcpServers": {
            "terview": {
                "command": bridge,
                "args": [],
                "env": { "TERVIEW_MCP_TOKEN": token.as_str() }
            }
        }
    });
    Ok(ClientConfig {
        claude_code_stdio: format!(
            "claude mcp add --env TERVIEW_MCP_TOKEN={} --transport stdio terview -- {}",
            token.as_str(),
            shell_arg(&bridge)
        ),
        claude_code_http: format!(
            "claude mcp add --transport http terview {} --header \"Authorization: Bearer {}\"",
            st.url,
            token.as_str()
        ),
        claude_desktop_json: serde_json::to_string_pretty(&desktop).unwrap_or_default(),
        url: st.url,
        token: token.to_string(),
    })
}

#[tauri::command]
pub async fn mcp_pending_approvals(state: State<'_, McpState>) -> AppResult<Vec<ApprovalRequest>> {
    Ok(state.pending.list())
}

/// Respuesta del diálogo de permiso. false si ya no estaba pendiente.
#[tauri::command]
pub async fn mcp_approval_reply(state: State<'_, McpState>, id: String, decision: Decision) -> AppResult<bool> {
    Ok(state.pending.reply(&id, decision))
}

/// Respuesta de la interfaz a una petición `mcp://ui-request`.
#[tauri::command]
pub async fn mcp_ui_reply(
    state: State<'_, McpState>,
    id: String,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
) -> AppResult<bool> {
    let result = if ok {
        Ok(value.unwrap_or(Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "error en la ventana de TerView".into()))
    };
    Ok(state.ui.reply(&id, result))
}

/// Actividad reciente del asistente (lo más nuevo primero).
#[tauri::command]
pub async fn mcp_activity(state: State<'_, McpState>) -> AppResult<Vec<AuditEntry>> {
    Ok(state.core.audit.list())
}

/// Vacía la lista del panel (el archivo de registro se conserva).
#[tauri::command]
pub async fn mcp_activity_clear(state: State<'_, McpState>) -> AppResult<()> {
    state.core.audit.clear_recent();
    Ok(())
}
