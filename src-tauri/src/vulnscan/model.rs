//! Tipos del escáner: lo que llega del servidor, el inventario y el informe final.
//!
//! El informe (`Report`) es lo que se guarda en el historial, se exporta y ve la interfaz
//! (`src/api/vulnscan.ts` tiene los mismos tipos en TypeScript).

use serde::{Deserialize, Serialize};

// ───────────── Entrada: salidas en bruto de las fases del servidor ─────────────

/// Salida de un comando del servidor, tal cual.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Herramienta de seguridad de la distro (fase 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistroTool {
    /// `dnf updateinfo` (dnf4: RHEL/Rocky/Alma 8 y 9, Fedora vieja).
    Dnf4,
    /// `dnf advisory` (dnf5: Fedora 41+).
    Dnf5,
    /// `yum updateinfo` (CentOS 7, Amazon Linux 2): misma salida que dnf4.
    Yum,
    Debsecan,
    /// `pro api u.pro.security.cves.v1` (Ubuntu).
    Pro,
    /// `zypper list-patches` (openSUSE, SLES).
    Zypper,
}

impl DistroTool {
    pub fn label(self) -> &'static str {
        match self {
            DistroTool::Dnf4 => "dnf updateinfo",
            DistroTool::Dnf5 => "dnf advisory",
            DistroTool::Yum => "yum updateinfo",
            DistroTool::Debsecan => "debsecan",
            DistroTool::Pro => "Ubuntu Pro (pro api)",
            DistroTool::Zypper => "zypper list-patches",
        }
    }
}

/// Motor de contenedores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Podman,
    Docker,
}

impl Engine {
    pub fn cmd(self) -> &'static str {
        match self {
            Engine::Podman => "podman",
            Engine::Docker => "docker",
        }
    }
}

/// Lectura de una imagen (fase 4).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageRaw {
    pub engine: Option<Engine>,
    /// Dueño del almacén (None = el usuario conectado o root sin elegir usuario).
    pub user: Option<String>,
    /// Salida de `images_list_script` de ese usuario y motor (imágenes y contenedores).
    /// Solo hace falta una vez por (motor, usuario): en el resto de imágenes puede ir vacía.
    pub listing: Option<String>,
    /// ID de la imagen leída (vacío si `output` es solo el listado).
    pub image_id: String,
    /// Salida de `image_script` (None si no se leyó: límite, cancelado…).
    pub output: Option<RawOutput>,
    /// Error del lado de la interfaz (p. ej. «tardó demasiado»).
    pub error: Option<String>,
}

/// Todo lo que la interfaz (o el MCP) recoge del servidor para un análisis.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanInput {
    pub server_id: String,
    /// Fase 1 (`detect_script`).
    pub detect: RawOutput,
    /// Fase 2 (`inventory_script`).
    pub inventory: RawOutput,
    /// Fase 3: herramienta de la distro usada y su salida.
    pub distro_tool: Option<DistroTool>,
    pub distro_output: Option<RawOutput>,
    /// Fase 4.
    pub images: Vec<ImageRaw>,
    /// El análisis se hizo con root o sudo.
    pub elevated: bool,
    /// Consultar OSV.dev (desactivable en Ajustes).
    pub use_osv: bool,
    /// Avisos de las fases que corrió la interfaz (fallos, saltadas, sin sudo…).
    pub notes: Vec<ScanNote>,
    /// Duración de las fases del servidor (ms), para el informe.
    pub server_ms: u64,
}

// ───────────── Inventario ─────────────

/// Un paquete o programa instalado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    /// Paquete binario (o el programa: «node»).
    pub name: String,
    /// Paquete fuente (Debian/RPM/Alpine «origen»). Igual que `name` si no se sabe.
    pub source: String,
    /// Versión instalada tal como la muestra el gestor (con epoch si lo tiene).
    pub version: String,
    /// Versión del paquete fuente (Debian) o la que se manda a OSV (RPM sin epoch).
    pub source_version: String,
    pub arch: Option<String>,
}

/// Gestor de paquetes del sistema o de una imagen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Dpkg,
    Rpm,
    Apk,
    None,
}

/// Datos de `/etc/os-release`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OsRelease {
    pub id: String,
    pub id_like: Vec<String>,
    pub version_id: String,
    pub version: String,
    pub version_codename: String,
    pub pretty_name: String,
    pub name: String,
}

// ───────────── Informe ─────────────

/// Gravedad unificada (de mayor a menor).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    /// Sin clasificar.
    Unknown,
}

impl Severity {
    pub fn label(self) -> &'static str {
        match self {
            Severity::Critical => "crítica",
            Severity::High => "alta",
            Severity::Medium => "media",
            Severity::Low => "baja",
            Severity::Unknown => "sin clasificar",
        }
    }
}

/// De dónde sale un hallazgo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    Osv,
    Distro,
    Trivy,
}

/// Qué se analizó: el sistema, los programas sueltos o una imagen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    System,
    Runtime,
    Image,
}

/// Contenedor que usa una imagen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRef {
    pub id: String,
    pub name: String,
    pub state: String,
}

/// Datos de una imagen analizada.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageInfo {
    pub engine: Option<Engine>,
    /// ID corto (12).
    pub id: String,
    /// repositorio:etiqueta (puede haber varias o ninguna).
    pub tags: Vec<String>,
    pub containers: Vec<ContainerRef>,
    /// Distro de dentro de la imagen («Debian GNU/Linux 12»).
    pub os: Option<String>,
    /// Cómo se leyó: «montada», «rpm de la imagen», «docker cp», «Trivy 0.76.2».
    pub method: Option<String>,
}

/// Algo que se analizó (el sistema, los runtimes del usuario, una imagen).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// "system", "runtime", "image:<motor>:<usuario>:<id>".
    pub key: String,
    pub kind: TargetKind,
    /// «Sistema», «Programas sueltos», «Imagen nginx:1.25 (a1b2c3d4e5f6)».
    pub label: String,
    /// Dueño (imágenes de otro usuario o de root).
    pub user: Option<String>,
    pub ecosystem: Option<String>,
    pub packages: u32,
    pub image: Option<ImageInfo>,
    /// Qué fuentes lo cubrieron.
    pub sources: Vec<SourceId>,
    /// Si no se pudo leer, por qué.
    pub error: Option<String>,
}

/// Un hallazgo: una vulnerabilidad (CVE o aviso sin CVE) en un paquete de un objetivo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Clave única en el informe: `<id>|<paquete>|<objetivo>`.
    pub key: String,
    /// CVE-… o, si no hay CVE, el aviso (DSA-…, FEDORA-…, GHSA-…).
    pub id: String,
    /// Otros ids de la misma vulnerabilidad (DEBIAN-CVE-…, ids de OSV).
    pub aliases: Vec<String>,
    /// Avisos de la distro que la arreglan (DSA-…, RLSA-…, FEDORA-…, USN-…).
    pub advisories: Vec<String>,
    /// Paquete (fuente en Debian/RPM/Alpine; el programa en los sueltos).
    pub package: String,
    /// Paquetes binarios instalados de ese paquete fuente (para el comando de actualizar).
    pub binaries: Vec<String>,
    pub installed: String,
    pub fixed: Option<String>,
    pub has_fix: bool,
    pub severity: Severity,
    /// Gravedad según la distro, en su texto original («Important», «low», «unimportant»).
    pub distro_severity: Option<String>,
    pub cvss: Option<f64>,
    pub cvss_vector: Option<String>,
    /// Debian lo marca «unimportant»: oculto por defecto.
    pub unimportant: bool,
    /// Estado del arreglo según la fuente (Trivy `Status`, `fix_status` de Ubuntu…).
    pub status: Option<String>,
    /// Título corto (la descripción completa se pide aparte a la caché de OSV).
    pub summary: Option<String>,
    pub target: String,
    pub sources: Vec<SourceId>,
    pub kernel: bool,
    pub ecosystem: Option<String>,
    /// Es un programa sin paquete de la distro (versión de origen): resultado aproximado.
    pub upstream: bool,
}

/// Recuento por gravedad.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub unknown: u32,
    pub total: u32,
    pub with_fix: u32,
    /// Ocultos por defecto («unimportant» de Debian); no cuentan en el resto.
    pub unimportant: u32,
}

/// Una fuente usada y cómo fue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: SourceId,
    /// «OSV.dev», «dnf updateinfo», «Trivy 0.76.2».
    pub label: String,
    pub used: bool,
    /// Por qué no se usó o qué pasó.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteLevel {
    Info,
    Warn,
    Error,
}

/// Aviso del análisis («Sin sudo: no se ven…», «OSV no disponible»…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanNote {
    /// Fase: "detect", "inventory", "distro", "images", "osv", "merge".
    pub phase: String,
    pub level: NoteLevel,
    pub text: String,
}

impl ScanNote {
    pub fn new(phase: &str, level: NoteLevel, text: impl Into<String>) -> Self {
        ScanNote { phase: phase.into(), level, text: text.into() }
    }
}

/// Lo que se sabe del servidor.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostInfo {
    pub os: OsRelease,
    pub kernel: String,
    pub arch: String,
    pub package_manager: Option<PackageManager>,
    /// Ecosistema OSV de la distro (None = no está en OSV).
    pub ecosystem: Option<String>,
    /// Corre dentro de un contenedor (el kernel es del anfitrión).
    pub in_container: bool,
    /// Herramientas encontradas: «trivy», «debsecan», «pro», «dnf», «zypper», «podman», «docker».
    pub tools: Vec<String>,
}

/// Programa clave encontrado (sudo, OpenSSH, nginx…, y runtimes de $HOME).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramInfo {
    pub name: String,
    pub path: String,
    pub version: Option<String>,
    /// Paquete dueño del binario (None = suelto).
    pub owner: Option<String>,
    /// Viene de un repositorio de terceros (no de la distro).
    pub third_party: bool,
    /// Ecosistema con el que se consultó como programa suelto.
    pub upstream_ecosystem: Option<String>,
}

/// Explicación de la IA guardada con el informe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExplanation {
    pub model: String,
    pub created_at: String,
    pub text: String,
}

/// Informe de un análisis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub server_id: String,
    /// RFC 3339.
    pub created_at: String,
    pub duration_ms: u64,
    pub elevated: bool,
    pub host: HostInfo,
    pub sources: Vec<SourceInfo>,
    pub targets: Vec<Target>,
    pub programs: Vec<ProgramInfo>,
    pub findings: Vec<Finding>,
    pub summary: Summary,
    pub notes: Vec<ScanNote>,
    pub ai: Option<AiExplanation>,
    /// Lo que se mandó a OSV en el último lote (para «ver qué se envía»): solo ecosistema, nombre y versión.
    #[serde(default)]
    pub osv_sample: Vec<OsvQueryView>,
}

/// Una consulta a OSV tal como se envía (para mostrarla).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsvQueryView {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
}

/// Resumen de un análisis para la lista del historial.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMeta {
    pub id: String,
    pub created_at: String,
    pub duration_ms: u64,
    pub elevated: bool,
    pub summary: Summary,
    pub sources: Vec<String>,
    pub distro: String,
    pub has_ai: bool,
}

impl Report {
    pub fn meta(&self) -> ReportMeta {
        ReportMeta {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            duration_ms: self.duration_ms,
            elevated: self.elevated,
            summary: self.summary.clone(),
            sources: self.sources.iter().filter(|s| s.used).map(|s| s.label.clone()).collect(),
            distro: if self.host.os.pretty_name.is_empty() { self.host.os.id.clone() } else { self.host.os.pretty_name.clone() },
            has_ai: self.ai.is_some(),
        }
    }
}

/// Detalle de una vulnerabilidad para el panel lateral (de la caché de OSV).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VulnDetail {
    pub id: String,
    pub summary: Option<String>,
    pub details: Option<String>,
    pub aliases: Vec<String>,
    pub published: Option<String>,
    pub modified: Option<String>,
    pub references: Vec<String>,
}
