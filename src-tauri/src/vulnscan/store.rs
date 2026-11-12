//! Historial de análisis por servidor: `<config>/terview/vulnscan/<idServidor>.json`.
//!
//! Los 20 últimos, el más nuevo primero. Escritura atómica y 0600 (`fsutil`), como el resto de `storage/`.
//! Se borra al borrar el servidor.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::model::{AiExplanation, Report, ReportMeta};
use crate::error::{AppError, AppResult};
use crate::storage::fsutil;

pub const MAX_REPORTS: usize = 20;

#[derive(Default, Serialize, Deserialize)]
struct HistoryFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    scans: Vec<Report>,
}

/// Serializa las escrituras (dos análisis del mismo servidor a la vez no se pisan).
static LOCK: Mutex<()> = Mutex::new(());

pub struct History {
    dir: Option<PathBuf>,
}

impl History {
    pub fn system() -> Self {
        History { dir: fsutil::config_dir().map(|d| d.join("vulnscan")) }
    }

    #[cfg(test)]
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        History { dir: Some(dir.into()) }
    }

    fn path(&self, server_id: &str) -> AppResult<PathBuf> {
        let id = server_id.trim();
        if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(AppError::Invalid("Identificador de servidor no válido".into()));
        }
        let dir = self.dir.as_ref().ok_or_else(|| AppError::Io("no hay carpeta de configuración".into()))?;
        Ok(dir.join(format!("{id}.json")))
    }

    fn read(path: &Path) -> HistoryFile {
        fsutil::read_json_or_default(path)
    }

    pub fn list(&self, server_id: &str) -> AppResult<Vec<ReportMeta>> {
        let p = self.path(server_id)?;
        Ok(Self::read(&p).scans.iter().map(Report::meta).collect())
    }

    pub fn get(&self, server_id: &str, report_id: &str) -> AppResult<Report> {
        let p = self.path(server_id)?;
        Self::read(&p)
            .scans
            .into_iter()
            .find(|r| r.id == report_id)
            .ok_or_else(|| AppError::NotFound("ese análisis".into()))
    }

    /// El último análisis del servidor (None si nunca se analizó).
    pub fn latest(&self, server_id: &str) -> AppResult<Option<Report>> {
        let p = self.path(server_id)?;
        Ok(Self::read(&p).scans.into_iter().next())
    }

    pub fn save(&self, report: &Report) -> AppResult<()> {
        let p = self.path(&report.server_id)?;
        let _g = LOCK.lock().map_err(|_| AppError::Io("historial bloqueado".into()))?;
        let mut h = Self::read(&p);
        h.version = 1;
        h.scans.retain(|r| r.id != report.id);
        h.scans.insert(0, report.clone());
        h.scans.truncate(MAX_REPORTS);
        fsutil::write_json_atomic(&p, &h)
    }

    /// Borra un análisis, o todo el historial del servidor si `report_id` es None.
    pub fn delete(&self, server_id: &str, report_id: Option<&str>) -> AppResult<()> {
        let p = self.path(server_id)?;
        let _g = LOCK.lock().map_err(|_| AppError::Io("historial bloqueado".into()))?;
        match report_id {
            None => match std::fs::remove_file(&p) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(AppError::Io(format!("no se pudo borrar el historial: {e}"))),
            },
            Some(id) => {
                let mut h = Self::read(&p);
                let before = h.scans.len();
                h.scans.retain(|r| r.id != id);
                if h.scans.len() == before {
                    return Err(AppError::NotFound("ese análisis".into()));
                }
                fsutil::write_json_atomic(&p, &h)
            }
        }
    }

    /// Guarda (o quita) la explicación de la IA de un análisis.
    pub fn set_ai(&self, server_id: &str, report_id: &str, ai: Option<AiExplanation>) -> AppResult<Report> {
        let p = self.path(server_id)?;
        let _g = LOCK.lock().map_err(|_| AppError::Io("historial bloqueado".into()))?;
        let mut h = Self::read(&p);
        let r = h.scans.iter_mut().find(|r| r.id == report_id).ok_or_else(|| AppError::NotFound("ese análisis".into()))?;
        r.ai = ai;
        let out = r.clone();
        fsutil::write_json_atomic(&p, &h)?;
        Ok(out)
    }
}

/// Último informe de un servidor (lo usa el servidor MCP en `get_vuln_report`). None si nunca se
/// analizó.
pub fn latest_report(server_id: &str) -> AppResult<Option<Report>> {
    History::system().latest(server_id)
}

/// Borra el historial de un servidor (al borrar el servidor). Errores solo al registro.
pub fn forget_server(server_id: &str) {
    if let Err(e) = History::system().delete(server_id, None) {
        log::warn!("no se pudo borrar el historial de vulnerabilidades de {server_id}: {e}");
    }
}
