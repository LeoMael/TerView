//! Caché del detalle de cada aviso de OSV: un JSON por id en `<caché>/com.terview.app/osv/`.
//!
//! Se guarda con su fecha `modified`: si OSV dice otra fecha, se vuelve a pedir. Se puede borrar sin
//! perder nada; los archivos de más de 30 días se limpian al empezar un análisis.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::fsutil;

const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

#[derive(Serialize, Deserialize)]
struct Entry {
    modified: String,
    vuln: Value,
}

#[derive(Clone)]
pub struct OsvCache {
    dir: Option<PathBuf>,
}

impl OsvCache {
    /// La caché del sistema (`~/.cache/com.terview.app/osv` en Linux).
    pub fn system() -> Self {
        OsvCache { dir: dirs::cache_dir().map(|d| d.join("com.terview.app").join("osv")) }
    }

    #[cfg(test)]
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        OsvCache { dir: Some(dir.into()) }
    }

    /// Sin caché (pruebas).
    #[cfg(test)]
    pub fn none() -> Self {
        OsvCache { dir: None }
    }

    fn file(&self, id: &str) -> Option<PathBuf> {
        let name: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_') { c } else { '_' }).collect();
        if name.is_empty() || name.starts_with('.') {
            return None;
        }
        Some(self.dir.as_ref()?.join(format!("{name}.json")))
    }

    /// El aviso guardado, si su `modified` coincide (o si `modified` es None: cualquiera vale).
    pub fn get(&self, id: &str, modified: Option<&str>) -> Option<Value> {
        let path = self.file(id)?;
        let bytes = fs::read(&path).ok()?;
        let e: Entry = serde_json::from_slice(&bytes).ok()?;
        if let Some(m) = modified
            && m != e.modified
        {
            return None;
        }
        Some(e.vuln)
    }

    pub fn put(&self, id: &str, modified: &str, vuln: &Value) {
        let Some(path) = self.file(id) else { return };
        let Some(dir) = path.parent() else { return };
        if fsutil::ensure_private_dir(dir).is_err() {
            return;
        }
        let e = Entry { modified: modified.to_string(), vuln: vuln.clone() };
        // Sin fsync (es una caché: si un archivo queda a medias, no se entiende y se vuelve a pedir).
        let Ok(bytes) = serde_json::to_vec(&e) else { return };
        let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
        if fs::write(&tmp, &bytes).and_then(|()| fs::rename(&tmp, &path)).is_err() {
            let _ = fs::remove_file(&tmp);
            log::warn!("caché de OSV: no se pudo guardar {id}");
        }
    }

    /// Borra los avisos de más de 30 días.
    pub fn clean_old(&self) {
        let Some(dir) = &self.dir else { return };
        clean_dir(dir, MAX_AGE);
    }
}

fn clean_dir(dir: &Path, max_age: Duration) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        if old && e.path().extension().is_some_and(|x| x == "json") {
            let _ = fs::remove_file(e.path());
        }
    }
}
