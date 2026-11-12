//! Ajustes del escáner (van dentro de `settings.json`, campo `vulnscan`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VulnScanSettings {
    /// Consultar OSV.dev desde este PC. Apagado = «solo herramientas del servidor».
    pub use_osv: bool,
    /// Usar la herramienta de seguridad de la distro (dnf, debsecan, pro, zypper).
    pub use_distro_tool: bool,
    /// Usar Trivy si está instalado en el servidor.
    pub use_trivy: bool,
    /// Analizar imágenes de contenedores.
    pub scan_images: bool,
    /// Máximo de imágenes por usuario (1..=500).
    pub image_limit: u32,
    /// Usuarios elegidos por servidor (con sudo). Vacío o ausente = todos.
    pub users_by_server: HashMap<String, Vec<String>>,
}

impl Default for VulnScanSettings {
    fn default() -> Self {
        VulnScanSettings {
            use_osv: true,
            use_distro_tool: true,
            use_trivy: true,
            scan_images: true,
            image_limit: 50,
            users_by_server: HashMap::new(),
        }
    }
}

impl VulnScanSettings {
    pub fn sanitized(mut self) -> Self {
        self.image_limit = self.image_limit.clamp(1, 500);
        self.users_by_server.retain(|k, _| !k.trim().is_empty());
        self
    }
}
