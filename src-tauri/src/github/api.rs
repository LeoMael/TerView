//! Llamadas concretas a la API REST de GitHub y sus tipos (espejo en `src/api/github.ts`).

use base64ct::{Base64, Encoding};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::http::{self, Resp};
use crate::error::{AppError, AppResult};

// ───────── Validación de nombres (evita construir rutas raras) ─────────

pub fn valid_login(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn valid_repo_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn check_repo(owner: &str, repo: &str) -> AppResult<()> {
    if valid_login(owner) && valid_repo_name(repo) {
        Ok(())
    } else {
        Err(AppError::Invalid("nombre de repositorio no válido".into()))
    }
}

pub fn valid_gist_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

// ───────── Cuenta ─────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAccount {
    pub login: String,
    pub name: Option<String>,
    pub html_url: String,
    /// Avatar como `data:` URL (la CSP de la interfaz no permite cargar imágenes de internet).
    pub avatar_data: Option<String>,
    pub public_repos: u64,
    pub private_repos: Option<u64>,
    /// "classic" | "fine-grained" | "oauth" | "other"
    pub token_kind: String,
    /// Permisos del token clásico (`X-OAuth-Scopes`). None en tokens de grano fino.
    pub scopes: Option<Vec<String>>,
    /// Caducidad del token, tal como la manda GitHub (p. ej. "2026-12-31 10:00:00 UTC").
    pub token_expires: Option<String>,
    pub rate_limit: Option<u64>,
    pub rate_remaining: Option<u64>,
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
    name: Option<String>,
    html_url: String,
    avatar_url: Option<String>,
    #[serde(default)]
    public_repos: u64,
    total_private_repos: Option<u64>,
}

pub fn token_kind(token: &str) -> &'static str {
    if token.starts_with("ghp_") {
        "classic"
    } else if token.starts_with("github_pat_") {
        "fine-grained"
    } else if token.starts_with("gho_") || token.starts_with("ghu_") {
        "oauth"
    } else {
        "other"
    }
}

/// Lista de permisos de `X-OAuth-Scopes` ("repo, gist" → ["repo","gist"]).
pub fn parse_scopes(header: Option<&str>) -> Option<Vec<String>> {
    header.map(|h| {
        h.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

pub async fn account(token: &str) -> AppResult<GhAccount> {
    let r = http::api(Some(token), Method::GET, "/user", None).await?;
    let u: RawUser = r.json()?;
    let num = |h: &str| r.header(h).and_then(|v| v.trim().parse::<u64>().ok());
    let avatar_data = match u.avatar_url.as_deref() {
        Some(url) => avatar(url).await.ok(),
        None => None,
    };
    Ok(GhAccount {
        login: u.login,
        name: u.name.filter(|n| !n.trim().is_empty()),
        html_url: u.html_url,
        avatar_data,
        public_repos: u.public_repos,
        private_repos: u.total_private_repos,
        token_kind: token_kind(token).into(),
        scopes: parse_scopes(r.header("x-oauth-scopes")),
        token_expires: r
            .header("github-authentication-token-expiration")
            .map(str::to_string),
        rate_limit: num("x-ratelimit-limit"),
        rate_remaining: num("x-ratelimit-remaining"),
    })
}

/// Descarga el avatar (pequeño) y lo devuelve como `data:` URL.
async fn avatar(url: &str) -> AppResult<String> {
    let sep = if url.contains('?') { '&' } else { '?' };
    let r = http::get_url(None, &format!("{url}{sep}s=96"), 512 * 1024).await?;
    let ct = r.header("content-type").unwrap_or("image/png").to_string();
    if !ct.starts_with("image/") {
        return Err(AppError::Invalid("el avatar no es una imagen".into()));
    }
    Ok(format!(
        "data:{ct};base64,{}",
        Base64::encode_string(&r.body)
    ))
}

// ───────── Llaves SSH de la cuenta ─────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhSshKey {
    pub id: u64,
    pub key: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, alias = "created_at")]
    pub created_at: Option<String>,
}

pub async fn my_keys(token: &str) -> AppResult<Vec<GhSshKey>> {
    http::api_json(Some(token), "/user/keys?per_page=100").await
}

/// Llaves públicas de cualquier usuario (no necesita token).
pub async fn user_keys(token: Option<&str>, login: &str) -> AppResult<Vec<GhSshKey>> {
    if !valid_login(login) {
        return Err(AppError::Invalid(
            "nombre de usuario de GitHub no válido".into(),
        ));
    }
    http::api_json(token, &format!("/users/{login}/keys")).await
}

pub async fn add_key(token: &str, title: &str, key: &str) -> AppResult<GhSshKey> {
    let body = json!({ "title": title, "key": key });
    http::api(Some(token), Method::POST, "/user/keys", Some(&body))
        .await?
        .json()
}

// ───────── Repositorios ─────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepo {
    #[serde(alias = "full_name")]
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub private: bool,
    pub archived: bool,
    pub fork: bool,
    pub default_branch: String,
    pub ssh_url: String,
    pub clone_url: String,
    pub html_url: String,
    pub description: Option<String>,
    pub pushed_at: Option<String>,
}

#[derive(Deserialize)]
struct RawOwner {
    login: String,
}

#[derive(Deserialize)]
struct RawRepo {
    full_name: String,
    name: String,
    owner: RawOwner,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    default_branch: Option<String>,
    ssh_url: String,
    clone_url: String,
    html_url: String,
    description: Option<String>,
    pushed_at: Option<String>,
}

impl From<RawRepo> for GhRepo {
    fn from(r: RawRepo) -> Self {
        GhRepo {
            full_name: r.full_name,
            name: r.name,
            owner: r.owner.login,
            private: r.private,
            archived: r.archived,
            fork: r.fork,
            default_branch: r.default_branch.unwrap_or_else(|| "main".into()),
            ssh_url: r.ssh_url,
            clone_url: r.clone_url,
            html_url: r.html_url,
            description: r.description,
            pushed_at: r.pushed_at,
        }
    }
}

pub fn parse_repos(body: &[u8]) -> AppResult<Vec<GhRepo>> {
    let raw: Vec<RawRepo> = serde_json::from_slice(body)
        .map_err(|e| AppError::Invalid(format!("respuesta de GitHub inesperada: {e}")))?;
    Ok(raw.into_iter().map(GhRepo::from).collect())
}

/// Repos del usuario (propios, de colaborador y de sus organizaciones), los más recientes primero.
/// Hasta 1000 (10 páginas).
pub async fn repos(token: &str) -> AppResult<Vec<GhRepo>> {
    let mut all = Vec::new();
    for page in 1..=10 {
        let r = http::api(
            Some(token),
            Method::GET,
            &format!("/user/repos?per_page=100&sort=pushed&page={page}"),
            None,
        )
        .await?;
        let list = parse_repos(&r.body)?;
        let n = list.len();
        all.extend(list);
        if n < 100 {
            break;
        }
    }
    Ok(all)
}

#[derive(Deserialize)]
struct RawBranch {
    name: String,
}

pub async fn branches(token: &str, owner: &str, repo: &str) -> AppResult<Vec<String>> {
    check_repo(owner, repo)?;
    let mut out = Vec::new();
    for page in 1..=5 {
        let list: Vec<RawBranch> = http::api_json(
            Some(token),
            &format!("/repos/{owner}/{repo}/branches?per_page=100&page={page}"),
        )
        .await?;
        let n = list.len();
        out.extend(list.into_iter().map(|b| b.name));
        if n < 100 {
            break;
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhDeployKey {
    pub id: u64,
    pub title: Option<String>,
    #[serde(default, alias = "read_only")]
    pub read_only: bool,
}

pub async fn add_deploy_key(
    token: &str,
    owner: &str,
    repo: &str,
    title: &str,
    key: &str,
    read_only: bool,
) -> AppResult<GhDeployKey> {
    check_repo(owner, repo)?;
    let body = json!({ "title": title, "key": key, "read_only": read_only });
    http::api(
        Some(token),
        Method::POST,
        &format!("/repos/{owner}/{repo}/keys"),
        Some(&body),
    )
    .await?
    .json()
}

// ───────── Actions ─────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhWorkflow {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: String,
    #[serde(alias = "html_url")]
    pub html_url: String,
}

#[derive(Deserialize)]
struct RawWorkflows {
    workflows: Vec<GhWorkflow>,
}

pub async fn workflows(token: &str, owner: &str, repo: &str) -> AppResult<Vec<GhWorkflow>> {
    check_repo(owner, repo)?;
    let r: RawWorkflows = http::api_json(
        Some(token),
        &format!("/repos/{owner}/{repo}/actions/workflows?per_page=100"),
    )
    .await?;
    Ok(r.workflows)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRun {
    pub id: u64,
    pub name: Option<String>,
    #[serde(alias = "display_title")]
    pub display_title: Option<String>,
    #[serde(alias = "workflow_id")]
    pub workflow_id: u64,
    #[serde(alias = "run_number")]
    pub run_number: u64,
    /// queued | in_progress | completed | waiting | requested | pending
    pub status: Option<String>,
    /// success | failure | cancelled | skipped | timed_out | action_required | neutral | stale
    pub conclusion: Option<String>,
    #[serde(alias = "head_branch")]
    pub head_branch: Option<String>,
    pub event: Option<String>,
    #[serde(alias = "html_url")]
    pub html_url: String,
    #[serde(alias = "created_at")]
    pub created_at: Option<String>,
    #[serde(alias = "updated_at")]
    pub updated_at: Option<String>,
}

#[derive(Deserialize)]
struct RawRuns {
    workflow_runs: Vec<GhRun>,
}

pub fn parse_runs(body: &[u8]) -> AppResult<Vec<GhRun>> {
    let r: RawRuns = serde_json::from_slice(body)
        .map_err(|e| AppError::Invalid(format!("respuesta de GitHub inesperada: {e}")))?;
    Ok(r.workflow_runs)
}

pub async fn runs(token: &str, owner: &str, repo: &str, limit: u32) -> AppResult<Vec<GhRun>> {
    check_repo(owner, repo)?;
    let n = limit.clamp(1, 100);
    let r = http::api(
        Some(token),
        Method::GET,
        &format!("/repos/{owner}/{repo}/actions/runs?per_page={n}"),
        None,
    )
    .await?;
    parse_runs(&r.body)
}

pub async fn dispatch(
    token: &str,
    owner: &str,
    repo: &str,
    workflow_id: u64,
    git_ref: &str,
    inputs: &serde_json::Map<String, serde_json::Value>,
) -> AppResult<()> {
    check_repo(owner, repo)?;
    if git_ref.trim().is_empty() {
        return Err(AppError::Invalid("indica la rama".into()));
    }
    let body = json!({ "ref": git_ref, "inputs": inputs });
    http::api(
        Some(token),
        Method::POST,
        &format!("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"),
        Some(&body),
    )
    .await?;
    Ok(())
}

// ───────── Gists ─────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhGistInfo {
    pub id: String,
    pub html_url: String,
    pub description: Option<String>,
    pub updated_at: Option<String>,
    pub public: bool,
    pub files: Vec<String>,
}

#[derive(Deserialize)]
pub struct RawGistFile {
    pub filename: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub truncated: bool,
    pub raw_url: Option<String>,
}

#[derive(Deserialize)]
pub struct RawGist {
    pub id: String,
    pub html_url: String,
    pub description: Option<String>,
    pub updated_at: Option<String>,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub files: serde_json::Map<String, serde_json::Value>,
}

impl RawGist {
    pub fn info(&self) -> GhGistInfo {
        GhGistInfo {
            id: self.id.clone(),
            html_url: self.html_url.clone(),
            description: self.description.clone(),
            updated_at: self.updated_at.clone(),
            public: self.public,
            files: self.files.keys().cloned().collect(),
        }
    }

    pub fn file(&self, name: &str) -> Option<RawGistFile> {
        self.files
            .get(name)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    /// Archivos en el orden en que vienen.
    pub fn all_files(&self) -> Vec<RawGistFile> {
        self.files
            .values()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect()
    }
}

pub async fn gists(token: &str) -> AppResult<Vec<RawGist>> {
    let mut all = Vec::new();
    for page in 1..=5 {
        let list: Vec<RawGist> =
            http::api_json(Some(token), &format!("/gists?per_page=100&page={page}")).await?;
        let n = list.len();
        all.extend(list);
        if n < 100 {
            break;
        }
    }
    Ok(all)
}

pub async fn gist(token: Option<&str>, id: &str) -> AppResult<RawGist> {
    if !valid_gist_id(id) {
        return Err(AppError::Invalid("identificador de gist no válido".into()));
    }
    http::api_json(token, &format!("/gists/{id}")).await
}

/// Contenido completo de un archivo de gist (si vino recortado, lo baja de `raw_url`).
pub async fn gist_file_content(token: Option<&str>, f: &RawGistFile) -> AppResult<String> {
    match (&f.content, f.truncated, &f.raw_url) {
        (Some(c), false, _) => Ok(c.clone()),
        (_, _, Some(raw)) => {
            let r: Resp = http::get_url(token, raw, http::MAX_BODY).await?;
            String::from_utf8(r.body)
                .map_err(|_| AppError::Invalid("el archivo no es texto".into()))
        }
        _ => Err(AppError::Invalid("el archivo del gist está vacío".into())),
    }
}

/// Crea un gist (o actualiza `id` si se da). `files`: nombre → contenido.
pub async fn save_gist(
    token: &str,
    id: Option<&str>,
    description: &str,
    public: bool,
    files: &[(&str, String)],
) -> AppResult<RawGist> {
    let mut map = serde_json::Map::new();
    for (name, content) in files {
        map.insert((*name).to_string(), json!({ "content": content }));
    }
    match id {
        Some(id) => {
            if !valid_gist_id(id) {
                return Err(AppError::Invalid("identificador de gist no válido".into()));
            }
            let body = json!({ "description": description, "files": map });
            http::api(
                Some(token),
                Method::PATCH,
                &format!("/gists/{id}"),
                Some(&body),
            )
            .await?
            .json()
        }
        None => {
            let body = json!({ "description": description, "public": public, "files": map });
            http::api(Some(token), Method::POST, "/gists", Some(&body))
                .await?
                .json()
        }
    }
}
