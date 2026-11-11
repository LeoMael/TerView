//! Lectura/escritura segura de archivos JSON de configuración.
//!
//! - Escritura atómica: archivo temporal en la misma carpeta + `rename`.
//! - Permisos: carpeta 0700 y archivo 0600 (en Unix), porque contienen hosts y usuarios.
//! - Archivo corrupto: se aparta como `<nombre>.bak-<unix>` y se empieza de cero.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Carpeta de configuración de la app: `~/.config/terview` (o equivalente del sistema).
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("terview"))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Crea la carpeta (y padres) con permisos 0700.
pub fn ensure_private_dir(dir: &Path) -> AppResult<()> {
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Si no podemos ajustar permisos (p. ej. carpeta ajena), seguimos igual.
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Lee un JSON. Si no existe → `T::default()`. Si está corrupto → copia de seguridad y `T::default()`.
/// Nunca falla: los problemas se registran con `log`.
pub fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return T::default(),
        Err(e) => {
            log::error!("No se pudo leer {}: {e}", path.display());
            return T::default();
        }
    };
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return T::default();
    }
    match serde_json::from_slice::<T>(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let backup = backup_path(path);
            match fs::rename(path, &backup) {
                Ok(()) => log::error!(
                    "{} está dañado ({e}); se guardó una copia en {} y se empieza de cero",
                    path.display(),
                    backup.display()
                ),
                Err(re) => log::error!(
                    "{} está dañado ({e}) y no se pudo apartar ({re}); se empieza de cero",
                    path.display()
                ),
            }
            T::default()
        }
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.json".into());
    let base = format!("{name}.bak-{}", unix_now());
    let mut candidate = path.with_file_name(&base);
    let mut n = 1;
    while candidate.exists() {
        candidate = path.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

/// Escribe JSON de forma atómica (temporal + rename) con permisos 0600.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Io(format!("ruta inválida: {}", path.display())))?;
    ensure_private_dir(dir)?;
    let mut json = serde_json::to_vec_pretty(value)?;
    json.push(b'\n');
    write_atomic(path, &json)
}

/// Escribe bytes de forma atómica (temporal en la misma carpeta + rename) con permisos 0600.
/// La carpeta debe existir; no cambia sus permisos.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Io(format!("ruta inválida: {}", path.display())))?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".into());
    let tmp = dir.join(format!(".{file_name}.tmp-{}", uuid::Uuid::new_v4().simple()));

    let result = (|| -> std::io::Result<()> {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        // Asegura que el rename quede en disco.
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Io(format!("no se pudo guardar {}: {e}", path.display())));
    }
    Ok(())
}
