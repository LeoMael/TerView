//! Túneles guardados: `<config_dir>/sshorus/tunnels.json`.
//!
//! Escritura atómica (`storage::fsutil`), primero disco y después memoria.

use std::path::PathBuf;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::storage::fsutil;
use crate::tunnels::types::{TunnelDef, TunnelKind};

const FILE_VERSION: u32 = 1;
const MAX_NAME: usize = 120;
const MAX_HOST: usize = 255;

#[derive(Serialize, Deserialize, Default)]
struct TunnelsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    tunnels: Vec<TunnelDef>,
}

pub struct DefStore {
    /// None: sin carpeta de configuración (solo en memoria).
    path: Option<PathBuf>,
    data: RwLock<Vec<TunnelDef>>,
}

fn read_lock<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|p| p.into_inner())
}

fn write_lock<T>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|p| p.into_inner())
}

impl DefStore {
    pub fn load() -> Self {
        match fsutil::config_dir() {
            Some(dir) => Self::load_from(dir.join("tunnels.json")),
            None => {
                log::error!("No hay carpeta de configuración: los túneles no se guardarán");
                Self {
                    path: None,
                    data: RwLock::new(Vec::new()),
                }
            }
        }
    }

    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let file: TunnelsFile = fsutil::read_json_or_default(&path);
        let mut seen = std::collections::HashSet::new();
        let list = file
            .tunnels
            .into_iter()
            .filter_map(|t| normalize(t).ok())
            .filter(|t| seen.insert(t.id.clone()))
            .collect();
        Self {
            path: Some(path),
            data: RwLock::new(list),
        }
    }

    pub fn list(&self, profile_id: &str) -> Vec<TunnelDef> {
        read_lock(&self.data)
            .iter()
            .filter(|t| t.profile_id == profile_id)
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> AppResult<TunnelDef> {
        read_lock(&self.data)
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("el túnel ya no existe".into()))
    }

    /// Crea (id "") o actualiza. Devuelve la definición guardada.
    pub fn save(&self, def: TunnelDef) -> AppResult<TunnelDef> {
        let mut def = normalize(def)?;
        let mut data = write_lock(&self.data);
        let mut next = data.clone();
        match next.iter_mut().find(|t| t.id == def.id) {
            Some(t) => *t = def.clone(),
            None => {
                if def.id.is_empty() {
                    def.id = uuid::Uuid::new_v4().to_string();
                }
                next.push(def.clone());
            }
        }
        self.persist(&next)?;
        *data = next;
        Ok(def)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut data = write_lock(&self.data);
        let next: Vec<TunnelDef> = data.iter().filter(|t| t.id != id).cloned().collect();
        if next.len() == data.len() {
            return Ok(());
        }
        self.persist(&next)?;
        *data = next;
        Ok(())
    }

    fn persist(&self, list: &[TunnelDef]) -> AppResult<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let file = TunnelsFile {
            version: FILE_VERSION,
            tunnels: list.to_vec(),
        };
        fsutil::write_json_atomic(path, &file)
    }
}

fn clean(s: &str) -> String {
    s.trim().to_string()
}

fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= MAX_HOST
        && !h
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '/')
}

/// Limpia y valida una definición (mensajes en español para la interfaz).
pub fn normalize(mut t: TunnelDef) -> AppResult<TunnelDef> {
    t.id = clean(&t.id);
    t.profile_id = clean(&t.profile_id);
    t.name = clean(&t.name);
    t.bind_host = clean(&t.bind_host);
    t.dest_host = clean(&t.dest_host);
    if t.profile_id.is_empty() {
        return Err(AppError::Invalid(
            "El túnel no indica a qué servidor pertenece".into(),
        ));
    }
    match t.kind {
        TunnelKind::Local => {
            if t.bind_host.is_empty() {
                t.bind_host = "127.0.0.1".into();
            }
            if t.dest_host.is_empty() {
                t.dest_host = "127.0.0.1".into();
            }
            if t.dest_port == 0 {
                return Err(AppError::Invalid("Indica el puerto de destino".into()));
            }
        }
        TunnelKind::Remote => {
            if t.bind_host.is_empty() {
                t.bind_host = "localhost".into();
            }
            if t.dest_host.is_empty() {
                t.dest_host = "127.0.0.1".into();
            }
            if t.dest_port == 0 {
                return Err(AppError::Invalid(
                    "Indica el puerto de tu PC al que se llega".into(),
                ));
            }
        }
        TunnelKind::Socks => {
            if t.bind_host.is_empty() {
                t.bind_host = "127.0.0.1".into();
            }
            t.dest_host.clear();
            t.dest_port = 0;
        }
    }
    if !valid_host(&t.bind_host) {
        return Err(AppError::Invalid(format!(
            "Dirección de escucha no válida: «{}»",
            t.bind_host
        )));
    }
    if t.kind != TunnelKind::Socks && !valid_host(&t.dest_host) {
        return Err(AppError::Invalid(format!(
            "Destino no válido: «{}»",
            t.dest_host
        )));
    }
    if t.name.is_empty() {
        t.name = match t.kind {
            TunnelKind::Local => format!("Local {}", t.bind_port),
            TunnelKind::Remote => format!("Remoto {}", t.bind_port),
            TunnelKind::Socks => format!("SOCKS {}", t.bind_port),
        };
    }
    if t.name.chars().count() > MAX_NAME {
        t.name = t.name.chars().take(MAX_NAME).collect();
    }
    Ok(t)
}
