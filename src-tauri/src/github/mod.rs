//! Cuenta de GitHub dentro de SSHorus.
//!
//! - Autenticación con token personal (clásico o de grano fino) guardado SOLO en el llavero
//!   (servicio "sshorus", usuario "github-token"). Device flow preparado en `device.rs`.
//! - Todas las peticiones salen del motor (la CSP de la interfaz no deja conectarse a internet),
//!   con comandos concretos: no hay un proxy genérico de URLs.
//! - Lo que toca servidores (authorized_keys, clonar, desplegar) lo hace la interfaz con
//!   `exec_capture`; aquí solo está la parte de GitHub, la llave pública local y el cifrado.

pub mod api;
pub mod config;
pub mod crypto;
pub mod device;
pub mod http;
pub mod localkey;
pub mod share;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::storage::secrets;
use crate::types::Snippet;
use api::{GhAccount, GhDeployKey, GhGistInfo, GhRepo, GhRun, GhSshKey, GhWorkflow};
use config::{DeployRecipe, GhConfig};
use localkey::LocalPubKey;

/// Nombre del archivo cifrado dentro del gist de sincronización.
pub const SYNC_FILE: &str = "sshorus-sync.json";
const SYNC_DESCRIPTION: &str = "SSHorus: configuración cifrada (servidores, proyectos y comandos)";
const MAX_SYNC_PAYLOAD: usize = 4 * 1024 * 1024;

// ───────── Token (llavero + caché en memoria) ─────────

/// None = aún no se leyó el llavero; Some(None) = no hay token.
static TOKEN: Mutex<Option<Option<String>>> = Mutex::new(None);

fn cache_get() -> Option<Option<String>> {
    TOKEN.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn cache_set(v: Option<String>) {
    // Si se bloqueó mientras se leía, no se guarda la copia.
    if secrets::ensure_unlocked().is_err() {
        return;
    }
    *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(v);
}

/// Olvida el token guardado en memoria (al bloquear SSHorus o cambiar la bóveda).
/// La próxima vez se vuelve a leer de la bóveda o del llavero.
pub fn forget_token_cache() {
    *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("tarea interrumpida: {e}")))?
}

async fn stored_token() -> AppResult<Option<String>> {
    // Bloqueado: ni siquiera la copia en memoria (se borra al bloquear, pero por si acaso).
    secrets::ensure_unlocked()?;
    if let Some(t) = cache_get() {
        return Ok(t);
    }
    let t = blocking(secrets::get_github_token).await?;
    cache_set(t.clone());
    Ok(t)
}

async fn token() -> AppResult<String> {
    stored_token()
        .await?
        .ok_or_else(|| AppError::AuthFailed("no hay ninguna cuenta de GitHub conectada".into()))
}

/// Comprobación básica del texto pegado (sin mostrarlo nunca en errores).
fn check_token_text(t: &str) -> AppResult<()> {
    if t.len() < 20 || t.len() > 512 || !t.chars().all(|c| c.is_ascii_graphic()) {
        return Err(AppError::Invalid(
            "Eso no parece un token de GitHub (empiezan por «ghp_» o «github_pat_»)".into(),
        ));
    }
    Ok(())
}

async fn save_token(t: String) -> AppResult<()> {
    let tt = t.clone();
    blocking(move || secrets::set_github_token(&tt)).await?;
    cache_set(Some(t));
    Ok(())
}

// ───────── Cuenta ─────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub connected: bool,
    /// true si esta versión trae client_id para el inicio de sesión con código.
    pub device_flow: bool,
}

#[tauri::command]
pub async fn gh_status() -> AppResult<GhStatus> {
    Ok(GhStatus {
        connected: stored_token().await?.is_some(),
        device_flow: device::available(),
    })
}

/// Comprueba el token contra GitHub y, si vale, lo guarda en el llavero.
#[tauri::command]
pub async fn gh_connect(token: String) -> AppResult<GhAccount> {
    let t = token.trim().to_string();
    check_token_text(&t)?;
    let acc = api::account(&t).await?;
    save_token(t).await?;
    Ok(acc)
}

/// Borra el token del llavero.
#[tauri::command]
pub async fn gh_disconnect() -> AppResult<()> {
    blocking(secrets::delete_github_token).await?;
    cache_set(None);
    Ok(())
}

#[tauri::command]
pub async fn gh_account() -> AppResult<GhAccount> {
    api::account(&token().await?).await
}

#[tauri::command]
pub async fn gh_device_start() -> AppResult<device::DeviceCode> {
    device::start().await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePoll {
    /// "pending" | "slowDown" | "expired" | "denied" | "done"
    pub status: &'static str,
    pub account: Option<GhAccount>,
}

#[tauri::command]
pub async fn gh_device_poll(device_code: String) -> AppResult<DevicePoll> {
    let status = match device::poll(&device_code).await? {
        device::Poll::Pending => "pending",
        device::Poll::SlowDown => "slowDown",
        device::Poll::Expired => "expired",
        device::Poll::Denied => "denied",
        device::Poll::Token(t) => {
            let acc = api::account(&t).await?;
            save_token(t).await?;
            return Ok(DevicePoll {
                status: "done",
                account: Some(acc),
            });
        }
    };
    Ok(DevicePoll {
        status,
        account: None,
    })
}

// ───────── Llaves ─────────

#[tauri::command]
pub async fn gh_my_keys() -> AppResult<Vec<GhSshKey>> {
    api::my_keys(&token().await?).await
}

/// Llaves públicas de cualquier usuario de GitHub (no necesita cuenta conectada).
#[tauri::command]
pub async fn gh_user_keys(login: String) -> AppResult<Vec<GhSshKey>> {
    let t = stored_token().await.ok().flatten();
    api::user_keys(t.as_deref(), login.trim()).await
}

/// Sube una llave pública a tu cuenta de GitHub.
#[tauri::command]
pub async fn gh_add_key(title: String, key: String) -> AppResult<GhSshKey> {
    let (line, _, _) = localkey::parse_public_key_line(&key)?;
    let title = title.trim();
    let title = if title.is_empty() { "SSHorus" } else { title };
    api::add_key(&token().await?, title, &line).await
}

/// Llaves públicas válidas de `~/.ssh/*.pub`.
#[tauri::command]
pub async fn gh_local_pubkeys() -> AppResult<Vec<LocalPubKey>> {
    blocking(|| {
        Ok(localkey::ssh_dir()
            .map(|d| localkey::list_pub(&d))
            .unwrap_or_default())
    })
    .await
}

/// Lee UNA llave pública elegida por el usuario (solo archivos `.pub`).
#[tauri::command]
pub async fn gh_read_pubkey(path: String) -> AppResult<LocalPubKey> {
    blocking(move || localkey::read_pub(&PathBuf::from(path))).await
}

// ───────── Repositorios ─────────

#[tauri::command]
pub async fn gh_repos() -> AppResult<Vec<GhRepo>> {
    api::repos(&token().await?).await
}

#[tauri::command]
pub async fn gh_branches(owner: String, repo: String) -> AppResult<Vec<String>> {
    api::branches(&token().await?, &owner, &repo).await
}

/// Registra una llave de despliegue de SOLO LECTURA en el repo.
#[tauri::command]
pub async fn gh_add_deploy_key(
    owner: String,
    repo: String,
    title: String,
    key: String,
) -> AppResult<GhDeployKey> {
    let (line, _, _) = localkey::parse_public_key_line(&key)?;
    let title = title.trim();
    let title = if title.is_empty() { "SSHorus" } else { title };
    api::add_deploy_key(&token().await?, &owner, &repo, title, &line, true).await
}

// ───────── Actions ─────────

#[tauri::command]
pub async fn gh_workflows(owner: String, repo: String) -> AppResult<Vec<GhWorkflow>> {
    api::workflows(&token().await?, &owner, &repo).await
}

#[tauri::command]
pub async fn gh_runs(owner: String, repo: String, limit: u32) -> AppResult<Vec<GhRun>> {
    api::runs(&token().await?, &owner, &repo, limit).await
}

/// Lanza un workflow que tenga `on: workflow_dispatch`.
#[tauri::command]
pub async fn gh_dispatch(
    owner: String,
    repo: String,
    workflow_id: u64,
    git_ref: String,
    inputs: Option<serde_json::Map<String, Value>>,
) -> AppResult<()> {
    let inputs = inputs.unwrap_or_default();
    api::dispatch(
        &token().await?,
        &owner,
        &repo,
        workflow_id,
        git_ref.trim(),
        &inputs,
    )
    .await
}

// ───────── Recetas de despliegue (github.json) ─────────

#[tauri::command]
pub async fn gh_config_load() -> AppResult<GhConfig> {
    blocking(|| Ok(config::load())).await
}

#[tauri::command]
pub async fn gh_recipe_save(recipe: DeployRecipe) -> AppResult<DeployRecipe> {
    blocking(move || config::save_recipe(recipe)).await
}

#[tauri::command]
pub async fn gh_recipe_delete(id: String) -> AppResult<()> {
    blocking(move || config::delete_recipe(&id)).await
}

/// Anota el resultado de la última ejecución de una receta.
#[tauri::command]
pub async fn gh_recipe_mark(id: String, ok: bool) -> AppResult<()> {
    blocking(move || {
        config::update(|cfg| {
            if let Some(r) = cfg.recipes.iter_mut().find(|r| r.id == id) {
                r.last_ok = Some(ok);
                r.last_run_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_secs());
            }
            Ok(())
        })
    })
    .await
}

// ───────── Sincronizar configuración (gist privado cifrado) ─────────

/// Claves que nunca deben viajar en la copia (defensa en profundidad: la interfaz no las manda).
const FORBIDDEN_KEYS: &[&str] = &["password", "passphrase", "secret", "token", "privatekey"];

pub fn find_forbidden(v: &Value) -> Option<String> {
    match v {
        Value::Object(o) => o.iter().find_map(|(k, v)| {
            let lk = k.to_ascii_lowercase().replace(['_', '-'], "");
            if FORBIDDEN_KEYS.contains(&lk.as_str()) {
                Some(k.clone())
            } else {
                find_forbidden(v)
            }
        }),
        Value::Array(a) => a.iter().find_map(find_forbidden),
        _ => None,
    }
}

async fn find_sync_gists(token: &str) -> AppResult<Vec<GhGistInfo>> {
    let list = api::gists(token).await?;
    Ok(list
        .into_iter()
        .filter(|g| g.files.contains_key(SYNC_FILE))
        .map(|g| g.info())
        .collect())
}

/// Gists de la cuenta que contienen una copia de SSHorus.
#[tauri::command]
pub async fn gh_sync_find() -> AppResult<Vec<GhGistInfo>> {
    find_sync_gists(&token().await?).await
}

fn remember_gist(g: &GhGistInfo) -> AppResult<()> {
    let id = g.id.clone();
    let at = g.updated_at.clone();
    config::update(move |cfg| {
        cfg.sync_gist_id = Some(id);
        cfg.sync_updated_at = at;
        Ok(())
    })
}

/// Cifra `payload` con la frase y lo sube al gist privado (lo crea si no existe).
#[tauri::command]
pub async fn gh_sync_push(
    payload: Value,
    passphrase: String,
    gist_id: Option<String>,
) -> AppResult<GhGistInfo> {
    if !payload.is_object() {
        return Err(AppError::Invalid(
            "datos de sincronización no válidos".into(),
        ));
    }
    if let Some(k) = find_forbidden(&payload) {
        return Err(AppError::Invalid(format!(
            "la copia no puede incluir secretos (campo «{k}»)"
        )));
    }
    let plain = serde_json::to_vec(&payload)?;
    if plain.len() > MAX_SYNC_PAYLOAD {
        return Err(AppError::Invalid(
            "la configuración es demasiado grande para sincronizarla".into(),
        ));
    }
    let t = token().await?;
    let env = blocking(move || crypto::encrypt(&plain, &passphrase)).await?;
    let content = serde_json::to_string_pretty(&env)?;

    // Gist destino: el indicado, el recordado o uno existente con la copia (evita duplicados entre PCs).
    let mut target = gist_id
        .filter(|s| !s.trim().is_empty())
        .or_else(|| config::load().sync_gist_id);
    if target.is_none() {
        target = find_sync_gists(&t).await?.into_iter().next().map(|g| g.id);
    }
    let files = [(SYNC_FILE, content)];
    let saved = match target.as_deref() {
        Some(id) => match api::save_gist(&t, Some(id), SYNC_DESCRIPTION, false, &files).await {
            Err(AppError::NotFound(_)) => {
                api::save_gist(&t, None, SYNC_DESCRIPTION, false, &files).await?
            }
            other => other?,
        },
        None => api::save_gist(&t, None, SYNC_DESCRIPTION, false, &files).await?,
    };
    let info = saved.info();
    let i2 = info.clone();
    blocking(move || remember_gist(&i2)).await?;
    Ok(info)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPulled {
    pub gist: GhGistInfo,
    pub payload: Value,
}

/// Baja la copia del gist y la descifra (no toca nada local: la interfaz muestra la vista previa).
#[tauri::command]
pub async fn gh_sync_pull(passphrase: String, gist_id: Option<String>) -> AppResult<SyncPulled> {
    let t = token().await?;
    let mut id = gist_id
        .filter(|s| !s.trim().is_empty())
        .or_else(|| config::load().sync_gist_id);
    if id.is_none() {
        id = find_sync_gists(&t).await?.into_iter().next().map(|g| g.id);
    }
    let id = id
        .ok_or_else(|| AppError::NotFound("no hay ninguna copia de SSHorus en tus gists".into()))?;
    let g = api::gist(Some(&t), id.trim()).await?;
    let f = g
        .file(SYNC_FILE)
        .ok_or_else(|| AppError::NotFound(format!("el gist no contiene {SYNC_FILE}")))?;
    let text = api::gist_file_content(Some(&t), &f).await?;
    let env: crypto::Envelope = serde_json::from_str(&text)
        .map_err(|_| AppError::Invalid("el gist no contiene una copia de SSHorus válida".into()))?;
    let plain = blocking(move || crypto::decrypt(&env, &passphrase)).await?;
    let payload: Value = serde_json::from_slice(&plain)?;
    let info = g.info();
    let i2 = info.clone();
    blocking(move || remember_gist(&i2)).await?;
    Ok(SyncPulled {
        gist: info,
        payload,
    })
}

// ───────── Compartir comandos ─────────

/// Lee una colección de comandos de un gist o de un archivo de GitHub (vista previa; no guarda).
#[tauri::command]
pub async fn gh_fetch_snippets(source: String) -> AppResult<Vec<Snippet>> {
    let t = stored_token().await.ok().flatten();
    let text = match share::resolve(&source)? {
        share::Source::Gist(id) => {
            let g = api::gist(t.as_deref(), &id).await?;
            let files = g.all_files();
            let f = files
                .iter()
                .find(|f| {
                    f.filename
                        .as_deref()
                        .is_some_and(|n| n.to_ascii_lowercase().ends_with(".json"))
                })
                .or(files.first())
                .ok_or_else(|| AppError::NotFound("el gist está vacío".into()))?;
            api::gist_file_content(t.as_deref(), f).await?
        }
        share::Source::Raw(url) => {
            let r = http::get_url(t.as_deref(), &url, 2 * 1024 * 1024).await?;
            String::from_utf8(r.body)
                .map_err(|_| AppError::Invalid("el archivo no es texto".into()))?
        }
    };
    share::parse_collection(&text)
}

/// Publica una colección de comandos en un gist nuevo (secreto salvo `public`).
#[tauri::command]
pub async fn gh_share_snippets(
    snippets: Vec<Snippet>,
    description: String,
    public: bool,
) -> AppResult<GhGistInfo> {
    if snippets.is_empty() {
        return Err(AppError::Invalid("elige al menos un comando".into()));
    }
    if snippets.len() > share::MAX_SNIPPETS {
        return Err(AppError::Invalid("demasiados comandos".into()));
    }
    let content = share::to_collection(&snippets)?;
    let desc = description.trim();
    let desc = if desc.is_empty() {
        "Comandos de SSHorus"
    } else {
        desc
    };
    let g = api::save_gist(
        &token().await?,
        None,
        desc,
        public,
        &[("sshorus-comandos.json", content)],
    )
    .await?;
    Ok(g.info())
}
