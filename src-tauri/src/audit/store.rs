//! Historial de auditorías por servidor: `<config>/terview/audit/<idServidor>.json`.
//!
//! Las 30 últimas, la más nueva primero. Escritura atómica y 0600 (`fsutil`), como el escáner.
//! Se borra al borrar el servidor.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::model::{AuditMeta, AuditReport};
use crate::error::{AppError, AppResult};
use crate::storage::fsutil;
use crate::vulnscan::model::AiExplanation;

pub const MAX_REPORTS: usize = 30;

#[derive(Default, Serialize, Deserialize)]
struct HistoryFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    audits: Vec<AuditReport>,
}

/// Serializa las escrituras (dos auditorías del mismo servidor a la vez no se pisan).
static LOCK: Mutex<()> = Mutex::new(());

pub struct History {
    dir: Option<PathBuf>,
}

impl History {
    pub fn system() -> Self {
        History { dir: fsutil::config_dir().map(|d| d.join("audit")) }
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

    pub fn list(&self, server_id: &str) -> AppResult<Vec<AuditMeta>> {
        let p = self.path(server_id)?;
        Ok(Self::read(&p).audits.iter().map(AuditReport::meta).collect())
    }

    pub fn get(&self, server_id: &str, report_id: &str) -> AppResult<AuditReport> {
        let p = self.path(server_id)?;
        Self::read(&p)
            .audits
            .into_iter()
            .find(|r| r.id == report_id)
            .ok_or_else(|| AppError::NotFound("esa auditoría".into()))
    }

    pub fn latest(&self, server_id: &str) -> AppResult<Option<AuditReport>> {
        let p = self.path(server_id)?;
        Ok(Self::read(&p).audits.into_iter().next())
    }

    pub fn save(&self, report: &AuditReport) -> AppResult<()> {
        let p = self.path(&report.server_id)?;
        let _g = LOCK.lock().map_err(|_| AppError::Io("historial bloqueado".into()))?;
        let mut h = Self::read(&p);
        h.version = 1;
        h.audits.retain(|r| r.id != report.id);
        h.audits.insert(0, report.clone());
        h.audits.truncate(MAX_REPORTS);
        fsutil::write_json_atomic(&p, &h)
    }

    /// Borra una auditoría, o todo el historial del servidor si `report_id` es None.
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
                let before = h.audits.len();
                h.audits.retain(|r| r.id != id);
                if h.audits.len() == before {
                    return Err(AppError::NotFound("esa auditoría".into()));
                }
                fsutil::write_json_atomic(&p, &h)
            }
        }
    }

    /// Guarda (o quita) la explicación de la IA de una auditoría.
    pub fn set_ai(&self, server_id: &str, report_id: &str, ai: Option<AiExplanation>) -> AppResult<AuditReport> {
        let p = self.path(server_id)?;
        let _g = LOCK.lock().map_err(|_| AppError::Io("historial bloqueado".into()))?;
        let mut h = Self::read(&p);
        let r = h
            .audits
            .iter_mut()
            .find(|r| r.id == report_id)
            .ok_or_else(|| AppError::NotFound("esa auditoría".into()))?;
        r.ai = ai;
        let out = r.clone();
        fsutil::write_json_atomic(&p, &h)?;
        Ok(out)
    }
}

/// Última auditoría de un servidor (la usa el servidor MCP en `get_audit_report`). None si nunca se auditó.
pub fn latest_report(server_id: &str) -> AppResult<Option<AuditReport>> {
    History::system().latest(server_id)
}

/// Borra el historial de un servidor (al borrar el servidor). Errores solo al registro.
pub fn forget_server(server_id: &str) {
    if let Err(e) = History::system().delete(server_id, None) {
        log::warn!("no se pudo borrar el historial de auditorías de {server_id}: {e}");
    }
}
