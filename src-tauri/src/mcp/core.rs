//! Lógica de las herramientas del asistente: permisos, aprobación, ejecución, límites y registro.
//!
//! Orden de cada llamada:
//! 1. ¿MCP encendido? ¿TerView desbloqueado? Si no, se rechaza todo con un mensaje claro.
//! 2. Se busca el servidor y su nivel de acceso (Sin acceso = rechazado).
//! 3. `policy::decide`: lectura → pasa; cambio → diálogo en TerView (o regla «siempre»);
//!    peligroso → diálogo siempre; solo lectura → los cambios se rechazan.
//! 4. Se ejecuta con los límites de tiempo y de salida, y se anota en el registro.
//!
//! Las contraseñas y llaves nunca pasan por aquí: el asistente usa conexiones ya abiertas en la app.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::approval::{ApprovalRequest, Decision};
use super::audit::{now_ms, AuditEntry, AuditLog, AuditStatus};
use super::backend::Backend;
use super::config::McpConfigStore;
use super::policy::{self, Access, Action, Verdict};
use super::{diff, template};
use crate::error::AppError;
use crate::types::{ExecResult, FileEntry, FileKind, ServerProfile, SessionInfo, SnippetScope, TransferJob};
use crate::vulnscan::scan::ScanOptions;

pub const LOCKED_MSG: &str = "TerView está bloqueado: desbloquéalo para continuar.";
pub const DISABLED_MSG: &str =
    "El servidor MCP de TerView está apagado. Actívalo en TerView → Ajustes → Asistentes de IA (MCP).";

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
/// Tiempo límite de `scan_vulnerabilities` (s): por defecto, mínimo y máximo.
pub const DEFAULT_VULN_SCAN_SECS: u32 = 600;
pub const MIN_VULN_SCAN_SECS: u32 = 60;
pub const MAX_VULN_SCAN_SECS: u32 = 1800;
/// Margen para que el análisis termine de detenerse en el servidor tras el tiempo límite.
const VULN_STOP_GRACE: Duration = Duration::from_secs(30);

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
    /// Nombre o id del servidor guardado en TerView.
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
}

impl<B: Backend> McpCore<B> {
    pub fn new(backend: B, config: McpConfigStore, audit: AuditLog) -> Self {
        McpCore { backend, config, audit, catalog: Mutex::new(None), vuln_scans: Mutex::new(BTreeSet::new()) }
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
            "get_vuln_report" => self.vuln_report(parse(args)?, rec).await,
            "scan_vulnerabilities" => self.vuln_scan(parse(args)?, rec, cancel).await,
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

    /// Aplica las reglas y, si hace falta, pregunta en TerView.
    async fn authorize(&self, rec: &mut Rec, t: &Target, action: Action, title: &str, shown: &str, diff: Option<String>) -> Res<()> {
        let cfg = self.config.get();
        match policy::decide(&t.server.name, t.access, &action, &cfg.remembered_of(&t.server.id)) {
            Verdict::Allow(why) => {
                rec.entry.approved_by = Some(why.to_string());
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
                rec.entry.message = Some("Esperando tu permiso en TerView".into());
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
                        Err(Fail::Denied("El usuario lo denegó en TerView.".into()))
                    }
                    Err(_) => {
                        rec.entry.approved_by = Some("sin respuesta".into());
                        Err(Fail::Denied(format!(
                            "Nadie respondió en TerView en {secs} s: se denegó. Pide al usuario que mire TerView y vuelve a intentarlo."
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
            return Ok("No tienes acceso a ningún servidor. El usuario puede darlo en TerView → Ajustes → Asistentes de IA (MCP).".into());
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
            "{} comandos. Los de readOnly=true se ejecutan sin preguntar; el resto pide permiso en TerView.\n{}",
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
        Ok(format!("Conectado a «{}» (pestaña abierta en TerView): sessionId {sid}", t.server.name))
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
        self.exec(rec, &sid, &command, p.timeout_secs, p.max_output_kb, cancel).await
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
        let action = if entry.is_read() && danger.is_empty() {
            Action::read(format!("catalog\n{command}"))
        } else {
            Action::change(format!("run_command\n{command}")).with_danger(danger)
        };
        let title = format!("quiere ejecutar «{}» de la Biblioteca", entry.name);
        self.authorize(rec, &t, action, &title, &command, None).await?;
        self.exec(rec, &sid, &command, p.timeout_secs, p.max_output_kb, cancel).await
    }

    async fn exec(
        &self,
        rec: &mut Rec,
        session_id: &str,
        command: &str,
        timeout_secs: Option<u32>,
        max_output_kb: Option<u32>,
        cancel: &CancellationToken,
    ) -> Res<String> {
        let exec_id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
        rec.entry.exec_id = Some(exec_id.clone());
        rec.entry.message = Some("Ejecutando".into());
        self.audit.record(rec.entry.clone());
        rec.entry.message = None;
        let timeout = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, 600);
        let max = (max_output_kb.unwrap_or(DEFAULT_OUTPUT_KB).clamp(1, MAX_OUTPUT_KB) as usize) * 1024;

        // Si el cliente cancela la petición, se detiene también en el servidor.
        let run = self.backend.exec(session_id, command, timeout, &exec_id);
        tokio::pin!(run);
        let result = tokio::select! {
            r = &mut run => r,
            () = cancel.cancelled() => {
                self.backend.cancel_exec(&exec_id);
                run.await
            }
        };
        match result {
            Ok(r) => {
                rec.entry.message = Some(exec_summary(&r));
                Ok(format_exec(&r, max))
            }
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
                 (o pide al usuario que pulse Analizar en TerView → Administración → Vulnerabilidades).",
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
                 timeout_secs mayor (máximo {MAX_VULN_SCAN_SECS}) o pide al usuario que lo haga desde TerView."
            ))),
            Err(AppError::Canceled) => Err(Fail::Error("Se canceló el análisis (y se detuvo en el servidor).".into())),
            Err(e) => Err(e.into()),
        }
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
