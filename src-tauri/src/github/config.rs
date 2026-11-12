//! `<config_dir>/terview/github.json`: recetas de despliegue y el gist de sincronización.
//! Nunca guarda el token (ese va solo al llavero).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::storage::fsutil;

/// Receta de despliegue de un proyecto en un servidor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeployRecipe {
    /// "" al crear; el motor asigna un UUID.
    pub id: String,
    pub name: String,
    /// Servidor guardado (ServerProfile.id).
    pub server_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    /// "dueño/repo" (opcional; solo informativo y para ver Actions).
    #[serde(default)]
    pub repo: Option<String>,
    /// Carpeta del repo clonado en el servidor.
    pub path: String,
    pub branch: String,
    /// Comandos posteriores, uno por línea (p. ej. `podman compose up -d --build`).
    #[serde(default)]
    pub commands: String,
    /// Llave de despliegue en el servidor (ruta), si el repo es privado.
    #[serde(default)]
    pub deploy_key: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    #[serde(default)]
    pub last_ok: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhConfig {
    #[serde(default)]
    pub recipes: Vec<DeployRecipe>,
    /// Gist privado donde se guarda la copia cifrada.
    #[serde(default)]
    pub sync_gist_id: Option<String>,
    #[serde(default)]
    pub sync_updated_at: Option<String>,
}

static LOCK: Mutex<()> = Mutex::new(());

pub fn default_path() -> Option<PathBuf> {
    fsutil::config_dir().map(|d| d.join("github.json"))
}

fn path() -> AppResult<PathBuf> {
    default_path()
        .ok_or_else(|| AppError::Io("el sistema no tiene carpeta de configuración".into()))
}

pub fn load_from(p: &Path) -> GhConfig {
    fsutil::read_json_or_default(p)
}

/// Lee, modifica y guarda (atómico) bajo un candado de proceso.
pub fn update_at<R>(p: &Path, f: impl FnOnce(&mut GhConfig) -> AppResult<R>) -> AppResult<R> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cfg = load_from(p);
    let r = f(&mut cfg)?;
    fsutil::write_json_atomic(p, &cfg)?;
    Ok(r)
}

pub fn load() -> GhConfig {
    match default_path() {
        Some(p) => {
            let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
            load_from(&p)
        }
        None => GhConfig::default(),
    }
}

pub fn update<R>(f: impl FnOnce(&mut GhConfig) -> AppResult<R>) -> AppResult<R> {
    update_at(&path()?, f)
}

fn clean(s: &str) -> String {
    s.trim().to_string()
}

/// Valida y normaliza una receta antes de guardarla.
pub fn normalize(mut r: DeployRecipe) -> AppResult<DeployRecipe> {
    r.name = clean(&r.name);
    r.path = clean(&r.path);
    r.branch = clean(&r.branch);
    r.server_id = clean(&r.server_id);
    r.repo = r.repo.map(|s| clean(&s)).filter(|s| !s.is_empty());
    r.project_id = r.project_id.map(|s| clean(&s)).filter(|s| !s.is_empty());
    r.deploy_key = r.deploy_key.map(|s| clean(&s)).filter(|s| !s.is_empty());
    r.commands = r.commands.replace("\r\n", "\n").trim().to_string();
    if r.name.is_empty() {
        return Err(AppError::Invalid("Ponle un nombre a la receta".into()));
    }
    if r.server_id.is_empty() {
        return Err(AppError::Invalid("Elige el servidor".into()));
    }
    if r.path.is_empty() || r.path.contains('\n') {
        return Err(AppError::Invalid(
            "Indica la carpeta del proyecto en el servidor".into(),
        ));
    }
    if !valid_branch(&r.branch) {
        return Err(AppError::Invalid("Nombre de rama no válido".into()));
    }
    if let Some(repo) = &r.repo {
        let ok = repo
            .split_once('/')
            .is_some_and(|(o, n)| super::api::valid_login(o) && super::api::valid_repo_name(n));
        if !ok {
            return Err(AppError::Invalid(
                "El repositorio debe tener la forma dueño/nombre".into(),
            ));
        }
    }
    Ok(r)
}

/// Nombre de rama razonable (subconjunto de `git check-ref-format`).
pub fn valid_branch(b: &str) -> bool {
    !b.is_empty()
        && b.len() <= 200
        && !b.starts_with('-')
        && !b.starts_with('/')
        && !b.ends_with('/')
        && !b.ends_with(".lock")
        && !b.contains("..")
        && !b.contains("//")
        && b.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

pub fn save_recipe_at(p: &Path, recipe: DeployRecipe) -> AppResult<DeployRecipe> {
    let mut r = normalize(recipe)?;
    update_at(p, |cfg| {
        if r.id.is_empty() {
            r.id = uuid::Uuid::new_v4().to_string();
            cfg.recipes.push(r.clone());
        } else if let Some(slot) = cfg.recipes.iter_mut().find(|x| x.id == r.id) {
            *slot = r.clone();
        } else {
            cfg.recipes.push(r.clone());
        }
        Ok(r)
    })
}

pub fn delete_recipe_at(p: &Path, id: &str) -> AppResult<()> {
    update_at(p, |cfg| {
        cfg.recipes.retain(|r| r.id != id);
        Ok(())
    })
}

pub fn save_recipe(recipe: DeployRecipe) -> AppResult<DeployRecipe> {
    save_recipe_at(&path()?, recipe)
}

pub fn delete_recipe(id: &str) -> AppResult<()> {
    delete_recipe_at(&path()?, id)
}
