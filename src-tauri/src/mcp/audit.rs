//! Registro de auditoría: todo lo que pide el asistente, con su resultado y quién lo aprobó.
//!
//! - Archivo `<config>/terview/mcp-audit.jsonl`: una línea JSON por acción terminada. Al pasar de
//!   1 MiB se renombra a `mcp-audit.1.jsonl` (se pisa el anterior): como mucho ~2 MiB en disco.
//! - En memoria, las últimas 300 acciones (también las que siguen en marcha) para el panel
//!   «Actividad del asistente». Al arrancar se cargan las últimas del archivo.
//! - Nunca se guardan contraseñas ni contenidos de archivos: solo la acción, el comando o la ruta.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::storage::fsutil;

pub const FILE_NAME: &str = "mcp-audit.jsonl";
pub const OLD_FILE_NAME: &str = "mcp-audit.1.jsonl";
/// Tamaño a partir del cual se rota el archivo.
pub const ROTATE_BYTES: u64 = 1024 * 1024;
/// Acciones que se guardan en memoria.
pub const KEEP: usize = 300;
/// Largo máximo del detalle (comando, ruta) y del mensaje.
const MAX_TEXT: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditStatus {
    /// Sigue en marcha (esperando tu permiso o ejecutándose).
    Running,
    Ok,
    /// Se intentó pero falló (error del servidor, comando con error…).
    Error,
    /// No se permitió (sin acceso, solo lectura, denegado por ti o sin respuesta).
    Denied,
    /// TerView estaba bloqueado.
    Locked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    /// Unix ms del inicio.
    pub at: u64,
    pub tool: String,
    pub server_id: Option<String>,
    pub server_name: Option<String>,
    /// Comando, ruta o lo que identifica la acción.
    pub detail: String,
    pub status: AuditStatus,
    /// Quién lo aprobó: «automático (lectura)», «tú: una vez», «tú: siempre», «regla guardada»…
    pub approved_by: Option<String>,
    /// Resumen del resultado o motivo del error.
    pub message: Option<String>,
    pub duration_ms: Option<u64>,
    /// Cliente que lo pidió (si se sabe), p. ej. «claude-code».
    pub client: Option<String>,
    /// Ejecución en curso que se puede detener desde el panel (`exec_cancel`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec_id: Option<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Recorta a `max` bytes respetando caracteres.
pub fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

type Notify = Box<dyn Fn(&AuditEntry) + Send + Sync>;

pub struct AuditLog {
    path: Option<PathBuf>,
    recent: Mutex<VecDeque<AuditEntry>>,
    /// Avisa a la interfaz de cada cambio (en la app: evento `mcp://activity`).
    notify: Mutex<Option<Notify>>,
    /// Escribe de una en una en el archivo.
    file_lock: Mutex<()>,
}

impl AuditLog {
    /// Registro en `<config>/terview/mcp-audit.jsonl`.
    pub fn load() -> Self {
        Self::at(fsutil::config_dir().map(|d| d.join(FILE_NAME)))
    }

    /// Registro en una ruta concreta (None = solo memoria). Carga las últimas acciones del archivo.
    pub fn at(path: Option<PathBuf>) -> Self {
        let recent = path.as_deref().map(read_tail).unwrap_or_default();
        AuditLog { path, recent: Mutex::new(recent), notify: Mutex::new(None), file_lock: Mutex::new(()) }
    }

    pub fn set_notify(&self, f: impl Fn(&AuditEntry) + Send + Sync + 'static) {
        *self.notify.lock().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(f));
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Lo más reciente primero.
    pub fn list(&self) -> Vec<AuditEntry> {
        self.recent.lock().unwrap_or_else(|p| p.into_inner()).iter().rev().cloned().collect()
    }

    /// Guarda o actualiza una entrada (por id). Si ya terminó, se escribe en el archivo.
    pub fn record(&self, mut entry: AuditEntry) {
        entry.detail = clip(&entry.detail, MAX_TEXT);
        entry.message = entry.message.map(|m| clip(&m, MAX_TEXT));
        {
            let mut q = self.recent.lock().unwrap_or_else(|p| p.into_inner());
            match q.iter_mut().find(|e| e.id == entry.id) {
                Some(e) => *e = entry.clone(),
                None => {
                    q.push_back(entry.clone());
                    while q.len() > KEEP {
                        q.pop_front();
                    }
                }
            }
        }
        if entry.status != AuditStatus::Running {
            self.append(&entry);
        }
        if let Some(f) = &*self.notify.lock().unwrap_or_else(|p| p.into_inner()) {
            f(&entry);
        }
    }

    /// Vacía la lista en memoria (el archivo se conserva).
    pub fn clear_recent(&self) {
        self.recent.lock().unwrap_or_else(|p| p.into_inner()).retain(|e| e.status == AuditStatus::Running);
    }

    fn append(&self, entry: &AuditEntry) {
        let Some(path) = &self.path else { return };
        let _g = self.file_lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(e) = append_line(path, entry) {
            log::warn!("no se pudo escribir el registro del asistente: {e}");
        }
    }
}

fn append_line(path: &Path, entry: &AuditEntry) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        let _ = fsutil::ensure_private_dir(dir);
    }
    rotate_if_big(path)?;
    let mut line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    line.push('\n');
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(line.as_bytes())
}

/// Si el archivo pasa de `ROTATE_BYTES`, lo renombra a `mcp-audit.1.jsonl`.
pub fn rotate_if_big(path: &Path) -> std::io::Result<()> {
    match fs::metadata(path) {
        Ok(m) if m.len() >= ROTATE_BYTES => {
            let old = path.with_file_name(OLD_FILE_NAME);
            fs::rename(path, old)
        }
        _ => Ok(()),
    }
}

/// Últimas `KEEP` entradas válidas del archivo.
fn read_tail(path: &Path) -> VecDeque<AuditEntry> {
    let mut q = VecDeque::new();
    let Ok(f) = fs::File::open(path) else { return q };
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if let Ok(e) = serde_json::from_str::<AuditEntry>(&line) {
            q.push_back(e);
            if q.len() > KEEP {
                q.pop_front();
            }
        }
    }
    q
}
