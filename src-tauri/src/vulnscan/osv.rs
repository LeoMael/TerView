//! Cliente de OSV.dev (https://api.osv.dev, sin cuenta ni token).
//!
//! Reglas de la API (probadas, PENDIENTES 10.2):
//! - `POST /v1/querybatch`: como mucho 1000 consultas; devuelve solo `id` y `modified` por paquete, en
//!   el mismo orden. Si una consulta pasa de 1000 resultados llega `next_page_token` y se repite SOLO
//!   esa consulta con el token.
//! - Un ecosistema inválido tumba el lote entero (`400`): entonces se reparte el lote por ecosistema
//!   para que los demás sigan.
//! - `GET /v1/vulns/{id}`: el detalle, que se guarda en la caché por `id` + `modified`.
//!
//! Solo se envía `{ecosistema, nombre, versión}`; nunca datos del servidor.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::cache::OsvCache;
use super::parse::{is_cve, rpm::strip_epoch};
use crate::error::{AppError, AppResult};

pub const BASE: &str = "https://api.osv.dev";
pub const MAX_BATCH: usize = 1000;
/// Rondas de paginación como máximo (cada una pide solo lo pendiente).
const MAX_ROUNDS: usize = 30;
const DETAIL_PARALLEL: usize = 8;
const DETAIL_TIMEOUT: Duration = Duration::from_secs(25);
const BATCH_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BODY: u64 = 64 * 1024 * 1024;

/// Una consulta: lo único que viaja a OSV.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Query {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Hit {
    pub id: String,
    #[serde(default)]
    pub modified: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct BatchItem {
    #[serde(default)]
    pub vulns: Vec<Hit>,
    #[serde(default)]
    pub next_page_token: Option<String>,
}

#[derive(Debug)]
pub enum OsvError {
    /// 400: consulta inválida (ecosistema desconocido, demasiadas consultas…).
    BadRequest(String),
    /// 404 al pedir un aviso.
    NotFound,
    Other(AppError),
}

impl From<OsvError> for AppError {
    fn from(e: OsvError) -> Self {
        match e {
            OsvError::BadRequest(m) => AppError::Invalid(format!("OSV rechazó la consulta: {m}")),
            OsvError::NotFound => AppError::NotFound("ese aviso en OSV".into()),
            OsvError::Other(e) => e,
        }
    }
}

/// Lo que hace falta de OSV (la red real o una falsa en pruebas).
pub trait OsvApi: Send + Sync {
    /// Una petición `querybatch` (≤ 1000). Cada consulta puede llevar su `page_token`.
    fn querybatch(&self, queries: &[(Query, Option<String>)]) -> impl Future<Output = Result<Vec<BatchItem>, OsvError>> + Send;
    fn vuln(&self, id: &str) -> impl Future<Output = Result<Value, OsvError>> + Send;
}

/// Cliente HTTPS real (reqwest + rustls). Solo habla con `api.osv.dev`.
pub struct HttpOsv {
    base: String,
}

impl Default for HttpOsv {
    fn default() -> Self {
        HttpOsv { base: BASE.to_string() }
    }
}

fn client() -> AppResult<&'static Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = Client::builder()
        .user_agent("TerView")
        .connect_timeout(Duration::from_secs(10))
        .https_only(true)
        // Sin redirecciones: el host es fijo.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Network(format!("no se pudo preparar la conexión segura: {e}")))?;
    Ok(CLIENT.get_or_init(|| c))
}

fn net_err(e: reqwest::Error) -> OsvError {
    if e.is_timeout() {
        OsvError::Other(AppError::Network("OSV.dev no respondió a tiempo".into()))
    } else {
        OsvError::Other(AppError::Network(format!("no se pudo hablar con OSV.dev: {}", e.without_url())))
    }
}

async fn read_body(resp: reqwest::Response) -> Result<(StatusCode, Vec<u8>), OsvError> {
    let status = resp.status();
    if resp.content_length().is_some_and(|n| n > MAX_BODY) {
        return Err(OsvError::Other(AppError::Network("respuesta de OSV demasiado grande".into())));
    }
    let body = resp.bytes().await.map_err(net_err)?;
    if body.len() as u64 > MAX_BODY {
        return Err(OsvError::Other(AppError::Network("respuesta de OSV demasiado grande".into())));
    }
    Ok((status, body.to_vec()))
}

fn status_err(status: StatusCode, body: &[u8]) -> OsvError {
    let msg = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(body).chars().take(200).collect());
    match status {
        StatusCode::BAD_REQUEST => OsvError::BadRequest(msg),
        StatusCode::NOT_FOUND => OsvError::NotFound,
        s => OsvError::Other(AppError::Network(format!("OSV.dev respondió {s}: {msg}"))),
    }
}

#[derive(Serialize)]
struct BatchBody<'a> {
    queries: Vec<BatchQuery<'a>>,
}

#[derive(Serialize)]
struct BatchQuery<'a> {
    package: BatchPkg<'a>,
    version: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_token: Option<&'a str>,
}

#[derive(Serialize)]
struct BatchPkg<'a> {
    ecosystem: &'a str,
    name: &'a str,
}

#[derive(Deserialize)]
struct BatchResp {
    #[serde(default)]
    results: Vec<BatchItem>,
}

impl OsvApi for HttpOsv {
    async fn querybatch(&self, queries: &[(Query, Option<String>)]) -> Result<Vec<BatchItem>, OsvError> {
        let body = BatchBody {
            queries: queries
                .iter()
                .map(|(q, t)| BatchQuery {
                    package: BatchPkg { ecosystem: &q.ecosystem, name: &q.name },
                    version: &q.version,
                    page_token: t.as_deref(),
                })
                .collect(),
        };
        let resp = client()
            .map_err(OsvError::Other)?
            .post(format!("{}/v1/querybatch", self.base))
            .timeout(BATCH_TIMEOUT)
            .json(&body)
            .send()
            .await
            .map_err(net_err)?;
        let (status, body) = read_body(resp).await?;
        if !status.is_success() {
            return Err(status_err(status, &body));
        }
        let r: BatchResp = serde_json::from_slice(&body)
            .map_err(|e| OsvError::Other(AppError::Invalid(format!("respuesta de OSV inesperada: {e}"))))?;
        if r.results.len() != queries.len() {
            return Err(OsvError::Other(AppError::Invalid("OSV devolvió un número de resultados distinto al pedido".into())));
        }
        Ok(r.results)
    }

    async fn vuln(&self, id: &str) -> Result<Value, OsvError> {
        // El id va en la ruta: solo caracteres seguros (los ids de OSV llevan letras, números, «-», «:», «.», «_»).
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '.' | '_')) {
            return Err(OsvError::BadRequest(format!("id no válido: {id}")));
        }
        let resp = client()
            .map_err(OsvError::Other)?
            .get(format!("{}/v1/vulns/{id}", self.base))
            .timeout(DETAIL_TIMEOUT)
            .send()
            .await
            .map_err(net_err)?;
        let (status, body) = read_body(resp).await?;
        if !status.is_success() {
            return Err(status_err(status, &body));
        }
        serde_json::from_slice(&body).map_err(|e| OsvError::Other(AppError::Invalid(format!("aviso de OSV inesperado: {e}"))))
    }
}

/// Resultado de consultar todo: los ids de cada consulta (mismo orden) y los avisos del proceso.
#[derive(Debug, Default)]
pub struct BatchOutcome {
    pub hits: Vec<Vec<Hit>>,
    /// Ecosistemas que OSV rechazó (sus consultas quedan sin resultado).
    pub rejected: BTreeSet<String>,
    pub requests: usize,
}

/// Consulta todas las `queries` en lotes de 1000, con paginación y reparto por ecosistema si OSV
/// rechaza un lote. Error solo si OSV no responde (red).
pub async fn query_all<A: OsvApi>(api: &A, queries: &[Query], cancel: &CancellationToken) -> AppResult<BatchOutcome> {
    let mut out = BatchOutcome { hits: vec![Vec::new(); queries.len()], ..Default::default() };
    let mut pending: Vec<(usize, Option<String>)> = (0..queries.len()).map(|i| (i, None)).collect();
    let mut rounds = 0;
    while !pending.is_empty() && rounds < MAX_ROUNDS {
        rounds += 1;
        let mut next: Vec<(usize, Option<String>)> = Vec::new();
        for chunk in pending.chunks(MAX_BATCH) {
            if cancel.is_cancelled() {
                return Err(AppError::Canceled);
            }
            run_chunk(api, queries, chunk, &mut out, &mut next, true).await?;
        }
        pending = next;
    }
    Ok(out)
}

async fn run_chunk<A: OsvApi>(
    api: &A,
    queries: &[Query],
    chunk: &[(usize, Option<String>)],
    out: &mut BatchOutcome,
    next: &mut Vec<(usize, Option<String>)>,
    may_split: bool,
) -> AppResult<()> {
    let body: Vec<(Query, Option<String>)> = chunk.iter().map(|(i, t)| (queries[*i].clone(), t.clone())).collect();
    out.requests += 1;
    match api.querybatch(&body).await {
        Ok(items) => {
            for ((i, _), item) in chunk.iter().zip(items) {
                out.hits[*i].extend(item.vulns);
                if let Some(t) = item.next_page_token.filter(|t| !t.is_empty()) {
                    next.push((*i, Some(t)));
                }
            }
            Ok(())
        }
        Err(OsvError::BadRequest(msg)) => {
            let ecos: BTreeSet<&str> = chunk.iter().map(|(i, _)| queries[*i].ecosystem.as_str()).collect();
            if may_split && ecos.len() > 1 {
                for eco in ecos {
                    let part: Vec<(usize, Option<String>)> =
                        chunk.iter().filter(|(i, _)| queries[*i].ecosystem == eco).cloned().collect();
                    Box::pin(run_chunk(api, queries, &part, out, next, false)).await?;
                }
                Ok(())
            } else {
                log::warn!("OSV rechazó un lote ({msg})");
                for e in ecos {
                    out.rejected.insert(e.to_string());
                }
                Ok(())
            }
        }
        Err(OsvError::NotFound) => Ok(()),
        Err(OsvError::Other(e)) => Err(e),
    }
}

/// Pide el detalle de cada id (caché primero), 8 a la vez. Devuelve los que se pudieron leer y
/// cuántos fallaron. `progress(hechos, total)`.
pub async fn fetch_details<A: OsvApi>(
    api: &A,
    cache: &OsvCache,
    ids: &[(String, String)],
    cancel: &CancellationToken,
    progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> AppResult<(HashMap<String, OsvVuln>, usize)> {
    let total = ids.len();
    let mut out = HashMap::new();
    let mut failed = 0usize;
    let mut todo: Vec<(String, String)> = Vec::new();
    for (id, modified) in ids {
        match cache.get(id, Some(modified).filter(|m| !m.is_empty()).map(String::as_str)) {
            Some(v) => {
                if let Ok(x) = serde_json::from_value::<OsvVuln>(v) {
                    out.insert(id.clone(), x);
                }
            }
            None => todo.push((id.clone(), modified.clone())),
        }
    }
    let cached = out.len();
    progress(cached, total);
    let mut done = cached;
    let mut s = stream::iter(todo.into_iter().map(|(id, modified)| async move {
        let r = api.vuln(&id).await;
        (id, modified, r)
    }))
    .buffer_unordered(DETAIL_PARALLEL);
    loop {
        let next = tokio::select! {
            () = cancel.cancelled() => return Err(AppError::Canceled),
            n = s.next() => n,
        };
        let Some((id, modified, r)) = next else { break };
        done += 1;
        match r {
            Ok(v) => {
                let m = v.get("modified").and_then(|m| m.as_str()).map(str::to_string).unwrap_or(modified);
                cache.put(&id, &m, &v);
                if let Ok(x) = serde_json::from_value::<OsvVuln>(v) {
                    out.insert(id, x);
                } else {
                    failed += 1;
                }
            }
            Err(OsvError::Other(e)) if matches!(e, AppError::Network(_)) && done == cached + 1 && failed == 0 => {
                // La primera petición ya falla por red: OSV no está disponible.
                return Err(e);
            }
            Err(_) => failed += 1,
        }
        if done % 8 == 0 || done == total {
            progress(done, total);
        }
    }
    Ok((out, failed))
}

// ───────────── Formato de un aviso (lo que se usa) ─────────────

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SevEntry {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub score: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AffPkg {
    #[serde(default)]
    pub ecosystem: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Range {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub events: Vec<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Affected {
    #[serde(default)]
    pub package: Option<AffPkg>,
    #[serde(default)]
    pub ranges: Vec<Range>,
    #[serde(default)]
    pub ecosystem_specific: Option<Value>,
    #[serde(default)]
    pub database_specific: Option<Value>,
    #[serde(default)]
    pub severity: Vec<SevEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Reference {
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct OsvVuln {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub upstream: Vec<String>,
    #[serde(default)]
    pub related: Vec<String>,
    #[serde(default)]
    pub modified: Option<String>,
    #[serde(default)]
    pub published: Option<String>,
    #[serde(default)]
    pub severity: Vec<SevEntry>,
    #[serde(default)]
    pub affected: Vec<Affected>,
    #[serde(default)]
    pub database_specific: Option<Value>,
    #[serde(default)]
    pub references: Vec<Reference>,
}

/// Compara versiones «a lo natural»: números como números, texto como texto, «~» antes que nada
/// (Debian). Sirve para elegir la versión que arregla de entre varias ramas; OSV ya decidió si afecta.
pub fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a = strip_epoch(a);
    let b = strip_epoch(b);
    let (mut x, mut y) = (a.as_bytes(), b.as_bytes());
    loop {
        match (x.first(), y.first()) {
            (None, None) => return Ordering::Equal,
            (Some(b'~'), _) if y.first() != Some(&b'~') => return Ordering::Less,
            (_, Some(b'~')) if x.first() != Some(&b'~') => return Ordering::Greater,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let nx = x.iter().take_while(|c| c.is_ascii_digit()).count();
                let ny = y.iter().take_while(|c| c.is_ascii_digit()).count();
                let sx = std::str::from_utf8(&x[..nx]).unwrap_or("0").trim_start_matches('0');
                let sy = std::str::from_utf8(&y[..ny]).unwrap_or("0").trim_start_matches('0');
                let o = sx.len().cmp(&sy.len()).then_with(|| sx.cmp(sy));
                if o != Ordering::Equal {
                    return o;
                }
                x = &x[nx..];
                y = &y[ny..];
            }
            (Some(c), Some(d)) => {
                if c != d {
                    // Un número va después que un separador o una letra.
                    return match (c.is_ascii_digit(), d.is_ascii_digit()) {
                        (true, false) => Ordering::Greater,
                        (false, true) => Ordering::Less,
                        _ => c.cmp(d),
                    };
                }
                x = &x[1..];
                y = &y[1..];
            }
        }
    }
}

impl OsvVuln {
    /// CVE de este aviso: él mismo si es CVE, más los de `upstream`, `aliases` y `related`.
    pub fn cves(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut add = |s: &str| {
            if is_cve(s) && !out.iter().any(|x| x == s) {
                out.push(s.to_string());
            }
        };
        add(&self.id);
        for s in self.upstream.iter().chain(&self.aliases).chain(&self.related) {
            add(s);
        }
        out
    }

    /// Otros ids que no son CVE (DEBIAN-CVE-…, BIT-…, GHSA-…, USN-…).
    pub fn other_ids(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in std::iter::once(&self.id).chain(&self.upstream).chain(&self.aliases) {
            if !is_cve(s) && !out.contains(s) {
                out.push(s.clone());
            }
        }
        out
    }

    pub fn affected_for(&self, eco: &str, name: &str) -> Option<&Affected> {
        self.affected.iter().find(|a| a.package.as_ref().is_some_and(|p| p.ecosystem == eco && p.name == name)).or_else(|| {
            // Algunos avisos usan otro nombre (binario) para el mismo ecosistema: vale el primero del ecosistema.
            self.affected.iter().find(|a| a.package.as_ref().is_some_and(|p| p.ecosystem == eco))
        })
    }

    /// Versión que lo arregla (de entre los `fixed` del ecosistema, la menor por encima de la instalada).
    pub fn fixed_for(&self, eco: &str, name: &str, installed: &str) -> Option<String> {
        let a = self.affected_for(eco, name)?;
        let mut fixes: Vec<String> = a
            .ranges
            .iter()
            .filter(|r| r.kind != "GIT")
            .flat_map(|r| r.events.iter())
            .filter_map(|e| e.get("fixed").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        fixes.sort_by(|x, y| cmp_versions(x, y));
        fixes.dedup();
        let pick = fixes
            .iter()
            .find(|f| cmp_versions(f, installed) == std::cmp::Ordering::Greater)
            .or_else(|| fixes.last())?;
        let pick = if pick.starts_with("0:") { pick.trim_start_matches("0:") } else { pick };
        Some(pick.to_string())
    }

    /// Gravedad según la distro o la base (texto original).
    pub fn distro_severity(&self, eco: &str, name: &str) -> Option<String> {
        let a = self.affected_for(eco, name);
        let get_str = |v: Option<&Value>, k: &str| v.and_then(|v| v.get(k)).and_then(|s| s.as_str()).map(str::to_string);
        // Debian: affected[].ecosystem_specific.urgency
        if let Some(u) = get_str(a.and_then(|a| a.ecosystem_specific.as_ref()), "urgency") {
            return Some(u);
        }
        // Ubuntu: severity[].type == "Ubuntu"
        if let Some(s) = self.severity.iter().chain(a.map(|a| a.severity.iter()).into_iter().flatten()).find(|s| s.kind == "Ubuntu") {
            return Some(s.score.clone());
        }
        // Rocky/Alma/Red Hat: «Moderate: curl security update»
        if let Some(s) = self.summary.as_deref().and_then(super::severity::from_summary_prefix) {
            return Some(s);
        }
        // Bitnami, GitHub: database_specific.severity
        get_str(self.database_specific.as_ref(), "severity")
            .or_else(|| get_str(a.and_then(|a| a.ecosystem_specific.as_ref()), "severity"))
            .or_else(|| get_str(a.and_then(|a| a.database_specific.as_ref()), "severity"))
    }

    /// Mayor puntuación CVSS (v3 primero; v4 o v2 si no hay v3) y su vector.
    pub fn cvss(&self, eco: &str, name: &str) -> Option<(f64, String)> {
        let a = self.affected_for(eco, name);
        let all: Vec<&SevEntry> = self.severity.iter().chain(a.map(|a| a.severity.iter()).into_iter().flatten()).collect();
        for kind in ["CVSS_V3", "CVSS_V4", "CVSS_V2"] {
            let best = all
                .iter()
                .filter(|s| s.kind == kind)
                .filter_map(|s| super::severity::cvss_score(&s.score).map(|n| (n, s.score.clone())))
                .max_by(|x, y| x.0.total_cmp(&y.0));
            if best.is_some() {
                return best;
            }
        }
        None
    }

    /// Título corto: `summary` o el principio de `details`.
    pub fn title(&self) -> Option<String> {
        let s = self.summary.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let s = s.map(str::to_string).or_else(|| {
            let d = self.details.as_deref()?.trim();
            let first = d.split("\n\n").next().unwrap_or(d);
            Some(first.to_string()).filter(|x| !x.is_empty())
        })?;
        Some(super::parse::short(&s, 200))
    }

    pub fn reference_urls(&self) -> Vec<String> {
        self.references.iter().filter(|r| r.url.starts_with("https://") || r.url.starts_with("http://")).map(|r| r.url.clone()).take(20).collect()
    }
}

/// Ids únicos con su `modified`, en orden estable.
pub fn unique_ids(hits: &[Vec<Hit>]) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for h in hits.iter().flatten() {
        if seen.insert(h.id.clone()) {
            out.push((h.id.clone(), h.modified.clone()));
        }
    }
    out
}
