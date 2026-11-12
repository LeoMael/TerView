//! Arrastre nativo en Windows. ⚠️ Sin probar en un Windows real (solo se comprueba que compila).
//!
//! Se pide al Shell el objeto de datos de las rutas (`IShellItemArray` → `BHID_DataObject`): trae
//! `CF_HDROP` y los formatos propios del Explorador, como si se arrastrara desde una carpeta.
//! `SHDoDragDrop` sin origen propio usa el de Windows (sigue el botón izquierdo y Esc) y la
//! imagen de arrastre del Shell. Es un bucle modal: devuelve al soltar o cancelar.
//!
//! No se usa el crate `drag` en Windows: trae otras dos versiones del crate `windows` (0.52 y
//! 0.58) y hace `unwrap` si falla crear el objeto; aquí se usa el `windows` 0.62 que ya trae Tauri.

use std::path::PathBuf;

use tauri::WebviewWindow;
use windows::Win32::System::Com::{IBindCtx, IDataObject};
use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_NONE, IDropSource, OleInitialize};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{BHID_DataObject, ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists, SHDoDragDrop};
use windows::core::HSTRING;

use super::Done;
use crate::error::{AppError, AppResult};

pub fn start(window: &WebviewWindow, paths: Vec<PathBuf>, done: Done) -> AppResult<()> {
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            // SAFETY: se ejecuta en el hilo de la ventana (STA, con su bucle de mensajes).
            let r = unsafe { drag(&win, &paths) };
            done(r);
        })
        .map_err(|e| AppError::Invalid(format!("No se pudo empezar a arrastrar: {e}")))
}

/// Lista de PIDL (identificadores del Shell) que se liberan al salir.
struct Pidls(Vec<*mut ITEMIDLIST>);

impl Drop for Pidls {
    fn drop(&mut self) {
        for p in self.0.drain(..) {
            // SAFETY: cada PIDL viene de ILCreateFromPathW y se libera una sola vez.
            unsafe { ILFree(Some(p.cast_const())) };
        }
    }
}

unsafe fn drag(win: &WebviewWindow, paths: &[PathBuf]) -> Result<bool, String> {
    let hwnd = win.hwnd().map_err(|e| e.to_string())?;
    // El hilo de la ventana ya tiene OLE iniciado (Tauri lo usa para soltar archivos); si no,
    // se inicia aquí. Volver a llamarlo es inofensivo (solo suma una referencia).
    // SAFETY: llamada simple de inicialización en el hilo actual.
    let _ = unsafe { OleInitialize(None) };

    let mut pidls = Pidls(Vec::with_capacity(paths.len()));
    for p in paths {
        let wide = HSTRING::from(p.as_path());
        // SAFETY: `wide` es una cadena terminada en cero válida durante la llamada.
        let pidl = unsafe { ILCreateFromPathW(&wide) };
        if pidl.is_null() {
            return Err(format!("Windows no reconoce la ruta {}", p.display()));
        }
        pidls.0.push(pidl);
    }
    let list: Vec<*const ITEMIDLIST> = pidls.0.iter().map(|p| p.cast_const()).collect();

    let run = || -> windows::core::Result<bool> {
        // SAFETY: los PIDL de `list` siguen vivos (los guarda `pidls`) mientras dura el arrastre.
        unsafe {
            let items = SHCreateShellItemArrayFromIDLists(&list)?;
            let data: IDataObject = items.BindToHandler(None::<&IBindCtx>, &BHID_DataObject)?;
            let effect = SHDoDragDrop(Some(hwnd), &data, None::<&IDropSource>, DROPEFFECT_COPY)?;
            Ok(effect != DROPEFFECT_NONE)
        }
    };
    run().map_err(|e| e.message())
}
