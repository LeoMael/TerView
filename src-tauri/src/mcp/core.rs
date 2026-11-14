//! Lógica de las herramientas del asistente: permisos, aprobación, ejecución, límites y registro.
//!
//! Orden de cada llamada:
//! 1. ¿MCP encendido? ¿SSHorus desbloqueado? Si no, se rechaza todo con un mensaje claro.
//! 2. Se busca el servidor y su nivel de acceso (Sin acceso = rechazado).
//! 3. `policy::decide_auto`: lectura → pasa; cambio → diálogo en SSHorus (o regla «siempre», o el modo
//!    «Aceptar automáticamente» del servidor); peligroso → diálogo (salvo modo automático «todo»);
//!    solo lectura → los cambios se rechazan. El modo automático nunca vale con SSHorus bloqueado.
//! 4. Se ejecuta con los límites de tiempo y de salida, y se anota en el registro.
//!
//! Las contraseñas y llaves nunca llegan al asistente: usa conexiones ya abiertas en la app. La única que
//! pasa por aquí es la de sudo (si el usuario aprueba un comando con sudo): la consigue la interfaz y va
//! por stdin al envoltorio de `sudo.rs`; no aparece en la respuesta, en el registro ni en la línea de
//! comandos remota.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::approval::{ApprovalRequest, Decision};
use super::audit::{now_ms, AuditEntry, AuditLog, AuditStatus};
use super::backend::Backend;
use super::config::McpConfigStore;
use super::policy::{self, Access, Action, AutoGrant, AutoLevel, Verdict};
use super::{diff, sudo, template};
use crate::error::{AppError, AppResult};
use crate::types::{ExecResult, FileEntry, FileKind, ServerProfile, SessionInfo, SnippetScope, TransferJob};
use crate::vulnscan::scan::ScanOptions;

pub const LOCKED_MSG: &str = "SSHorus está bloqueado: desbloquéalo para continuar.";
pub const DISABLED_MSG: &str =
    "El servidor MCP de SSHorus está apagado. Actívalo en SSHorus → Ajustes → Asistentes de IA (MCP).";

/// Salida por defecto de cada flujo de `run_command` (KB) y máximo permitido.
pub const DEFAULT_OUTPUT_KB: u32 = 64;
pub const MAX_OUTPUT_KB: u32 = 512;
/// Tiempo por defecto de un comando (s). El máximo lo pone el exec (600 s).
pub const DEFAULT_TIMEOUT_SECS: u32 = 60;
/// Lectura de archivos: por defecto y máximo.
pub const DEFAULT_READ_BYTES: u64 = 64 * 1024;
pub const MAX_READ_BYTES: u64 = 1024 * 1024;
/// Tamaño máximo de `write_file`.
pub const MAX_WRITE_BYTES: usize = 1024 * 1024;
/// Entradas máximas de `list_dir`.
pub const MAX_DIR_ENTRIES: usize = 2000;
/// Texto máximo devuelto por las herramientas de escaneo (puertos, sitios, contenedores).
pub const MAX_SCAN_BYTES: usize = 200 * 1024;
/// Tiempo de espera de la interfaz al abrir una pestaña (puede pedir contraseña o huella).
const UI_CONNECT_TIMEOUT: Duration = Duration::from_secs(180);
const UI_SCAN_TIMEOUT: Duration = Duration::from_secs(90);
/// Tiempo límite de `run_audit` (la interfaz lee SSH, usuarios, puertos, sitios, contenedores…).
const UI_AUDIT_TIMEOUT: Duration = Duration::from_secs(240);
/// Tiempo límite de `scan_vulnerabilities` (s): por defecto, mínimo y máximo.
pub const DEFAULT_VULN_SCAN_SECS: u32 = 600;
pub const MIN_VULN_SCAN_SECS: u32 = 60;
pub const MAX_VULN_SCAN_SECS: u32 = 1800;
/// Margen para que el análisis termine de detenerse en el servidor tras el tiempo límite.
const VULN_STOP_GRACE: Duration = Duration::from_secs(30);
/// Tiempo mínimo para escribir la contraseña de sudo en SSHorus (s) y margen para comprobarla.
const MIN_SUDO_ASK_SECS: u32 = 60;
const SUDO_ASK_MARGIN_SECS: u64 = 30;
pub const SUDO_CANCELED_MSG: &str =
    "El usuario no dio la contraseña de sudo en SSHorus: no se ejecutó el comando.";

// ───────────────────────── Parámetros de las herramientas ─────────────────────────

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct NoParams {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ServerParams {
    /// Nombre o id del servidor (ver list_servers).
    pub server: String,
    /// Conexión concreta (ver list_sessions). Si no se da, se usa la más reciente de ese servidor.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct VulnReportParams {
    /// Nombre o id del servidor (ver list_servers).
    pub server: String,
    /// Hallazgos a mostrar, de más a menos grave (1-100, por defecto 20).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AuditReportParams {
    /// Nombre o id del servidor (ver list_servers).
    pub server: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct VulnScanParams {
    /// Nombre o id del servidor (ver list_servers). Hace falta una conexión abierta (connect).
    pub server: String,
    /// Conexión concreta (ver list_sessions). Si no se da, se usa la más reciente de ese servidor.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Tiempo límite en segundos (60-1800, por defecto 600). Al vencer se detiene también en el servidor.
    #[serde(default)]
    pub timeout_secs: Option<u32>,
    /// Hallazgos a mostrar, de más a menos grave (1-100, por defecto 20).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConnectParams {
    /// Nombre o id del servidor guardado en SSHorus.
    pub server: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RunCommandParams {
    /// Nombre o id del servidor.
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Comando de shell exacto. No interactivo (nada de top, vim o tail -f).
    pub command: String,
    /// Tiempo límite en segundos (1-600, por defecto 60). Al vencer se detiene el proceso remoto.
    #[serde(default)]
    pub timeout_secs: Option<u32>,
    /// KB máximos de salida por flujo (stdout y stderr; por defecto 64, máximo 512).
    #[serde(default)]
    pub max_output_kb: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CatalogListParams {
    /// Filtra por categoría (p. ej. «Podman», «Análisis del sistema», «Mis comandos»).
    #[serde(default)]
    pub category: Option<String>,
    /// Palabras a buscar en el nombre, la descripción o el comando.
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CatalogRunParams {
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// id del comando (ver list_catalog).
    pub id: String,
    /// Valores de las variables {{nombre}} de la plantilla.
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
    #[serde(default)]
    pub timeout_secs: Option<u32>,
    #[serde(default)]
    pub max_output_kb: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PathParams {
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Ruta en el servidor (absoluta o relativa a la carpeta personal).
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListDirParams {
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Carpeta del servidor. Vacío = carpeta personal.
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadFileParams {
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub path: String,
    /// Byte desde el que leer (para archivos grandes, por trozos).
    #[serde(default)]
    pub offset: Option<u64>,
    /// Bytes máximos a leer (por defecto 65536, máximo 1048576).
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WriteFileParams {
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub path: String,
    /// Contenido completo del archivo (texto, máximo 1 MiB). Se guarda de forma atómica.
    pub content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UploadParams {
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Archivos o carpetas de este PC (rutas absolutas).
    pub local_paths: Vec<String>,
    /// Carpeta de destino en el servidor.
    pub remote_dir: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DownloadParams {
    pub server: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Archivos o carpetas del servidor.
    pub remote_paths: Vec<String>,
    /// Carpeta de destino en este PC (ruta absoluta que ya exista).
    pub local_dir: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TransferStatusParams {
    /// Lote devuelto por upload o download. Si no se da, todas las transferencias visibles.
    #[serde(default)]
    pub batch_id: Option<String>,
}

// ───────────────────────── Catálogo ─────────────────────────

/// Comando de la Biblioteca (catálogo base, enviado por la interfaz, o «Mis comandos»).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub category: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub command: String,
    #[serde(default)]
    pub dangerous: bool,
    #[serde(default)]
    pub sudo: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub interactive: bool,
    /// «Mis comandos» limitado a un servidor o proyecto: (alcance, id).
    #[serde(skip)]
    pub scope: Option<(SnippetScope, String)>,
}

impl CatalogEntry {
    /// Comando 📊 que se puede ejecutar sin preguntar.
    fn is_read(&self) -> bool {
        self.read_only && !self.dangerous && !self.sudo && !self.interactive
    }
}

// ───────────────────────── Resultado ─────────────────────────

/// Lo que devuelve una herramienta: texto para el asistente y si es un error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

/// Por qué falló una herramienta.
#[derive(Debug)]
enum Fail {
    /// No permitido (sin acceso, solo lectura, denegado o sin respuesta).
    Denied(String),
    Locked,
    /// Error al hacerlo.
    Error(String),
}

impl From<AppError> for Fail {
    fn from(e: AppError) -> Self {
        match e {
            AppError::Locked => Fail::Locked,
            other => Fail::Error(other.to_string()),
        }
    }
}

type Res<T> = Result<T, Fail>;

/// Entrada del registro que se va completando durante la llamada.
struct Rec {
    entry: AuditEntry,
    started: Instant,
}

/// Servidor sobre el que se actúa.
struct Target {
    server: ServerProfile,
    access: Access,
    session: Option<SessionInfo>,
}

impl Target {
    fn session_id(&self) -> Res<&str> {
        self.session.as_ref().map(|s| s.id.as_str()).ok_or_else(|| {
            Fail::Error(format!(
                "No hay una conexión abierta con «{}». Usa la herramienta connect primero.",
                self.server.name
            ))
        })
    }
}

pub struct McpCore<B: Backend> {
    pub backend: B,
    pub config: McpConfigStore,
    pub audit: AuditLog,
    /// Catálogo base (lo manda la interfaz la primera vez que hace falta).
    catalog: Mutex<Option<Vec<CatalogEntry>>>,
    /// Servidores con un `scan_vulnerabilities` en curso (uno a la vez por servidor).
    vuln_scans: Mutex<BTreeSet<String>>,
    /// «Aceptar automáticamente» temporal (15 min, 1 h, hasta cerrar SSHorus): solo en memoria.
    auto_temp: Mutex<BTreeMap<String, AutoGrant>>,
}

/// Cuánto dura el modo «Aceptar automáticamente».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AutoDuration {
    #[serde(rename = "15m")]
    Min15,
    #[serde(rename = "1h")]
    Hour,
    /// Hasta cerrar SSHorus (en memoria).
    #[serde(rename = "session")]
    Session,
    /// Guardado en `mcp.json`.
    #[serde(rename = "always")]
    Always,
}

/// Modo automático activo de un servidor (para la interfaz).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoState {
    pub server_id: String,
    pub server_name: String,
    pub level: AutoLevel,
    /// Unix ms en que se apaga; None = hasta cerrar SSHorus o «siempre» (`saved`).
    pub until: Option<u64>,
    /// Guardado («siempre»).
    pub saved: bool,
}

impl<B: Backend> McpCore<B> {
    pub fn new(backend: B, config: McpConfigStore, audit: AuditLog) -> Self {
        McpCore {
            backend,
            config,
            audit,
            catalog: Mutex::new(None),
            vuln_scans: Mutex::new(BTreeSet::new()),
            auto_temp: Mutex::new(BTreeMap::new()),
        }
    }

    // ───────────── Aceptar automáticamente ─────────────

    fn auto_temp(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, AutoGrant>> {
        self.auto_temp.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Nivel automático que vale ahora en un servidor (`now` en Unix ms).
    pub fn auto_level_at(&self, server_id: &str, now: u64) -> AutoLevel {
        let cfg = self.config.get();
        let temp = self.auto_temp().get(server_id).copied();
        policy::effective_auto(
            cfg.access_of(server_id),
            self.backend.vault_locked(),
            cfg.auto_accept.get(server_id).copied(),
            temp,
            now,
        )
    }

    /// Activa (o apaga con `AutoLevel::Off`) el modo automático de un servidor. Quita lo que hubiera
    /// antes (temporal y guardado). Solo con acceso Completo.
    pub fn set_auto_at(&self, server_id: &str, level: AutoLevel, duration: AutoDuration, now: u64) -> AppResult<()> {
        if level != AutoLevel::Off && self.config.get().access_of(server_id) != Access::Full {
            return Err(AppError::Invalid(
                "El modo automático solo se puede usar en servidores con acceso Completo.".into(),
            ));
        }
        let sid = server_id.to_string();
        let save = level != AutoLevel::Off && duration == AutoDuration::Always;
        self.config.update(|c| {
            if save {
                c.auto_accept.insert(sid.clone(), level);
            } else {
                c.auto_accept.remove(&sid);
            }
        })?;
        let mut temp = self.auto_temp();
        temp.remove(server_id);
        if level != AutoLevel::Off && !save {
            let until = match duration {
                AutoDuration::Min15 => Some(now + 15 * 60 * 1000),
                AutoDuration::Hour => Some(now + 60 * 60 * 1000),
                AutoDuration::Session | AutoDuration::Always => None,
            };
            temp.insert(server_id.to_string(), AutoGrant { level, until });
        }
        Ok(())
    }

    /// Apaga el modo automático en todos los servidores (temporal y guardado).
    pub fn auto_off_all(&self) -> AppResult<()> {
        self.auto_temp().clear();
        self.config.update(|c| c.auto_accept.clear())?;
        Ok(())
    }

    /// Servidores con el modo automático activo ahora (aunque SSHorus esté bloqueado: es lo que se
    /// configuró; mientras esté bloqueado no se acepta nada).
    pub fn auto_list_at(&self, now: u64) -> Vec<AutoState> {
        let cfg = self.config.get();
        let mut temp = self.auto_temp();
        temp.retain(|_, g| g.active(now));
        let names: BTreeMap<String, String> =
            self.backend.profiles().servers.into_iter().map(|s| (s.id, s.name)).collect();
        let mut out = Vec::new();
        for (id, name) in &names {
            if cfg.access_of(id) != Access::Full {
                continue;
            }
            let (level, until, saved) = match temp.get(id) {
                Some(g) => (g.level, g.until, false),
                None => match cfg.auto_accept.get(id) {
                    Some(l) => (*l, None, true),
                    None => continue,
                },
            };
            out.push(AutoState { server_id: id.clone(), server_name: name.clone(), level, until, saved });
        }
        out
    }

    /// Ejecuta una herramienta. `cancel` se dispara si el cliente cancela la petición.
    pub async fn call(&self, tool: &str, args: Value, client: Option<String>, cancel: CancellationToken) -> ToolOutput {
        let mut rec = Rec {
            entry: AuditEntry {
                id: uuid::Uuid::new_v4().to_string(),
                at: now_ms(),
                tool: tool.to_string(),
                server_id: None,
                server_name: None,
                detail: String::new(),
                status: AuditStatus::Running,
                approved_by: None,
                message: None,
                duration_ms: None,
                client,
                exec_id: None,
                auto: false,
                auto_danger: false,
            },
            started: Instant::now(),
        };
        let out = match self.gate() {
            Err(f) => Err(f),
            Ok(()) => self.dispatch(tool, args, &mut rec, &cancel).await,
        };
        let (status, text, is_error) = match out {
            Ok(text) => (AuditStatus::Ok, text, false),
            Err(Fail::Denied(m)) => (AuditStatus::Denied, m, true),
            Err(Fail::Locked) => (AuditStatus::Locked, LOCKED_MSG.to_string(), true),
            Err(Fail::Error(m)) => (AuditStatus::Error, m, true),
        };
        rec.entry.status = status;
        rec.entry.exec_id = None;
        rec.entry.duration_ms = Some(rec.started.elapsed().as_millis() as u64);
        // Errores y rechazos: el motivo. Si salió bien, el resumen que dejó la herramienta (si dejó uno).
        if is_error {
            rec.entry.message = Some(super::audit::clip(first_line(&text), 300));
        }
        self.audit.record(rec.entry);
        ToolOutput { text, is_error }
    }

    fn gate(&self) -> Res<()> {
        if !self.config.get().enabled {
            return Err(Fail::Denied(DISABLED_MSG.into()));
        }
        if self.backend.vault_locked() {
            return Err(Fail::Locked);
        }
        Ok(())
    }

    async fn dispatch(&self, tool: &str, args: Value, rec: &mut Rec, cancel: &CancellationToken) -> Res<String> {
        match tool {
            "list_servers" => self.list_servers().await,
            "list_projects" => self.list_projects(),
            "list_sessions" => self.list_sessions().await,
            "list_catalog" => self.list_catalog(parse(args)?).await,
            "connect" => self.connect(parse(args)?, rec).await,
            "run_command" => self.run_command(parse(args)?, rec, cancel).await,
            "run_catalog_command" => self.run_catalog(parse(args)?, rec, cancel).await,
            "list_dir" => self.list_dir(parse(args)?, rec).await,
            "stat" => self.stat(parse(args)?, rec).await,
            "read_file" => self.read_file(parse(args)?, rec).await,
            "write_file" => self.write_file(parse(args)?, rec).await,
            "upload" => self.upload(parse(args)?, rec).await,
            "download" => self.download(parse(args)?, rec).await,
            "transfer_status" => self.transfer_status(parse(args)?).await,
            "list_ports" => self.scan("ports", parse(args)?, rec).await,
            "list_sites" => self.scan("sites", parse(args)?, rec).await,
            "list_containers" => self.scan("containers", parse(args)?, rec).await,
            "get_infra_map" => self.scan("infra", parse(args)?, rec).await,
            "get_vuln_report" => self.vuln_report(parse(args)?, rec).await,
            "scan_vulnerabilities" => self.vuln_scan(parse(args)?, rec, cancel).await,
            "get_audit_report" => self.audit_report(parse(args)?, rec).await,
            "run_audit" => self.run_audit(parse(args)?, rec).await,
            other => Err(Fail::Error(format!("Herramienta desconocida: {other}"))),
        }
    }

    // ───────────── Servidores y permisos ─────────────

    /// Servidores a los que el asistente tiene acceso.
    fn visible_servers(&self) -> Vec<(ServerProfile, Access)> {
        let cfg = self.config.get();
        self.backend
            .profiles()
            .servers
            .into_iter()
            .filter_map(|s| {
                let a = cfg.access_of(&s.id);
                (a != Access::None).then_some((s, a))
            })
            .collect()
    }

    async fn target(&self, server: &str, session_id: Option<&str>, rec: &mut Rec) -> Res<Target> {
        let wanted = server.trim();
        if wanted.is_empty() {
            return Err(Fail::Error("Falta el servidor (nombre o id; ver list_servers).".into()));
        }
        let servers = self.backend.profiles().servers;
        let found = match servers.iter().find(|s| s.id == wanted) {
            Some(s) => s.clone(),
            None => {
                let low = wanted.to_lowercase();
                let by_name: Vec<&ServerProfile> = servers.iter().filter(|s| s.name.trim().to_lowercase() == low).collect();
                match by_name.as_slice() {
                    [one] => (*one).clone(),
                    [] => return Err(Fail::Error(format!("No hay ningún servidor «{wanted}». Usa list_servers."))),
                    _ => {
                        return Err(Fail::Error(format!(
                            "Hay varios servidores llamados «{wanted}»: usa su id (ver list_servers)."
                        )))
                    }
                }
            }
        };
        rec.entry.server_id = Some(found.id.clone());
        rec.entry.server_name = Some(found.name.clone());
        let access = self.config.get().access_of(&found.id);
        if access == Access::None {
            return Err(Fail::Denied(policy::no_access_msg(&found.name)));
        }
        let sessions = self.backend.sessions().await;
        let session = match session_id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => match sessions.into_iter().find(|s| s.id == id) {
                Some(s) if s.profile_id == found.id => Some(s),
                Some(_) => {
                    return Err(Fail::Error(format!("La conexión {id} no es de «{}».", found.name)));
                }
                None => return Err(Fail::Error(format!("La conexión {id} no existe o ya se cerró."))),
            },
            None => sessions.into_iter().filter(|s| s.profile_id == found.id).max_by_key(|s| s.connected_at),
        };
        Ok(Target { server: found, access, session })
    }

    /// Aplica las reglas y, si hace falta, pregunta en SSHorus.
    async fn authorize(&self, rec: &mut Rec, t: &Target, action: Action, title: &str, shown: &str, diff: Option<String>) -> Res<()> {
        let cfg = self.config.get();
        let auto = self.auto_level_at(&t.server.id, now_ms());
        match policy::decide_auto(&t.server.name, t.access, &action, &cfg.remembered_of(&t.server.id), auto) {
            Verdict::Allow(why) => {
                rec.entry.approved_by = Some(why.to_string());
                Ok(())
            }
            Verdict::AutoAllow { danger } => {
                rec.entry.approved_by = Some(if danger { policy::AUTO_DANGER } else { policy::AUTO_CHANGE }.to_string());
                rec.entry.auto = true;
                rec.entry.auto_danger = danger;
                Ok(())
            }
            Verdict::Deny(msg) => Err(Fail::Denied(msg)),
            Verdict::Ask { can_remember } => {
                let secs = cfg.approval_timeout_secs;
                let req = ApprovalRequest {
                    id: uuid::Uuid::new_v4().to_string(),
                    server_id: t.server.id.clone(),
                    server_name: t.server.name.clone(),
                    tool: rec.entry.tool.clone(),
                    title: title.to_string(),
                    command: shown.to_string(),
                    diff,
                    danger: action.danger.clone(),
                    can_remember,
                    timeout_secs: secs,
                    expires_at: now_ms() + u64::from(secs) * 1000,
                    client: rec.entry.client.clone(),
                };
                let id = req.id.clone();
                rec.entry.message = Some("Esperando tu permiso en SSHorus".into());
                self.audit.record(rec.entry.clone());
                let answer = tokio::time::timeout(Duration::from_secs(u64::from(secs)), self.backend.ask_approval(req)).await;
                self.backend.approval_done(&id);
                rec.entry.message = None;
                // Si se bloqueó mientras esperaba, no se hace nada.
                if self.backend.vault_locked() {
                    return Err(Fail::Locked);
                }
                match answer {
                    Ok(Decision::Once) => {
                        rec.entry.approved_by = Some("tú: una vez".into());
                        Ok(())
                    }
                    Ok(Decision::Always) if can_remember => {
                        let key = action.key.clone();
                        let sid = t.server.id.clone();
                        if let Err(e) = self.config.update(|c| {
                            c.remembered.entry(sid).or_default().insert(key);
                        }) {
                            log::warn!("no se pudo guardar «permitir siempre»: {e}");
                        }
                        rec.entry.approved_by = Some("tú: siempre en este servidor".into());
                        Ok(())
                    }
                    Ok(Decision::Always) => {
                        rec.entry.approved_by = Some("tú: una vez (peligroso, no se recuerda)".into());
                        Ok(())
                    }
                    Ok(Decision::Deny) => {
                        rec.entry.approved_by = Some("tú: denegado".into());
                        Err(Fail::Denied("El usuario lo denegó en SSHorus.".into()))
                    }
                    Err(_) => {
                        rec.entry.approved_by = Some("sin respuesta".into());
                        Err(Fail::Denied(format!(
                            "Nadie respondió en SSHorus en {secs} s: se denegó. Pide al usuario que mire SSHorus y vuelve a intentarlo."
                        )))
                    }
                }
            }
        }
    }

    // ───────────── Herramientas sin servidor ─────────────

    async fn list_servers(&self) -> Res<String> {
        let sessions = self.backend.sessions().await;
        let list: Vec<Value> = self
            .visible_servers()
            .into_iter()
            .map(|(s, a)| {
                let ids: Vec<&str> = sessions.iter().filter(|x| x.profile_id == s.id).map(|x| x.id.as_str()).collect();
                json!({
                    "id": s.id,
                    "name": s.name,
                    "host": s.host,
                    "port": s.port,
                    "user": s.username,
                    "access": access_code(a),
                    "accessLabel": a.label(),
                    "connected": !ids.is_empty(),
                    "sessionIds": ids,
                })
            })
            .collect();
        if list.is_empty() {
            return Ok("No tienes acceso a ningún servidor. El usuario puede darlo en SSHorus → Ajustes → Asistentes de IA (MCP).".into());
        }
        Ok(pretty(&list))
    }

    fn list_projects(&self) -> Res<String> {
        let visible: BTreeMap<String, String> =
            self.visible_servers().into_iter().map(|(s, _)| (s.id, s.name)).collect();
        let list: Vec<Value> = self
            .backend
            .profiles()
            .projects
            .into_iter()
            .filter_map(|p| {
                let servers: Vec<Value> = p
                    .server_ids
                    .iter()
                    .filter_map(|id| visible.get(id).map(|n| json!({ "id": id, "name": n })))
                    .collect();
                (!servers.is_empty()).then(|| json!({ "id": p.id, "name": p.name, "servers": servers }))
            })
            .collect();
        Ok(pretty(&list))
    }

    async fn list_sessions(&self) -> Res<String> {
        let visible: BTreeSet<String> = self.visible_servers().into_iter().map(|(s, _)| s.id).collect();
        let list: Vec<Value> = self
            .backend
            .sessions()
            .await
            .into_iter()
            .filter(|s| visible.contains(&s.profile_id))
            .map(|s| {
                json!({
                    "sessionId": s.id,
                    "serverId": s.profile_id,
                    "serverName": s.name,
                    "host": s.host,
                    "user": s.username,
                    "connectedAt": s.connected_at,
                })
            })
            .collect();
        Ok(pretty(&list))
    }

    async fn catalog(&self) -> Res<Vec<CatalogEntry>> {
        let cached = self.catalog.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let mut base = match cached {
            Some(c) => c,
            None => {
                let v = self.backend.ui_request("catalog", json!({}), UI_SCAN_TIMEOUT).await?;
                let list: Vec<CatalogEntry> = serde_json::from_value(v)
                    .map_err(|e| Fail::Error(format!("catálogo no válido: {e}")))?;
                *self.catalog.lock().unwrap_or_else(|p| p.into_inner()) = Some(list.clone());
                list
            }
        };
        base.extend(self.backend.snippets().into_iter().map(|s| CatalogEntry {
            id: s.id,
            category: if s.category.trim().is_empty() { "Mis comandos".into() } else { s.category },
            name: s.name,
            description: s.description,
            command: s.command,
            dangerous: s.dangerous,
            sudo: s.sudo,
            read_only: s.read_only,
            interactive: false,
            scope: match (s.scope, s.scope_id) {
                (SnippetScope::Global, _) | (_, None) => None,
                (scope, Some(id)) => Some((scope, id)),
            },
        }));
        Ok(base)
    }

    /// Para las pruebas: fija el catálogo base sin pedirlo a la interfaz.
    #[cfg(test)]
    pub fn set_catalog(&self, list: Vec<CatalogEntry>) {
        *self.catalog.lock().unwrap_or_else(|p| p.into_inner()) = Some(list);
    }

    async fn list_catalog(&self, p: CatalogListParams) -> Res<String> {
        let cat = p.category.as_deref().map(|c| c.trim().to_lowercase()).filter(|c| !c.is_empty());
        let words: Vec<String> = p
            .query
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        let list: Vec<Value> = self
            .catalog()
            .await?
            .into_iter()
            .filter(|e| !e.interactive)
            .filter(|e| cat.as_ref().is_none_or(|c| e.category.to_lowercase() == *c))
            .filter(|e| {
                let hay = format!("{} {} {}", e.name, e.description.as_deref().unwrap_or(""), e.command).to_lowercase();
                words.iter().all(|w| hay.contains(w))
            })
            .map(|e| {
                let vars: Vec<Value> = template::parse_vars(&e.command)
                    .into_iter()
                    .map(|(n, d)| json!({ "name": n, "default": d }))
                    .collect();
                json!({
                    "id": e.id,
                    "category": e.category,
                    "name": e.name,
                    "description": e.description,
                    "command": e.command,
                    "vars": vars,
                    "readOnly": e.is_read(),
                    "dangerous": e.dangerous,
                    "sudo": e.sudo,
                })
            })
            .collect();
        if list.is_empty() {
            return Ok("No hay comandos con ese filtro.".into());
        }
        Ok(format!(
            "{} comandos. Los de readOnly=true se ejecutan sin preguntar; el resto pide permiso en SSHorus.\n{}",
            list.len(),
            serde_json::to_string(&list).unwrap_or_default()
        ))
    }

    async fn transfer_status(&self, p: TransferStatusParams) -> Res<String> {
        let visible: BTreeSet<String> = self.visible_servers().into_iter().map(|(s, _)| s.id).collect();
        let sessions: BTreeSet<String> = self
            .backend
            .sessions()
            .await
            .into_iter()
            .filter(|s| visible.contains(&s.profile_id))
            .map(|s| s.id)
            .collect();
        let jobs: Vec<TransferJob> = self
            .backend
            .transfers()
            .into_iter()
            .filter(|j| sessions.contains(&j.session_id))
            .filter(|j| p.batch_id.as_ref().is_none_or(|b| &j.batch_id == b))
            .collect();
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for j in &jobs {
            *counts.entry(enum_text(&j.status)).or_default() += 1;
        }
        let shown: Vec<Value> = jobs
            .iter()
            .take(200)
            .map(|j| {
                json!({
                    "id": j.id,
                    "batchId": j.batch_id,
                    "direction": enum_text(&j.direction),
                    "name": j.name,
                    "localPath": j.local_path,
                    "remotePath": j.remote_path,
                    "size": j.size,
                    "transferred": j.transferred,
                    "status": enum_text(&j.status),
                    "error": j.error,
                })
            })
            .collect();
        Ok(pretty(&json!({ "total": jobs.len(), "byStatus": counts, "jobs": shown })))
    }

    // ───────────── Conexión ─────────────

    async fn connect(&self, p: ConnectParams, rec: &mut Rec) -> Res<String> {
        let t = self.target(&p.server, None, rec).await?;
        rec.entry.detail = format!("conectar a {}", t.server.name);
        if let Some(s) = &t.session {
            rec.entry.approved_by = Some(policy::AUTO_READ.into());
            return Ok(format!("Ya hay una conexión abierta con «{}»: sessionId {}", t.server.name, s.id));
        }
        let shown = format!("{}@{}:{}", t.server.username, t.server.host, t.server.port);
        self.authorize(rec, &t, Action::change_on_read("connect"), "quiere conectarse (se abre una pestaña)", &shown, None)
            .await?;
        let v = self
            .backend
            .ui_request("connect", json!({ "profileId": t.server.id }), UI_CONNECT_TIMEOUT)
            .await?;
        let sid = v.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
        if sid.is_empty() {
            return Err(Fail::Error(format!("No se pudo conectar a «{}».", t.server.name)));
        }
        Ok(format!("Conectado a «{}» (pestaña abierta en SSHorus): sessionId {sid}", t.server.name))
    }

    // ───────────── Comandos ─────────────

    async fn run_command(&self, p: RunCommandParams, rec: &mut Rec, cancel: &CancellationToken) -> Res<String> {
        let command = p.command.trim().to_string();
        rec.entry.detail = command.clone();
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        if command.is_empty() {
            return Err(Fail::Error("El comando está vacío.".into()));
        }
        if policy::looks_interactive(&command) {
            return Err(Fail::Error(
                "Ese comando es interactivo o no termina solo (top, vim, tail -f…): aquí se ejecuta sin terminal. \
                 Usa una versión que termine (p. ej. «tail -n 200» o «top -b -n 1»)."
                    .into(),
            ));
        }
        let sid = t.session_id()?.to_string();
        let action = Action::change(format!("run_command\n{command}")).with_danger(policy::danger_reasons(&command));
        self.authorize(rec, &t, action, "quiere ejecutar un comando", &command, None).await?;
        let sudo = policy::uses_sudo(&command);
        self.exec(rec, &t, &sid, &command, sudo, p.timeout_secs, p.max_output_kb, cancel).await
    }

    async fn run_catalog(&self, p: CatalogRunParams, rec: &mut Rec, cancel: &CancellationToken) -> Res<String> {
        rec.entry.detail = p.id.clone();
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let entry = self
            .catalog()
            .await?
            .into_iter()
            .find(|e| e.id == p.id)
            .ok_or_else(|| Fail::Error(format!("No hay ningún comando con id «{}» (ver list_catalog).", p.id)))?;
        if entry.interactive {
            return Err(Fail::Error("Ese comando es interactivo: solo tiene sentido en una terminal.".into()));
        }
        if let Some((scope, id)) = &entry.scope {
            let fits = match scope {
                SnippetScope::Server => *id == t.server.id,
                SnippetScope::Project => self
                    .backend
                    .profiles()
                    .projects
                    .iter()
                    .any(|pr| pr.id == *id && pr.server_ids.contains(&t.server.id)),
                SnippetScope::Global => true,
            };
            if !fits {
                return Err(Fail::Error(format!("«{}» no es para este servidor.", entry.name)));
            }
        }
        let command = template::render(&entry.command, &p.vars).map_err(Fail::Error)?;
        rec.entry.detail = command.clone();
        let sid = t.session_id()?.to_string();
        let mut danger = policy::danger_reasons(&command);
        if entry.dangerous && danger.is_empty() {
            danger.push("marcado como peligroso en la Biblioteca".into());
        }
        // Con sudo SSHorus pone la contraseña: se pregunta siempre (como `sudo` en run_command).
        let sudo = entry.sudo || policy::uses_sudo(&command);
        if sudo && danger.is_empty() {
            danger.push("usa sudo (permisos de administrador)".into());
        }
        let action = if entry.is_read() && danger.is_empty() {
            Action::read(format!("catalog\n{command}"))
        } else {
            Action::change(format!("run_command\n{command}")).with_danger(danger)
        };
        let title = format!("quiere ejecutar «{}» de la Biblioteca", entry.name);
        self.authorize(rec, &t, action, &title, &command, None).await?;
        self.exec(rec, &t, &sid, &command, sudo, p.timeout_secs, p.max_output_kb, cancel).await
    }

    /// Ejecuta un comando ya aprobado. Si usa sudo (`sudo`), SSHorus pone la contraseña: la consigue la
    /// interfaz (igual que en Administración) y va por stdin al envoltorio de `sudo.rs`.
    #[allow(clippy::too_many_arguments)]
    async fn exec(
        &self,
        rec: &mut Rec,
        t: &Target,
        session_id: &str,
        command: &str,
        sudo: bool,
        timeout_secs: Option<u32>,
        max_output_kb: Option<u32>,
        cancel: &CancellationToken,
    ) -> Res<String> {
        let timeout = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, 600);
        let max = (max_output_kb.unwrap_or(DEFAULT_OUTPUT_KB).clamp(1, MAX_OUTPUT_KB) as usize) * 1024;
        let password = if sudo { self.sudo_password(rec, t, session_id).await? } else { None };
        let Some(password) = password else {
            let r = self.exec_raw(rec, session_id, command, None, timeout, cancel).await?;
            rec.entry.message = Some(exec_summary(&r));
            return Ok(format_exec(&r, max));
        };
        let wrapped = sudo::wrap(command, &password).map_err(Fail::Error)?;
        let result = self.exec_raw(rec, session_id, &wrapped.command, Some(&wrapped.stdin), timeout, cancel).await;
        drop(wrapped); // borra el script y la contraseña del stdin
        let mut r = result?;
        sudo::redact(&mut r.stdout, &password);
        sudo::redact(&mut r.stderr, &password);
        if let Some(f) = sudo::failure(r.exit_code, &r.stderr) {
            if f == sudo::SudoFailure::BadPassword {
                // Igual que la interfaz: se olvida la de memoria y la guardada queda como rechazada.
                let payload = json!({ "sessionId": session_id, "serverName": t.server.name });
                if let Err(e) = self.backend.ui_request("sudo-rejected", payload, Duration::from_secs(10)).await {
                    log::warn!("MCP: no se pudo avisar a la interfaz de la contraseña de sudo rechazada: {e}");
                }
            }
            return Err(Fail::Error(sudo::failure_message(f, &t.server.name)));
        }
        rec.entry.message = Some(format!("{} (con sudo)", exec_summary(&r)));
        Ok(format_exec(&r, max))
    }

    /// Pide a la interfaz la contraseña de sudo de la conexión (en memoria → guardada → otra pestaña →
    /// diálogo, según el ajuste del servidor). None = no hace falta (root o sudo sin contraseña).
    async fn sudo_password(&self, rec: &mut Rec, t: &Target, session_id: &str) -> Res<Option<Zeroizing<String>>> {
        let secs = self.config.get().approval_timeout_secs.max(MIN_SUDO_ASK_SECS);
        rec.entry.message = Some("Buscando la contraseña de sudo en SSHorus".into());
        self.audit.record(rec.entry.clone());
        rec.entry.message = None;
        let payload = json!({
            "sessionId": session_id,
            "profileId": t.server.id,
            "serverName": t.server.name,
            "timeoutSecs": secs,
            "auto": rec.entry.auto,
        });
        let wait = Duration::from_secs(u64::from(secs) + SUDO_ASK_MARGIN_SECS);
        let answer = self.backend.ui_request("sudo", payload, wait).await;
        // Si se bloqueó mientras tanto, no se hace nada.
        if self.backend.vault_locked() {
            return Err(Fail::Locked);
        }
        sudo_answer(answer?)
    }

    /// Ejecuta tal cual (con `stdin` si lo hay), con registro y cancelación.
    async fn exec_raw(
        &self,
        rec: &mut Rec,
        session_id: &str,
        command: &str,
        stdin: Option<&[u8]>,
        timeout: u32,
        cancel: &CancellationToken,
    ) -> Res<ExecResult> {
        let exec_id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
        rec.entry.exec_id = Some(exec_id.clone());
        rec.entry.message = Some("Ejecutando".into());
        self.audit.record(rec.entry.clone());
        rec.entry.message = None;

        // Si el cliente cancela la petición, se detiene también en el servidor.
        let run = self.backend.exec(session_id, command, stdin, timeout, &exec_id);
        tokio::pin!(run);
        let result = tokio::select! {
            r = &mut run => r,
            () = cancel.cancelled() => {
                self.backend.cancel_exec(&exec_id);
                run.await
            }
        };
        match result {
            Ok(r) => Ok(r),
            Err(AppError::Canceled) => Err(Fail::Error("Se canceló el comando (y se detuvo en el servidor).".into())),
            Err(e) => Err(e.into()),
        }
    }

    // ───────────── Archivos ─────────────

    async fn list_dir(&self, p: ListDirParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = p.path.clone();
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        self.authorize(rec, &t, Action::read("list_dir"), "", "", None).await?;
        let path = if p.path.trim().is_empty() { "." } else { p.path.as_str() };
        let entries = self.backend.list_dir(&sid, path).await?;
        let total = entries.len();
        let rows: Vec<Value> = entries.iter().take(MAX_DIR_ENTRIES).map(entry_json).collect();
        let mut out = pretty(&rows);
        if total > MAX_DIR_ENTRIES {
            out.push_str(&format!("\n(se muestran {MAX_DIR_ENTRIES} de {total} entradas)"));
        }
        rec.entry.message = Some(format!("{total} entradas"));
        Ok(out)
    }

    async fn stat(&self, p: PathParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = p.path.clone();
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        self.authorize(rec, &t, Action::read("stat"), "", "", None).await?;
        let e = self.backend.stat(&sid, &p.path).await?;
        Ok(pretty(&entry_json(&e)))
    }

    async fn read_file(&self, p: ReadFileParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = p.path.clone();
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        self.authorize(rec, &t, Action::read("read_file"), "", "", None).await?;
        let offset = p.offset.unwrap_or(0);
        let max = p.max_bytes.unwrap_or(DEFAULT_READ_BYTES).clamp(1, MAX_READ_BYTES);
        let part = self.backend.read_part(&sid, &p.path, offset, max).await?;
        let probe = &part.data[..part.data.len().min(8192)];
        if probe.contains(&0) {
            return Ok(format!(
                "«{}» es un archivo binario ({} bytes): no se muestra. Usa download para bajarlo.",
                part.path, part.size
            ));
        }
        let end = part.offset + part.data.len() as u64;
        let mut out = format!("Archivo {} ({} bytes en total).", part.path, part.size);
        if part.offset > 0 || end < part.size {
            out.push_str(&format!(" Se muestran los bytes {}–{}.", part.offset, end));
        }
        out.push('\n');
        out.push_str(&String::from_utf8_lossy(&part.data));
        if end < part.size {
            out.push_str(&format!("\n[Quedan {} bytes: vuelve a llamar con offset={end}.]", part.size - end));
        }
        rec.entry.message = Some(format!("{} bytes leídos", part.data.len()));
        Ok(out)
    }

    async fn write_file(&self, p: WriteFileParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = p.path.clone();
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        if p.content.len() > MAX_WRITE_BYTES {
            return Err(Fail::Error(format!("El contenido pasa de {} bytes.", MAX_WRITE_BYTES)));
        }
        if p.path.trim().is_empty() {
            return Err(Fail::Error("Falta la ruta.".into()));
        }
        let sid = t.session_id()?.to_string();
        // El permiso se comprueba antes de leer nada (en solo lectura no hace falta el diff).
        let action = Action::change(format!("write_file\n{}", p.path.trim()));
        if let Verdict::Deny(msg) = policy::decide(&t.server.name, t.access, &action, &BTreeSet::new()) {
            return Err(Fail::Denied(msg));
        }
        let diff = match self.backend.read_part(&sid, &p.path, 0, MAX_WRITE_BYTES as u64 + 1).await {
            Ok(old) if old.size as usize > MAX_WRITE_BYTES || old.data.contains(&0) => {
                format!("(el archivo actual ocupa {} bytes y no se puede comparar; se reemplazará entero)", old.size)
            }
            Ok(old) => {
                let old = String::from_utf8_lossy(&old.data);
                let d = diff::unified(&old, &p.content);
                if d.is_empty() && old != p.content {
                    "(solo cambian los saltos de línea del final)".into()
                } else if d.is_empty() {
                    "(sin cambios)".into()
                } else {
                    d
                }
            }
            Err(AppError::NotFound(_)) => {
                let d = diff::unified("", &p.content);
                format!("(archivo nuevo)\n{d}")
            }
            Err(e) => return Err(e.into()),
        };
        let shown = format!("{} ({} bytes)", p.path.trim(), p.content.len());
        self.authorize(rec, &t, action, "quiere guardar un archivo", &shown, Some(diff)).await?;
        let saved = self.backend.write_text(&sid, &p.path, &p.content).await?;
        rec.entry.message = Some(format!("{} bytes guardados", saved.size));
        Ok(format!("Guardado {} ({} bytes).", saved.path, saved.size))
    }

    async fn upload(&self, p: UploadParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = format!("{} → {}", p.local_paths.join(", "), p.remote_dir);
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        if p.local_paths.is_empty() {
            return Err(Fail::Error("No hay nada que subir.".into()));
        }
        for lp in &p.local_paths {
            let path = std::path::Path::new(lp);
            if !path.is_absolute() || !path.exists() {
                return Err(Fail::Error(format!("No existe en este PC (usa rutas absolutas): {lp}")));
            }
        }
        if p.remote_dir.trim().is_empty() {
            return Err(Fail::Error("Falta la carpeta de destino.".into()));
        }
        let shown = format!("Subir a {}:\n{}", p.remote_dir, bullet(&p.local_paths));
        let key = format!("upload\n{}\n{}", p.remote_dir, p.local_paths.join("\n"));
        self.authorize(rec, &t, Action::change(key), "quiere subir archivos al servidor", &shown, None).await?;
        let batch = self.backend.upload(&sid, p.local_paths, p.remote_dir).await?;
        Ok(format!("Subida en cola (lote {batch}). Mira el progreso con transfer_status."))
    }

    async fn download(&self, p: DownloadParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = format!("{} → {}", p.remote_paths.join(", "), p.local_dir);
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        if p.remote_paths.is_empty() {
            return Err(Fail::Error("No hay nada que descargar.".into()));
        }
        let dir = std::path::Path::new(&p.local_dir);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(Fail::Error(format!("La carpeta local no existe (usa una ruta absoluta): {}", p.local_dir)));
        }
        let shown = format!("Descargar a {} (este PC):\n{}", p.local_dir, bullet(&p.remote_paths));
        let key = format!("download\n{}\n{}", p.local_dir, p.remote_paths.join("\n"));
        self.authorize(rec, &t, Action::change_on_read(key), "quiere descargar archivos a tu PC", &shown, None)
            .await?;
        let batch = self.backend.download(&sid, p.remote_paths, p.local_dir).await?;
        Ok(format!("Descarga en cola (lote {batch}). Mira el progreso con transfer_status."))
    }

    // ───────────── Escaneos (puertos, sitios, contenedores) ─────────────

    async fn scan(&self, kind: &str, p: ServerParams, rec: &mut Rec) -> Res<String> {
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        self.authorize(rec, &t, Action::read(kind), "", "", None).await?;
        let v = self.backend.ui_request(kind, json!({ "sessionId": sid }), UI_SCAN_TIMEOUT).await?;
        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
        Ok(clip_middle(&text, MAX_SCAN_BYTES))
    }

    // ───────────── Vulnerabilidades ─────────────

    /// Último informe guardado (de la interfaz o de `scan_vulnerabilities`), resumido. No hace falta
    /// conexión: se lee del historial de este PC.
    async fn vuln_report(&self, p: VulnReportParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = "último informe".into();
        let t = self.target(&p.server, None, rec).await?;
        self.authorize(rec, &t, Action::read("get_vuln_report"), "", "", None).await?;
        match self.backend.vuln_latest(&t.server.id).await? {
            Some(r) => {
                rec.entry.message = Some(format!("informe del {}", r.created_at));
                Ok(pretty(&super::vuln::summarize(&t.server.name, &r, p.limit)))
            }
            None => Ok(format!(
                "«{}» no tiene ningún análisis de vulnerabilidades guardado. Usa scan_vulnerabilities \
                 (o pide al usuario que pulse Analizar en SSHorus → Administración → Vulnerabilidades).",
                t.server.name
            )),
        }
    }

    /// Análisis nuevo SIN sudo. No cambia el servidor, pero tarda minutos y consulta OSV.dev desde
    /// este PC: pide permiso (con «Permitir siempre»), también en servidores de solo lectura.
    async fn vuln_scan(&self, p: VulnScanParams, rec: &mut Rec, cancel: &CancellationToken) -> Res<String> {
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        let timeout = p.timeout_secs.unwrap_or(DEFAULT_VULN_SCAN_SECS).clamp(MIN_VULN_SCAN_SECS, MAX_VULN_SCAN_SECS);
        rec.entry.detail = format!("análisis sin sudo (máx. {timeout} s)");
        let settings = self.backend.vuln_settings();
        let mut opts = ScanOptions::new(&t.server.id);
        opts.use_osv = settings.use_osv;
        opts.use_distro_tool = settings.use_distro_tool;
        opts.use_trivy = settings.use_trivy;
        opts.scan_images = settings.scan_images;
        opts.image_limit = settings.image_limit as usize;
        opts.save = true;

        let mut shown = vec![format!(
            "Análisis de vulnerabilidades SIN sudo como «{}». No cambia nada en el servidor:",
            t.server.username
        )];
        shown.push("• lee la lista de paquetes y programas instalados".into());
        if opts.use_distro_tool {
            shown.push("• usa la herramienta de seguridad de la distro si la hay (dnf, debsecan, pro, zypper)".into());
        }
        if opts.scan_images {
            shown.push(format!(
                "• lee hasta {} imágenes de contenedores del usuario sin arrancarlas{}",
                opts.image_limit,
                if opts.use_trivy { " (con Trivy si está instalado)" } else { "" }
            ));
        }
        if opts.use_osv {
            shown.push("• desde este PC consulta OSV.dev (solo nombres y versiones de paquetes)".into());
        }
        shown.push(format!("Tiempo máximo: {timeout} s. El informe se guarda en el historial."));

        {
            let running = self.vuln_scans.lock().unwrap_or_else(|p| p.into_inner());
            if running.contains(&t.server.id) {
                return Err(Fail::Error(format!(
                    "Ya hay un análisis de vulnerabilidades en curso en «{}»: espera a que termine.",
                    t.server.name
                )));
            }
        }
        let title = "quiere buscar vulnerabilidades (sin sudo; tarda unos minutos)";
        self.authorize(rec, &t, Action::change_on_read("scan_vulnerabilities"), title, &shown.join("\n"), None).await?;

        // Uno a la vez por servidor (se comprueba otra vez: la aprobación pudo tardar).
        if !self.vuln_scans.lock().unwrap_or_else(|p| p.into_inner()).insert(t.server.id.clone()) {
            return Err(Fail::Error(format!(
                "Ya hay un análisis de vulnerabilidades en curso en «{}»: espera a que termine.",
                t.server.name
            )));
        }
        let _running = RunningScan { set: &self.vuln_scans, id: t.server.id.clone() };

        let exec_id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
        rec.entry.exec_id = Some(exec_id.clone());
        rec.entry.message = Some("Analizando (puede tardar unos minutos)".into());
        self.audit.record(rec.entry.clone());
        rec.entry.message = None;

        let stop = CancellationToken::new();
        let run = self.backend.vuln_scan(&sid, opts, &exec_id, &stop);
        tokio::pin!(run);
        let mut timed_out = false;
        let result = tokio::select! {
            r = &mut run => r,
            () = cancel.cancelled() => {
                stop.cancel();
                tokio::time::timeout(VULN_STOP_GRACE, &mut run).await.unwrap_or(Err(AppError::Canceled))
            }
            () = tokio::time::sleep(Duration::from_secs(u64::from(timeout))) => {
                timed_out = true;
                stop.cancel();
                tokio::time::timeout(VULN_STOP_GRACE, &mut run).await.unwrap_or(Err(AppError::Canceled))
            }
        };
        match result {
            Ok(r) => {
                let s = &r.summary;
                rec.entry.message = Some(format!(
                    "{} vulnerabilidades ({} críticas, {} altas)",
                    s.total, s.critical, s.high
                ));
                Ok(pretty(&super::vuln::summarize(&t.server.name, &r, p.limit)))
            }
            Err(AppError::Canceled) if timed_out => Err(Fail::Error(format!(
                "El análisis pasó de {timeout} s y se detuvo (también en el servidor). Vuelve a intentarlo con un \
                 timeout_secs mayor (máximo {MAX_VULN_SCAN_SECS}) o pide al usuario que lo haga desde SSHorus."
            ))),
            Err(AppError::Canceled) => Err(Fail::Error("Se canceló el análisis (y se detuvo en el servidor).".into())),
            Err(e) => Err(e.into()),
        }
    }
}

impl<B: Backend> McpCore<B> {
    // ───────────── Auditoría del servidor ─────────────

    /// Última auditoría guardada (de SSHorus o de `run_audit`), resumida. No hace falta conexión.
    async fn audit_report(&self, p: AuditReportParams, rec: &mut Rec) -> Res<String> {
        rec.entry.detail = "última auditoría".into();
        let t = self.target(&p.server, None, rec).await?;
        self.authorize(rec, &t, Action::read("get_audit_report"), "", "", None).await?;
        match self.backend.audit_latest(&t.server.id).await? {
            Some(r) => {
                rec.entry.message = Some(format!("auditoría del {}", r.created_at));
                Ok(pretty(&super::server_audit::summarize(&t.server.name, &r)))
            }
            None => Ok(format!(
                "«{}» no tiene ninguna auditoría guardada. Usa run_audit (o pide al usuario que pulse \
                 «Auditar servidor» en SSHorus → Administración → Auditoría).",
                t.server.name
            )),
        }
    }

    /// Auditoría nueva SIN sudo (la hace la interfaz, igual que el botón). Solo lee, pero pide permiso
    /// la primera vez porque revisa muchas cosas del servidor. Se guarda en el historial.
    async fn run_audit(&self, p: ServerParams, rec: &mut Rec) -> Res<String> {
        let t = self.target(&p.server, p.session_id.as_deref(), rec).await?;
        let sid = t.session_id()?.to_string();
        rec.entry.detail = "auditoría sin sudo".into();
        let shown = format!(
            "Auditoría SIN sudo como «{}». No cambia nada ni instala nada en el servidor:\n\
             • lee la configuración de SSH, usuarios, puertos, cortafuegos, actualizaciones, sitios web,\n  \
             contenedores, servicios, intentos de entrada, disco, memoria y permisos\n\
             • usa el último informe de vulnerabilidades guardado (no lanza el escáner)\n\
             El informe se guarda en el historial de SSHorus.",
            t.server.username
        );
        let title = "quiere auditar el servidor (sin sudo; solo lectura)";
        self.authorize(rec, &t, Action::change_on_read("run_audit"), title, &shown, None).await?;
        let v = self
            .backend
            .ui_request("audit", json!({ "sessionId": sid, "profileId": t.server.id }), UI_AUDIT_TIMEOUT)
            .await?;
        let r: crate::audit::model::AuditReport =
            serde_json::from_value(v).map_err(|e| Fail::Error(format!("auditoría no válida: {e}")))?;
        rec.entry.message = Some(match (r.score, r.grade.as_deref()) {
            (Some(s), Some(g)) => format!("nota {s}/100 ({g})"),
            _ => "auditoría hecha".into(),
        });
        Ok(pretty(&super::server_audit::summarize(&t.server.name, &r)))
    }
}

/// Quita el servidor de los análisis en curso al terminar (también si se cancela o falla).
struct RunningScan<'a> {
    set: &'a Mutex<BTreeSet<String>>,
    id: String,
}

impl Drop for RunningScan<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.id);
    }
}

// ───────────────────────── Utilidades ─────────────────────────

/// Respuesta de la interfaz a «sudo»: `{ elevate: false }` (no hace falta), `{ elevate: true, password }`
/// o `{ canceled: true }`. La contraseña se saca sin copiarla y se borra de memoria al soltarla.
fn sudo_answer(v: Value) -> Res<Option<Zeroizing<String>>> {
    let Value::Object(mut m) = v else {
        return Err(Fail::Error("La ventana de SSHorus respondió algo no válido a la petición de sudo.".into()));
    };
    if m.get("canceled").and_then(Value::as_bool) == Some(true) {
        return Err(Fail::Denied(SUDO_CANCELED_MSG.into()));
    }
    match m.remove("password") {
        Some(Value::String(pw)) if !pw.is_empty() => Ok(Some(Zeroizing::new(pw))),
        Some(Value::String(pw)) => {
            drop(Zeroizing::new(pw));
            Err(Fail::Error("La contraseña de sudo está vacía.".into()))
        }
        Some(_) => Err(Fail::Error("La ventana de SSHorus respondió algo no válido a la petición de sudo.".into())),
        None => Ok(None),
    }
}

fn parse<T: serde::de::DeserializeOwned>(args: Value) -> Res<T> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|e| Fail::Error(format!("Parámetros no válidos: {e}")))
}

fn pretty<T: Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

fn bullet(items: &[String]) -> String {
    items.iter().map(|i| format!("• {i}")).collect::<Vec<_>>().join("\n")
}

fn access_code(a: Access) -> &'static str {
    match a {
        Access::None => "none",
        Access::Read => "read",
        Access::Full => "full",
    }
}

/// Valor de un enum serializado («running», «upload»…).
fn enum_text<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn entry_json(e: &FileEntry) -> Value {
    json!({
        "name": e.name,
        "path": e.path,
        "kind": match e.kind {
            FileKind::File => "file",
            FileKind::Dir => "dir",
            FileKind::Symlink => if e.is_dir_link { "symlink-dir" } else { "symlink" },
            FileKind::Other => "other",
        },
        "size": e.size,
        "modified": e.modified,
        "permissions": e.permissions_str,
    })
}

/// Recorta por el medio (se ven el principio y el final) respetando caracteres.
pub fn clip_middle(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let half = max / 2;
    let mut head = half;
    while !s.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = s.len() - half;
    while !s.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n[… se omitieron {} bytes …]\n{}", &s[..head], tail - head, &s[tail..])
}

fn exec_summary(r: &ExecResult) -> String {
    if r.timed_out {
        return "Se cortó por tiempo".into();
    }
    match r.exit_code {
        Some(c) => format!("código {c}"),
        None => "sin código de salida".into(),
    }
}

/// Texto para el asistente: cabecera con el código y la duración, y las dos salidas recortadas.
pub fn format_exec(r: &ExecResult, max: usize) -> String {
    let mut out = String::new();
    let code = match r.exit_code {
        Some(c) => c.to_string(),
        None => "desconocido".into(),
    };
    out.push_str(&format!("Código de salida: {code} · {:.1} s", r.duration_ms as f64 / 1000.0));
    if r.timed_out {
        out.push_str(" · SE CORTÓ POR TIEMPO (el proceso remoto se detuvo)");
    }
    let mut clipped = r.truncated;
    let stdout = clip_middle(&r.stdout, max);
    let stderr = clip_middle(&r.stderr, max);
    clipped |= stdout.len() != r.stdout.len() || stderr.len() != r.stderr.len();
    if clipped {
        out.push_str(" · salida recortada");
    }
    out.push_str("\n--- stdout ---\n");
    out.push_str(&stdout);
    if !r.stderr.is_empty() {
        out.push_str("\n--- stderr ---\n");
        out.push_str(&stderr);
    }
    out
}
