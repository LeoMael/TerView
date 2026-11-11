//! "Mis comandos": lectura/escritura de `~/.config/terview/commands.json`.
//!
//! - Escritura atómica (temporal en la misma carpeta + `rename`), archivo 0600 y carpeta 0700.
//! - Archivo dañado → se aparta como `commands.json.bak-<unix>` y se empieza vacío.
//! - Se escribe primero en disco y solo después se actualiza la memoria (nunca divergen).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::types::{Snippet, SnippetScope};

const FILE_VERSION: u32 = 1;
const DEFAULT_CATEGORY: &str = "Mis comandos";
const MAX_NAME: usize = 200;
const MAX_COMMAND: usize = 64 * 1024;

/// Formato del archivo en disco.
#[derive(Serialize, Deserialize, Default)]
struct CommandsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    commands: Vec<Snippet>,
}

/// También aceptamos una lista simple (p. ej. editada a mano).
#[derive(Deserialize)]
#[serde(untagged)]
enum AnyFile {
    Wrapped(CommandsFile),
    List(Vec<Snippet>),
}

pub struct SnippetStore {
    /// None si el sistema no tiene carpeta de configuración (solo en memoria).
    path: Option<PathBuf>,
    data: RwLock<Vec<Snippet>>,
}

fn read_lock<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|p| p.into_inner())
}

fn write_lock<T>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|p| p.into_inner())
}

fn clean_opt(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl SnippetStore {
    /// Lee ~/.config/terview/commands.json (o vacío). Nunca falla: registra el error.
    pub fn load() -> Self {
        match dirs::config_dir() {
            Some(dir) => Self::load_from(dir.join("terview").join("commands.json")),
            None => {
                log::error!("No hay carpeta de configuración: \"Mis comandos\" no se guardarán");
                SnippetStore { path: None, data: RwLock::new(Vec::new()) }
            }
        }
    }

    /// Igual que `load` con una ruta concreta (tests).
    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mut list = read_file(&path);
        // Reparación suave: ids vacíos o repetidos, entradas inválidas.
        let mut seen = std::collections::HashSet::new();
        list.retain_mut(|s| {
            if s.id.trim().is_empty() || !seen.insert(s.id.clone()) {
                s.id = uuid::Uuid::new_v4().to_string();
                seen.insert(s.id.clone());
            }
            normalize(s).is_ok()
        });
        SnippetStore { path: Some(path), data: RwLock::new(list) }
    }

    pub fn list(&self) -> Vec<Snippet> {
        read_lock(&self.data).clone()
    }

    /// Crea (id "") o actualiza. Devuelve el guardado.
    pub fn save(&self, mut snippet: Snippet) -> AppResult<Snippet> {
        normalize(&mut snippet)?;
        let mut guard = write_lock(&self.data);
        let mut next = guard.clone();
        if snippet.id.trim().is_empty() {
            snippet.id = uuid::Uuid::new_v4().to_string();
            next.push(snippet.clone());
        } else {
            match next.iter_mut().find(|s| s.id == snippet.id) {
                Some(slot) => *slot = snippet.clone(),
                None => return Err(AppError::NotFound(format!("comando {}", snippet.name))),
            }
        }
        self.persist(&next)?;
        *guard = next;
        Ok(snippet)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut guard = write_lock(&self.data);
        if !guard.iter().any(|s| s.id == id) {
            return Err(AppError::NotFound("el comando ya no existe".into()));
        }
        let next: Vec<Snippet> = guard.iter().filter(|s| s.id != id).cloned().collect();
        self.persist(&next)?;
        *guard = next;
        Ok(())
    }

    fn persist(&self, list: &[Snippet]) -> AppResult<()> {
        let Some(path) = &self.path else { return Ok(()) };
        let file = CommandsFile { version: FILE_VERSION, commands: list.to_vec() };
        write_json_atomic(path, &file)
    }
}

/// Valida y limpia un comando. Errores con mensaje en español.
fn normalize(s: &mut Snippet) -> AppResult<()> {
    s.name = s.name.trim().to_string();
    if s.name.is_empty() {
        return Err(AppError::Invalid("El nombre del comando no puede estar vacío".into()));
    }
    if s.name.chars().count() > MAX_NAME {
        return Err(AppError::Invalid("El nombre del comando es demasiado largo".into()));
    }
    // El comando se respeta tal cual (puede ser multilínea), solo se quitan bordes.
    s.command = s.command.trim().to_string();
    if s.command.is_empty() {
        return Err(AppError::Invalid("El comando no puede estar vacío".into()));
    }
    if s.command.len() > MAX_COMMAND {
        return Err(AppError::Invalid("El comando es demasiado largo (máx. 64 KB)".into()));
    }
    s.description = clean_opt(s.description.take());
    s.category = s.category.trim().to_string();
    if s.category.is_empty() {
        s.category = DEFAULT_CATEGORY.to_string();
    }
    match s.scope {
        SnippetScope::Global => s.scope_id = None,
        SnippetScope::Project | SnippetScope::Server => {
            s.scope_id = clean_opt(s.scope_id.take());
            if s.scope_id.is_none() {
                let what = if s.scope == SnippetScope::Project { "un proyecto" } else { "un servidor" };
                return Err(AppError::Invalid(format!("Elige {what} para el alcance del comando")));
            }
        }
    }
    Ok(())
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_file(path: &Path) -> Vec<Snippet> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::error!("No se pudo leer {}: {e}", path.display());
            return Vec::new();
        }
    };
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Vec::new();
    }
    match serde_json::from_slice::<AnyFile>(&bytes) {
        Ok(AnyFile::Wrapped(f)) => f.commands,
        Ok(AnyFile::List(l)) => l,
        Err(e) => {
            let backup = backup_path(path);
            match fs::rename(path, &backup) {
                Ok(()) => log::error!(
                    "{} está dañado ({e}); copia en {} y se empieza vacío",
                    path.display(),
                    backup.display()
                ),
                Err(re) => log::error!("{} está dañado ({e}) y no se pudo apartar ({re})", path.display()),
            }
            Vec::new()
        }
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "commands.json".into());
    let base = format!("{name}.bak-{}", unix_now());
    let mut candidate = path.with_file_name(&base);
    let mut n = 1;
    while candidate.exists() {
        candidate = path.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

fn ensure_private_dir(dir: &Path) -> AppResult<()> {
    if !dir.exists() {
        let mut b = fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(dir)
            .map_err(|e| AppError::Io(format!("no se pudo crear {}: {e}", dir.display())))?;
    }
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Io(format!("ruta inválida: {}", path.display())))?;
    ensure_private_dir(dir)?;
    let json = serde_json::to_vec_pretty(value)?;
    let tmp = dir.join(format!(".commands.json.tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| -> std::io::Result<()> {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&json)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        drop(f);
        crate::storage::fsutil::replace_file(&tmp, path)?;
        crate::storage::fsutil::sync_dir(dir);
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Io(format!("no se pudo guardar {}: {e}", path.display())));
    }
    Ok(())
}
