//! Comandos Tauri del escáner. La interfaz ejecuta los scripts en el servidor (con su elevación) y
//! le pasa aquí las salidas; el motor consulta OSV, junta, guarda en el historial y exporta.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use super::analyze::analyze;
use super::cache::OsvCache;
use super::ecosystem;
use super::export;
use super::model::*;
use super::osv::{HttpOsv, OsvApi, OsvError, OsvVuln};
use super::parse::inventory::{self, StoreUser};
use super::scripts::{self, UserCtx};
use super::store::History;
use crate::error::{AppError, AppResult};

pub const PROGRESS_EVENT: &str = "vulnscan://progress";

/// Petición de un script (ver `scripts.rs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScriptRequest {
    Detect,
    Users,
    Inventory,
    #[serde(rename_all = "camelCase")]
    Distro { tool: DistroTool, codename: Option<String> },
    #[serde(rename_all = "camelCase")]
    Images { engine: Engine, user: Option<UserCtx> },
    #[serde(rename_all = "camelCase")]
    Image { engine: Engine, user: Option<UserCtx>, image_id: String, trivy: bool },
}

pub fn script_for(req: &ScriptRequest) -> String {
    match req {
        ScriptRequest::Detect => scripts::detect_script(),
        ScriptRequest::Users => scripts::users_script(),
        ScriptRequest::Inventory => scripts::inventory_script(),
        ScriptRequest::Distro { tool, codename } => scripts::distro_script(*tool, codename.as_deref().unwrap_or("")),
        ScriptRequest::Images { engine, user } => scripts::images_list_script(*engine, user.as_ref()),
        ScriptRequest::Image { engine, user, image_id, trivy } => scripts::image_script(*engine, user.as_ref(), image_id, *trivy),
    }
}

#[tauri::command]
pub async fn vulnscan_script(req: ScriptRequest) -> AppResult<String> {
    Ok(script_for(&req))
}

/// Qué hacer después de la fase 1 (lo decide el motor para que interfaz y MCP hagan lo mismo).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPlan {
    pub os: String,
    pub ecosystem: Option<String>,
    pub distro_tool: Option<DistroTool>,
    pub codename: String,
    pub trivy: Option<String>,
    pub podman: bool,
    /// Docker responde para el usuario conectado.
    pub docker: bool,
    pub user: String,
    pub is_root: bool,
    pub in_container: bool,
    pub complete: bool,
}

pub fn plan_from(detect_stdout: &str) -> ScanPlan {
    let d = inventory::parse_detect(detect_stdout);
    ScanPlan {
        os: d.os.display(),
        ecosystem: ecosystem::for_os(&d.os),
        distro_tool: ecosystem::distro_tool(&d),
        codename: d.os.version_codename.clone(),
        trivy: d.trivy_version.clone().or_else(|| d.has("trivy").then(|| "?".into())),
        podman: d.has("podman"),
        docker: d.has("docker") && d.docker_ok,
        user: d.user.clone(),
        is_root: d.uid == Some(0),
        in_container: d.in_container,
        complete: d.complete,
    }
}

#[tauri::command]
pub async fn vulnscan_plan(detect: String) -> AppResult<ScanPlan> {
    Ok(plan_from(&detect))
}

/// Usuarios con almacén de contenedores (salida de `users_script`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsersView {
    pub users: Vec<StoreUser>,
    pub root_podman: bool,
    pub root_docker: bool,
}

#[tauri::command]
pub async fn vulnscan_parse_users(output: String) -> AppResult<UsersView> {
    let u = inventory::parse_users(&output);
    Ok(UsersView { users: u.users, root_podman: u.root_podman, root_docker: u.root_docker })
}

/// Imágenes que se van a leer, en orden: primero las que usan contenedores, luego las etiquetadas.
/// Las que no tienen etiqueta ni contenedores no se leen (restos de compilaciones).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagesView {
    pub selected: Vec<ImageInfo>,
    pub total: usize,
    pub error: Option<String>,
}

pub fn select_images(engine: Engine, output: &str, limit: usize) -> ImagesView {
    let l = inventory::parse_images(engine, output);
    let total = l.images.len();
    let mut imgs: Vec<ImageInfo> = l.images.into_iter().filter(|i| !i.tags.is_empty() || !i.containers.is_empty()).collect();
    imgs.sort_by_key(|i| (i.containers.is_empty(), i.tags.is_empty()));
    imgs.truncate(limit.max(1));
    ImagesView { selected: imgs, total, error: l.error }
}

#[tauri::command]
pub async fn vulnscan_parse_images(engine: Engine, output: String, limit: u32) -> AppResult<ImagesView> {
    Ok(select_images(engine, &output, limit as usize))
}

// ───────────── Análisis (fases 5 y 6) ─────────────

fn running() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static R: std::sync::OnceLock<Mutex<HashMap<String, CancellationToken>>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registro de un análisis en curso (se quita al soltarlo).
pub struct ScanTicket {
    id: String,
    pub token: CancellationToken,
}

impl ScanTicket {
    pub fn new(id: &str) -> Self {
        let token = CancellationToken::new();
        if let Ok(mut m) = running().lock() {
            m.insert(id.to_string(), token.clone());
        }
        ScanTicket { id: id.to_string(), token }
    }
}

impl Drop for ScanTicket {
    fn drop(&mut self) {
        if let Ok(mut m) = running().lock() {
            m.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub scan_id: String,
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub text: String,
}

/// Fases 5 y 6 + guardar en el historial. Reutilizable sin Tauri (MCP): ver `scan::scan_session`.
pub async fn analyze_and_save(
    input: &ScanInput,
    cancel: &CancellationToken,
    progress: super::analyze::ProgressFn<'_>,
    save: bool,
) -> AppResult<Report> {
    let cache = OsvCache::system();
    cache.clean_old();
    let api = HttpOsv::default();
    let report = analyze(input, input.use_osv.then_some(&api), &cache, cancel, progress).await?;
    if save {
        History::system().save(&report)?;
    }
    Ok(report)
}

/// Analiza lo recogido por la interfaz, lo guarda en el historial y lo devuelve.
/// El progreso llega por el evento `vulnscan://progress`; se cancela con `vulnscan_cancel(scan_id)`.
#[tauri::command]
pub async fn vulnscan_analyze(app: AppHandle, input: ScanInput, scan_id: String) -> AppResult<Report> {
    let ticket = ScanTicket::new(&scan_id);
    let sid = scan_id.clone();
    let emit = move |phase: &str, done: usize, total: usize, text: &str| {
        let _ = app.emit(
            PROGRESS_EVENT,
            ProgressPayload { scan_id: sid.clone(), phase: phase.into(), done, total, text: text.into() },
        );
    };
    analyze_and_save(&input, &ticket.token, &emit, true).await
}

/// Cancela las peticiones a OSV de un análisis. false si ya terminó.
#[tauri::command]
pub async fn vulnscan_cancel(scan_id: String) -> AppResult<bool> {
    let m = running().lock().map_err(|_| AppError::Invalid("registro bloqueado".into()))?;
    Ok(match m.get(&scan_id) {
        Some(t) => {
            t.cancel();
            true
        }
        None => false,
    })
}

// ───────────── Historial ─────────────

#[tauri::command]
pub async fn vulnscan_history_list(server_id: String) -> AppResult<Vec<ReportMeta>> {
    History::system().list(&server_id)
}

#[tauri::command]
pub async fn vulnscan_history_get(server_id: String, report_id: String) -> AppResult<Report> {
    History::system().get(&server_id, &report_id)
}

/// Último informe del servidor (None si nunca se analizó).
#[tauri::command]
pub async fn vulnscan_latest(server_id: String) -> AppResult<Option<Report>> {
    History::system().latest(&server_id)
}

/// Borra un análisis (o todo el historial del servidor si `report_id` no viene).
#[tauri::command]
pub async fn vulnscan_history_delete(server_id: String, report_id: Option<String>) -> AppResult<()> {
    History::system().delete(&server_id, report_id.as_deref())
}

/// Guarda la explicación de la IA junto al análisis (None la quita).
#[tauri::command]
pub async fn vulnscan_set_ai(server_id: String, report_id: String, ai: Option<AiExplanation>) -> AppResult<Report> {
    History::system().set_ai(&server_id, &report_id, ai)
}

/// Exporta un análisis a `path` (ruta completa elegida con el diálogo del sistema).
/// `format`: "json" | "markdown". `server_name` None = no ponerlo («servidor-1»).
#[tauri::command]
pub async fn vulnscan_export(
    server_id: String,
    report_id: String,
    path: String,
    format: String,
    server_name: Option<String>,
) -> AppResult<()> {
    let report = History::system().get(&server_id, &report_id)?;
    let text = match format.as_str() {
        "json" => export::to_json(&report, server_name.is_none()),
        "markdown" | "md" => export::to_markdown(&report, server_name.as_deref()),
        _ => return Err(AppError::Invalid("Formato desconocido (usa json o markdown)".into())),
    };
    let p = std::path::PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err(AppError::Invalid("La ruta debe ser completa".into()));
    }
    tokio::task::spawn_blocking(move || crate::localfs::write_text(&p, &text))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

/// Detalle de un aviso (caché de OSV o, si no está, la API).
#[tauri::command]
pub async fn vulnscan_vuln_detail(id: String) -> AppResult<VulnDetail> {
    let cache = OsvCache::system();
    let value = match cache.get(&id, None) {
        Some(v) => v,
        None => {
            let api = HttpOsv::default();
            let v = api.vuln(&id).await.map_err(|e| match e {
                OsvError::NotFound => AppError::NotFound(format!("{id} en OSV")),
                e => e.into(),
            })?;
            if let Some(m) = v.get("modified").and_then(|m| m.as_str()) {
                cache.put(&id, m, &v);
            }
            v
        }
    };
    let v: OsvVuln = serde_json::from_value(value).map_err(|e| AppError::Invalid(format!("aviso de OSV inesperado: {e}")))?;
    Ok(VulnDetail {
        id: v.id.clone(),
        summary: v.summary.clone(),
        details: v.details.clone(),
        aliases: v.aliases.iter().chain(&v.upstream).cloned().collect(),
        published: v.published.clone(),
        modified: v.modified.clone(),
        references: v.reference_urls(),
    })
}
