//! Arrastre nativo en Linux con GTK3 (el mismo que usa la ventana de Tauri). Sirve en X11 y en
//! Wayland: se ofrece `text/uri-list` (lo que entienden Nautilus, Dolphin, Thunar, Nemo y el
//! escritorio) con URIs `file://` bien codificadas por GLib (espacios → `%20`, acentos en UTF-8).
//!
//! Detalles que importan:
//! - Botón 1 (no la máscara `GDK_BUTTON1_MASK`): GTK compara este número con el botón que se suelta.
//! - En Wayland el compositor solo deja empezar un arrastre mientras el botón sigue apretado (usa
//!   la "implicit grab" del clic). Por eso la interfaz llama aquí antes de soltar.
//! - La entrega de datos (`drag-data-get`) se mantiene hasta `drag-end`: en Wayland el destino pide
//!   la lista DESPUÉS de soltar, así que no se puede desconectar en `drop-performed`.
//! - Las señales se conectan a la ventana, pero solo responden a NUESTRO arrastre (se compara el
//!   contexto): un arrastre propio de WebKit no se ve afectado.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;

use gtk::prelude::*;
use gtk::{gdk, glib};
use tauri::WebviewWindow;

use super::Done;
use crate::error::{AppError, AppResult};

/// URIs `file://` codificadas como pide RFC 8089 (lo hace GLib, igual que los gestores de archivos).
pub(crate) fn file_uris(paths: &[PathBuf]) -> Result<Vec<String>, String> {
    paths
        .iter()
        .map(|p| {
            glib::filename_to_uri(p, None)
                .map(|u| u.to_string())
                .map_err(|e| format!("{}: {e}", p.display()))
        })
        .collect()
}

pub fn start(window: &WebviewWindow, paths: Vec<PathBuf>, done: Done) -> AppResult<()> {
    let uris = file_uris(&paths).map_err(AppError::Invalid)?;
    let icon = if paths.iter().any(|p| p.is_dir()) { "folder" } else { "text-x-generic" };
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let done = Rc::new(RefCell::new(Some(done)));
            if let Err(msg) = begin(&win, uris, icon, done.clone())
                && let Some(d) = done.borrow_mut().take()
            {
                d(Err(msg));
            }
        })
        .map_err(|e| AppError::Invalid(format!("No se pudo empezar a arrastrar: {e}")))
}

/// Corre en el hilo de GTK.
fn begin(win: &WebviewWindow, uris: Vec<String>, icon: &'static str, done: Rc<RefCell<Option<Done>>>) -> Result<(), String> {
    let gtk_win = win.gtk_window().map_err(|e| e.to_string())?;
    let widget: gtk::Widget = gtk_win.upcast();

    let targets = gtk::TargetList::new(&[]);
    targets.add_uri_targets(0);
    let event = gtk::current_event();
    let ctx = widget
        .drag_begin_with_coordinates(&targets, gdk::DragAction::COPY, 1, event.as_ref(), -1, -1)
        .ok_or_else(|| "el sistema no dejó empezar el arrastre (mantén el botón apretado al arrastrar)".to_string())?;
    ctx.drag_set_icon_name(icon, 0, 0);

    let failed = Rc::new(Cell::new(false));
    let ids: Rc<RefCell<Vec<glib::SignalHandlerId>>> = Rc::default();

    let mine = ctx.clone();
    let get_id = widget.connect_drag_data_get(move |_, dc, data, _info, _time| {
        if *dc == mine {
            let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
            data.set_uris(&refs);
        }
    });

    let mine = ctx.clone();
    let flag = failed.clone();
    let fail_id = widget.connect_drag_failed(move |_, dc, _result| {
        if *dc == mine {
            flag.set(true);
        }
        glib::Propagation::Proceed
    });

    let mine = ctx;
    let to_drop = ids.clone();
    let end_id = widget.connect_drag_end(move |w, dc| {
        if *dc != mine {
            return;
        }
        let list: Vec<glib::SignalHandlerId> = to_drop.borrow_mut().drain(..).collect();
        for id in list {
            w.disconnect(id);
        }
        if let Some(d) = done.borrow_mut().take() {
            d(Ok(!failed.get()));
        }
    });

    ids.borrow_mut().extend([get_id, fail_id, end_id]);
    Ok(())
}
