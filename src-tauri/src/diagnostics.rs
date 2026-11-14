//! Datos del sistema para el panel de diagnóstico (Ajustes → Avanzado → Diagnóstico).
//!
//! Solo lectura y sin datos sensibles: sistema, arquitectura, motor de la ventana y las variables
//! de entorno que cambian cómo dibuja WebKitGTK (ver `platform.rs`).

use serde::Serialize;

/// Variables de entorno que afectan al dibujado o al arranque y conviene ver en un informe.
const ENV_VARS: &[&str] = &[
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "SSHORUS_WEBKIT_DEFAULTS",
    "GDK_BACKEND",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "APPIMAGE",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    /// `None` = no está definida.
    pub value: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDiagnostics {
    /// `linux`, `windows`, `macos`…
    pub os: String,
    /// `x86_64`, `aarch64`…
    pub arch: String,
    /// Nombre legible del sistema (distribución en Linux), si se puede saber.
    pub os_name: Option<String>,
    /// Versión del núcleo (Linux) o del sistema.
    pub kernel: Option<String>,
    /// Versión del motor de la ventana (WebKitGTK, WebView2 o WKWebView).
    pub webview_version: Option<String>,
    /// Compilación de desarrollo (sin optimizar): mucho más lenta que la instalada.
    pub debug_build: bool,
    /// Driver propietario de NVIDIA cargado (solo Linux).
    pub nvidia_driver: bool,
    pub env: Vec<EnvVar>,
}

#[tauri::command]
pub fn app_diagnostics() -> AppDiagnostics {
    AppDiagnostics {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        os_name: os_name(),
        kernel: kernel(),
        webview_version: tauri::webview_version().ok(),
        debug_build: cfg!(debug_assertions),
        nvidia_driver: nvidia_driver(),
        env: ENV_VARS
            .iter()
            .map(|name| EnvVar {
                name: (*name).to_string(),
                value: std::env::var(name).ok(),
            })
            .collect(),
    }
}

#[cfg(target_os = "linux")]
fn os_name() -> Option<String> {
    let text = std::fs::read_to_string("/etc/os-release").ok()?;
    text.lines().find_map(|l| {
        l.strip_prefix("PRETTY_NAME=")
            .map(|v| v.trim_matches('"').to_string())
    })
}

#[cfg(not(target_os = "linux"))]
fn os_name() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn kernel() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(not(target_os = "linux"))]
fn kernel() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn nvidia_driver() -> bool {
    use std::path::Path;
    Path::new("/proc/driver/nvidia/version").exists()
        || Path::new("/sys/module/nvidia_drm").exists()
}

#[cfg(not(target_os = "linux"))]
fn nvidia_driver() -> bool {
    false
}
