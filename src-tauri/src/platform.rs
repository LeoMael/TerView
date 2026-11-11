//! Ajustes del sistema que deben aplicarse ANTES de crear la ventana.
//!
//! Linux: WebKitGTK (el motor que dibuja la ventana) tiene problemas conocidos de dibujado con el
//! driver propietario de NVIDIA (tirones al mover paneles, al hacer scroll, ventana en blanco).
//! Desactivar el renderizador DMA-BUF lo evita casi siempre sin perder aceleración útil.
//! Para volver al comportamiento por defecto: `TERVIEW_WEBKIT_DEFAULTS=1`.

/// Llamar al inicio de `run()`, cuando todavía no hay otros hilos.
pub fn prepare_environment() {
    #[cfg(target_os = "linux")]
    linux::prepare();
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{env, path::Path};

    const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    pub fn prepare() {
        if env::var_os("TERVIEW_WEBKIT_DEFAULTS").is_some() || env::var_os(DMABUF).is_some() {
            return;
        }
        if nvidia_driver_loaded() {
            // SAFETY: se llama al principio de `run()`, antes de que Tauri/GTK/tokio creen hilos,
            // así que nadie más lee ni escribe el entorno a la vez.
            unsafe { env::set_var(DMABUF, "1") };
            log::info!("Driver NVIDIA detectado: {DMABUF}=1 para un dibujado estable de WebKitGTK");
        }
    }

    /// Driver propietario de NVIDIA cargado (también en portátiles híbridos Intel/AMD + NVIDIA).
    fn nvidia_driver_loaded() -> bool {
        Path::new("/proc/driver/nvidia/version").exists() || Path::new("/sys/module/nvidia_drm").exists()
    }
}
