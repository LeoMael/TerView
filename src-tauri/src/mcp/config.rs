//! Ajustes del servidor MCP: `<config>/terview/mcp.json`.
//!
//! Sin secretos: el token va aparte, con la API de secretos (bóveda o llavero, id `mcp-token`).
//! El puente `terview-mcp` lee de aquí el puerto.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::policy::Access;
use crate::error::{AppError, AppResult};
use crate::storage::fsutil;

/// Nombre del archivo dentro de la carpeta de configuración.
pub const FILE_NAME: &str = "mcp.json";
/// Puerto por defecto (solo en 127.0.0.1).
pub const DEFAULT_PORT: u16 = 47821;
/// Espera por defecto de una aprobación antes de denegar.
pub const DEFAULT_APPROVAL_SECS: u32 = 120;
/// Límites de la espera de aprobación (segundos).
pub const APPROVAL_SECS_RANGE: (u32, u32) = (15, 600);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    /// Apagado por defecto.
    pub enabled: bool,
    /// Puerto HTTP local (1024..=65535).
    pub port: u16,
    /// Segundos que se espera tu respuesta; sin respuesta, se deniega.
    pub approval_timeout_secs: u32,
    /// Acceso por servidor (id → nivel). Lo que no está aquí = Sin acceso.
    pub access: BTreeMap<String, Access>,
    /// «Permitir siempre»: por servidor, las acciones exactas ya permitidas.
    pub remembered: BTreeMap<String, BTreeSet<String>>,
}

impl Default for McpConfig {
    fn default() -> Self {
        McpConfig {
            enabled: false,
            port: DEFAULT_PORT,
            approval_timeout_secs: DEFAULT_APPROVAL_SECS,
            access: BTreeMap::new(),
            remembered: BTreeMap::new(),
        }
    }
}

impl McpConfig {
    pub fn access_of(&self, server_id: &str) -> Access {
        self.access.get(server_id).copied().unwrap_or_default()
    }

    pub fn remembered_of(&self, server_id: &str) -> BTreeSet<String> {
        self.remembered.get(server_id).cloned().unwrap_or_default()
    }

    /// Corrige valores fuera de rango y quita entradas vacías.
    pub fn sanitize(mut self) -> Self {
        if self.port < 1024 {
            self.port = DEFAULT_PORT;
        }
        let (lo, hi) = APPROVAL_SECS_RANGE;
        self.approval_timeout_secs = self.approval_timeout_secs.clamp(lo, hi);
        self.access.retain(|k, v| !k.trim().is_empty() && *v != Access::None);
        self.remembered.retain(|k, v| !k.trim().is_empty() && !v.is_empty());
        self
    }
}

pub struct McpConfigStore {
    path: Option<PathBuf>,
    data: Mutex<McpConfig>,
}

fn guard(m: &Mutex<McpConfig>) -> MutexGuard<'_, McpConfig> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl McpConfigStore {
    /// Lee `<config>/terview/mcp.json` (o valores por defecto).
    pub fn load() -> Self {
        match fsutil::config_dir() {
            Some(dir) => Self::load_from(dir.join(FILE_NAME)),
            None => McpConfigStore { path: None, data: Mutex::new(McpConfig::default()) },
        }
    }

    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let cfg: McpConfig = fsutil::read_json_or_default(&path);
        McpConfigStore { path: Some(path), data: Mutex::new(cfg.sanitize()) }
    }

    /// Solo en memoria (pruebas).
    #[cfg(test)]
    pub fn in_memory(cfg: McpConfig) -> Self {
        McpConfigStore { path: None, data: Mutex::new(cfg.sanitize()) }
    }

    pub fn get(&self) -> McpConfig {
        guard(&self.data).clone()
    }

    /// Cambia los ajustes con `f`, los guarda y devuelve el resultado. Si el disco falla, nada cambia.
    pub fn update(&self, f: impl FnOnce(&mut McpConfig)) -> AppResult<McpConfig> {
        let mut g = guard(&self.data);
        let mut next = g.clone();
        f(&mut next);
        let next = next.sanitize();
        if next == *g {
            return Ok(next);
        }
        match &self.path {
            Some(p) => fsutil::write_json_atomic(p, &next)?,
            None if cfg!(test) => {}
            None => return Err(AppError::Io("no se encontró la carpeta de configuración del usuario".into())),
        }
        *g = next.clone();
        Ok(next)
    }
}
