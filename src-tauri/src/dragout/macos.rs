//! Arrastre nativo en macOS con el crate `drag` (CrabNebula): `NSDraggingSession` con un `NSURL`
//! de archivo por elemento; Finder copia desde la caché al soltar.
//! ⚠️ Sin compilar ni probar aquí (se desarrolla en Linux): lo compila la versión de macOS en la CI
//! de publicación. Se deja lo más simple posible a propósito.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::WebviewWindow;

use super::Done;
use crate::error::{AppError, AppResult};

/// Imagen que acompaña al cursor mientras se arrastra.
const ICON: &[u8] = include_bytes!("../../icons/32x32.png");

pub fn start(window: &WebviewWindow, paths: Vec<PathBuf>, done: Done) -> AppResult<()> {
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let done = Arc::new(Mutex::new(Some(done)));
            let on_end = done.clone();
            let r = drag::start_drag(
                &win,
                drag::DragItem::Files(paths),
                drag::Image::Raw(ICON.to_vec()),
                move |result, _cursor| {
                    if let Some(d) = on_end.lock().ok().and_then(|mut g| g.take()) {
                        d(Ok(matches!(result, drag::DragResult::Dropped)));
                    }
                },
                drag::Options::default(),
            );
            if let Err(e) = r
                && let Some(d) = done.lock().ok().and_then(|mut g| g.take())
            {
                d(Err(e.to_string()));
            }
        })
        .map_err(|e| AppError::Invalid(format!("No se pudo empezar a arrastrar: {e}")))
}
