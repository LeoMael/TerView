//! Arrastrar archivos y carpetas del explorador remoto al escritorio o al gestor de archivos del
//! sistema (Explorador de Windows, Finder, Nautilus, Dolphin…). DUEÑO: agente SFTP/Explorador.
//!
//! Cómo funciona (igual en los tres sistemas):
//! 1. La interfaz pide una carpeta nueva en la caché (`drag_out_dir`) y descarga ahí lo
//!    seleccionado con el motor de transferencias normal (cola, progreso, reanudación; se ve en
//!    el panel de transferencias).
//! 2. Cuando está descargado y el botón del ratón sigue apretado, la interfaz llama a
//!    `drag_out_start` con las rutas locales y el sistema empieza un arrastre de archivos
//!    "de verdad". Al soltar, el gestor de archivos copia desde la caché.
//!
//! Por qué así y no "archivos prometidos" (el archivo se descarga al soltar):
//! - Wayland no tiene promesas de archivo: solo se puede ofrecer una lista de rutas que ya existan.
//! - En Windows (`CFSTR_FILECONTENTS`) y macOS (`NSFilePromiseProvider`) la descarga la haría el
//!   propio sistema leyendo de un flujo, por fuera del motor de transferencias (sin cola, sin
//!   reanudar, sin verse en el panel). Con "descargar primero" todo pasa por el motor.
//!
//! Por sistema:
//! - Linux (X11 y Wayland): GTK3 propio (`linux.rs`), lista `text/uri-list` con URIs bien
//!   codificadas. No se usa `drag`/`tauri-plugin-drag` 2.1.1 porque en GTK escribe las URIs sin
//!   codificar (fallan los espacios y los acentos), pasa la máscara del botón en lugar del número
//!   (el arrastre no termina bien) y desconecta la entrega de datos al soltar, antes de que el
//!   destino los pida (en Wayland el destino no recibe nada).
//! - Windows: `win.rs` pide al Shell el objeto de datos de las rutas (`CF_HDROP` y los formatos
//!   del Explorador) y usa `SHDoDragDrop` (origen e imagen de arrastre de Windows).
//! - macOS: crate `drag` (CrabNebula), que en macOS sí está bien: arrastra `NSURL` de archivo.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod win;

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::error::{AppError, AppResult};

/// Carpeta dentro de la caché de la app donde se dejan las descargas para arrastrar.
const DIR_NAME: &str = "arrastre";
/// Lo preparado se borra al abrir la app si tiene más de un día. No se borra justo después de
/// soltar: algunos gestores de archivos copian en segundo plano y aún lo están leyendo.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Resultado del arrastre nativo: `Ok(true)` si se soltó en algún sitio, `Ok(false)` si se canceló.
type Done = Box<dyn FnOnce(Result<bool, String>) + Send + 'static>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutDir {
    /// Carpeta raíz de todo lo preparado (la interfaz la usa para reconocer sus propios arrastres).
    pub root: String,
    /// Carpeta nueva y vacía para esta descarga.
    pub dir: String,
}

fn cache_root(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join(DIR_NAME))
        .map_err(|e| AppError::Io(format!("No se encontró la carpeta de caché: {e}")))
}

/// Crea una carpeta nueva y vacía en la caché para descargar ahí lo que se va a arrastrar.
/// Al ser nueva, la descarga nunca choca con archivos que ya existan (no pregunta "¿sobrescribir?").
#[tauri::command]
pub fn drag_out_dir(app: AppHandle) -> AppResult<DragOutDir> {
    let root = cache_root(&app)?;
    let dir = root.join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir_all(&dir).map_err(|e| AppError::Io(format!("{}: {e}", dir.display())))?;
    Ok(DragOutDir {
        root: root.to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
    })
}

/// Empieza el arrastre nativo de archivos ya preparados (deben estar dentro de la caché de
/// arrastre). Hay que llamarlo con el botón del ratón apretado. Termina cuando el usuario suelta:
/// `true` si los soltó en algún sitio, `false` si canceló.
#[tauri::command]
pub async fn drag_out_start(app: AppHandle, window: WebviewWindow, paths: Vec<String>) -> AppResult<bool> {
    let root = cache_root(&app)?;
    let paths = check_paths(&root, &paths)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let done: Done = Box::new(move |r| {
        let _ = tx.send(r);
    });
    native_start(&window, paths, done)?;
    match rx.await {
        Ok(Ok(dropped)) => Ok(dropped),
        Ok(Err(msg)) => Err(AppError::Invalid(format!("No se pudo arrastrar: {msg}"))),
        // El sistema terminó sin avisar (no debería pasar): se trata como cancelado.
        Err(_) => Ok(false),
    }
}

#[cfg(target_os = "linux")]
fn native_start(window: &WebviewWindow, paths: Vec<PathBuf>, done: Done) -> AppResult<()> {
    linux::start(window, paths, done)
}

#[cfg(windows)]
fn native_start(window: &WebviewWindow, paths: Vec<PathBuf>, done: Done) -> AppResult<()> {
    win::start(window, paths, done)
}

#[cfg(target_os = "macos")]
fn native_start(window: &WebviewWindow, paths: Vec<PathBuf>, done: Done) -> AppResult<()> {
    macos::start(window, paths, done)
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn native_start(_window: &WebviewWindow, _paths: Vec<PathBuf>, _done: Done) -> AppResult<()> {
    Err(AppError::Invalid("Arrastrar al sistema no está disponible aquí: usa «Descargar en…»".into()))
}

/// Comprueba las rutas que manda la interfaz: completas, sin `..`, existentes y dentro de `root`.
/// Devuelve las rutas tal cual (sin canonicalizar: en Windows la forma `\\?\C:\…` no la
/// aceptan todas las funciones del Shell).
pub(crate) fn check_paths(root: &Path, paths: &[String]) -> AppResult<Vec<PathBuf>> {
    if paths.is_empty() {
        return Err(AppError::Invalid("No hay nada que arrastrar".into()));
    }
    let root = root
        .canonicalize()
        .map_err(|_| AppError::NotFound("lo preparado para arrastrar ya no está; vuelve a arrastrar".into()))?;
    paths
        .iter()
        .map(|s| {
            let p = PathBuf::from(s);
            if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(AppError::Invalid(format!("Ruta no válida: {s}")));
            }
            let real = p
                .canonicalize()
                .map_err(|_| AppError::NotFound(format!("«{}» ya no está preparado; vuelve a arrastrar", p.display())))?;
            if !real.starts_with(&root) || real == root {
                return Err(AppError::Invalid(format!("Solo se arrastra lo preparado por TerView: {s}")));
            }
            Ok(p)
        })
        .collect()
}

/// Borra lo preparado antes de `cutoff` (carpetas de primer nivel de `root`). Devuelve cuántas.
pub(crate) fn clean_older_than(root: &Path, cutoff: SystemTime) -> usize {
    let Ok(read) = fs::read_dir(root) else { return 0 };
    let mut removed = 0;
    for entry in read.flatten() {
        let path = entry.path();
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if !old {
            continue;
        }
        let res = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        match res {
            Ok(()) => removed += 1,
            Err(e) => log::warn!("no se pudo borrar {}: {e}", path.display()),
        }
    }
    removed
}

/// Al abrir la app: borra en segundo plano lo preparado hace más de un día.
pub fn clean_on_start(app: &AppHandle) {
    let Ok(root) = cache_root(app) else { return };
    std::thread::spawn(move || {
        let cutoff = SystemTime::now().checked_sub(MAX_AGE).unwrap_or(SystemTime::UNIX_EPOCH);
        let n = clean_older_than(&root, cutoff);
        if n > 0 {
            log::info!("arrastre: {n} carpetas viejas borradas de {}", root.display());
        }
    });
}
