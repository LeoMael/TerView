//! Lectura y escritura de archivos de texto LOCALES elegidos por el usuario con el diálogo del sistema
//! (p. ej. exportar/importar «Mis comandos»). Pequeño y con límites: no es un explorador de archivos.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::storage::fsutil;

/// Tamaño máximo que se lee o escribe (5 MB): de sobra para listas de comandos o configuraciones.
pub const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

fn check_path(path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err(AppError::Invalid("No se indicó ningún archivo".into()));
    }
    if !p.is_absolute() {
        return Err(AppError::Invalid(format!("La ruta debe ser completa: {}", p.display())));
    }
    Ok(p)
}

fn too_big(len: u64) -> AppError {
    AppError::Invalid(format!(
        "El archivo es demasiado grande ({:.1} MB; máximo {} MB)",
        len as f64 / (1024.0 * 1024.0),
        MAX_TEXT_BYTES / (1024 * 1024)
    ))
}

/// Escribe `content` en `path` de forma atómica (temporal + renombrar). Crea el archivo si no existe.
pub fn write_text(path: &Path, content: &str) -> AppResult<()> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err(too_big(content.len() as u64));
    }
    if path.is_dir() {
        return Err(AppError::Invalid(format!("{} es una carpeta", path.display())));
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| AppError::Invalid(format!("Ruta inválida: {}", path.display())))?;
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("la carpeta {}", dir.display())));
    }
    fsutil::write_atomic(path, content.as_bytes())
}

/// Lee `path` como texto UTF-8 (sin BOM). Falla si pasa de [`MAX_TEXT_BYTES`] o no es texto.
pub fn read_text(path: &Path) -> AppResult<String> {
    let meta = fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(path.display().to_string()),
        _ => AppError::Io(format!("no se pudo abrir {}: {e}", path.display())),
    })?;
    if meta.is_dir() {
        return Err(AppError::Invalid(format!("{} es una carpeta", path.display())));
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(too_big(meta.len()));
    }
    let file = fs::File::open(path).map_err(|e| AppError::Io(format!("no se pudo abrir {}: {e}", path.display())))?;
    // Leemos como mucho límite + 1 por si el archivo crece mientras tanto.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::Io(format!("no se pudo leer {}: {e}", path.display())))?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(too_big(bytes.len() as u64));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Invalid(format!("{} no es un archivo de texto UTF-8", path.display())))?;
    Ok(text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("tarea interna interrumpida: {e}")))?
}

/// Guarda texto en un archivo local (ruta completa, normalmente elegida con el diálogo «Guardar»).
#[tauri::command]
pub async fn local_write_text(path: String, content: String) -> AppResult<()> {
    let p = check_path(&path)?;
    blocking(move || write_text(&p, &content)).await
}

/// Guarda bytes (p. ej. una imagen PNG exportada) en un archivo local elegido con el diálogo «Guardar».
#[tauri::command]
pub async fn local_write_bytes(path: String, data: Vec<u8>) -> AppResult<()> {
    let p = check_path(&path)?;
    blocking(move || write_bytes(&p, &data)).await
}

/// Como [`write_text`], pero con bytes cualesquiera (mismo límite de tamaño).
pub fn write_bytes(path: &Path, data: &[u8]) -> AppResult<()> {
    if data.len() as u64 > MAX_TEXT_BYTES * 4 {
        return Err(too_big(data.len() as u64));
    }
    if path.is_dir() {
        return Err(AppError::Invalid(format!("{} es una carpeta", path.display())));
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| AppError::Invalid(format!("Ruta inválida: {}", path.display())))?;
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("la carpeta {}", dir.display())));
    }
    fsutil::write_atomic(path, data)
}

/// Lee un archivo de texto local (ruta completa, normalmente elegida con el diálogo «Abrir»).
#[tauri::command]
pub async fn local_read_text(path: String) -> AppResult<String> {
    let p = check_path(&path)?;
    blocking(move || read_text(&p)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("terview-localfs-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn roundtrip_limits_and_errors() {
        let dir = tmp();
        let f = dir.join("comandos.json");
        write_text(&f, "{\"a\": \"ñ\"}").unwrap();
        assert_eq!(read_text(&f).unwrap(), "{\"a\": \"ñ\"}");
        // Sobrescribe.
        write_text(&f, "[]").unwrap();
        assert_eq!(read_text(&f).unwrap(), "[]");
        // BOM fuera.
        fs::write(&f, "\u{feff}hola").unwrap();
        assert_eq!(read_text(&f).unwrap(), "hola");
        // No UTF-8.
        fs::write(&f, [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(read_text(&f), Err(AppError::Invalid(_))));
        // Demasiado grande.
        let big = "x".repeat(MAX_TEXT_BYTES as usize + 1);
        assert!(write_text(&f, &big).is_err());
        fs::write(&f, &big).unwrap();
        assert!(read_text(&f).is_err());
        // Carpeta / no existe / carpeta padre inexistente.
        assert!(read_text(&dir).is_err());
        assert!(matches!(read_text(&dir.join("nada")), Err(AppError::NotFound(_))));
        assert!(write_text(&dir.join("no/existe.json"), "x").is_err());
        // Bytes (PNG exportado).
        let png = dir.join("mapa.png");
        write_bytes(&png, &[0x89, b'P', b'N', b'G']).unwrap();
        assert_eq!(fs::read(&png).unwrap(), vec![0x89, b'P', b'N', b'G']);
        assert!(write_bytes(&dir, &[1]).is_err());
        assert!(check_path("relativa.json").is_err());
        assert!(check_path("  ").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
