//! Salidas de los scripts propios (`scripts.rs`): detección, inventario, usuarios e imágenes.

use std::collections::HashMap;

use super::trivy::{self, TrivyFinding};
use super::{apk, dpkg, osrelease, rpm, section, section_text, sections};
use crate::vulnscan::model::{ContainerRef, Engine, ImageInfo, OsRelease, Package, PackageManager};

fn pm_of(s: &str) -> PackageManager {
    match s.trim() {
        "dpkg" => PackageManager::Dpkg,
        "rpm" => PackageManager::Rpm,
        "apk" => PackageManager::Apk,
        _ => PackageManager::None,
    }
}

/// Fase 1.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Detect {
    pub os: OsRelease,
    pub kernel: String,
    pub arch: String,
    pub user: String,
    pub uid: Option<u32>,
    pub in_container: bool,
    pub pm: Option<PackageManager>,
    /// Herramientas encontradas (nombre).
    pub tools: Vec<String>,
    /// `dnf` es dnf5.
    pub dnf5: bool,
    pub trivy_version: Option<String>,
    pub pro_attached: bool,
    /// Docker responde para este usuario (socket accesible).
    pub docker_ok: bool,
    /// La salida llegó entera (con `@@end`).
    pub complete: bool,
}

impl Detect {
    pub fn has(&self, tool: &str) -> bool {
        self.tools.iter().any(|t| t == tool)
    }
}

pub fn parse_detect(text: &str) -> Detect {
    let secs = sections(text);
    let mut d = Detect { complete: section(&secs, "end").is_some(), ..Default::default() };
    if let Some(t) = section_text(&secs, "os") {
        d.os = osrelease::parse(&t);
    }
    if let Some(l) = section(&secs, "kernel").and_then(|l| l.first()) {
        let w: Vec<&str> = l.split_whitespace().collect();
        d.kernel = w.get(1).copied().unwrap_or("").to_string();
        d.arch = w.get(2).copied().unwrap_or("").to_string();
    }
    if let Some(l) = section(&secs, "id") {
        d.user = l.first().map(|s| s.trim().to_string()).unwrap_or_default();
        d.uid = l.get(1).and_then(|s| s.trim().parse().ok());
    }
    d.in_container = section(&secs, "container").and_then(|l| l.first()).is_some_and(|s| s.trim() == "yes");
    d.pm = section(&secs, "pm").and_then(|l| l.first()).map(|s| pm_of(s));
    if let Some(l) = section(&secs, "tools") {
        d.tools = l.iter().filter_map(|x| x.split('\t').next()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    }
    d.dnf5 = d.has("dnf5") || section(&secs, "dnf").and_then(|l| l.first()).is_some_and(|s| s.contains("dnf5"));
    d.trivy_version = section(&secs, "trivy").and_then(|l| l.first()).and_then(|s| trivy::version(s));
    d.pro_attached = section(&secs, "pro").and_then(|l| l.first()).is_some_and(|s| s.trim() == "attached");
    d.docker_ok = section(&secs, "docker").and_then(|l| l.first()).is_some_and(|s| s.trim() == "ok");
    d
}

/// Programa encontrado por el inventario (antes de interpretar su versión).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawProgram {
    pub name: String,
    pub path: String,
    pub owner: Option<String>,
    /// Vendedor (RPM) o mantenedor (dpkg) del paquete dueño.
    pub vendor: Option<String>,
    pub version_line: String,
    /// Viene de `$HOME`, `/usr/local` u `/opt` (runtimes instalados a mano).
    pub home: bool,
}

/// Fase 2.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Inventory {
    pub pm: Option<PackageManager>,
    pub packages: Vec<Package>,
    /// Vendedor de cada paquete RPM (binario → vendedor).
    pub vendors: HashMap<String, String>,
    pub programs: Vec<RawProgram>,
    pub complete: bool,
}

fn parse_program(line: &str, home: bool) -> Option<RawProgram> {
    let f: Vec<&str> = line.split('\t').collect();
    // 5 columnas (nombre, ruta, dueño, vendedor, versión); el prototipo tenía 4 (sin vendedor).
    let (name, path, owner, vendor, ver) = match f.len() {
        n if n >= 5 => (f[0], f[1], f[2], f[3], f[4..].join("\t")),
        4 => (f[0], f[1], f[2], "", f[3].to_string()),
        _ => return None,
    };
    let name = name.trim();
    if name.is_empty() || path.trim().is_empty() {
        return None;
    }
    let clean = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    // apk dice el paquete con su versión («sudo-1.9.17_p2-r2»): quedarse con el nombre.
    let owner = clean(owner).map(|o| apk::split_name_version(&o).map(|(n, _)| n).unwrap_or(o));
    Some(RawProgram {
        name: name.to_string(),
        path: path.trim().to_string(),
        owner,
        vendor: clean(vendor),
        version_line: ver.trim().to_string(),
        home,
    })
}

pub fn parse_packages(pm: PackageManager, text: &str) -> (Vec<Package>, HashMap<String, String>) {
    match pm {
        PackageManager::Dpkg => (dpkg::parse_query(text), HashMap::new()),
        PackageManager::Apk => (apk::parse_list(text), HashMap::new()),
        PackageManager::Rpm => {
            let mut vendors = HashMap::new();
            let pkgs = rpm::parse_qa(text)
                .into_iter()
                .map(|(p, v)| {
                    if let Some(v) = v {
                        vendors.insert(p.name.clone(), v);
                    }
                    p
                })
                .collect();
            (pkgs, vendors)
        }
        PackageManager::None => (Vec::new(), HashMap::new()),
    }
}

pub fn parse_inventory(text: &str) -> Inventory {
    let secs = sections(text);
    let mut inv = Inventory { complete: section(&secs, "end").is_some(), ..Default::default() };
    inv.pm = section(&secs, "pm").and_then(|l| l.first()).map(|s| pm_of(s));
    if let (Some(pm), Some(t)) = (inv.pm, section_text(&secs, "pkgs")) {
        let (p, v) = parse_packages(pm, &t);
        inv.packages = p;
        inv.vendors = v;
    }
    let mut seen = std::collections::HashSet::new();
    for (name, home) in [("tools", false), ("home", true)] {
        for line in section(&secs, name).unwrap_or(&[]) {
            if let Some(p) = parse_program(line, home)
                && seen.insert((p.name.clone(), p.path.clone()))
            {
                inv.programs.push(p);
            }
        }
    }
    inv
}

/// Fase 1b: usuarios con almacén propio y qué hay de root.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsersInfo {
    pub users: Vec<StoreUser>,
    pub root_podman: bool,
    pub root_docker: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreUser {
    pub name: String,
    pub uid: u32,
    pub home: String,
    pub podman: bool,
    pub docker: bool,
    /// Tiene /run/user/<uid> (sesión o lingering).
    pub runtime_dir: bool,
}

pub fn parse_users(text: &str) -> UsersInfo {
    let secs = sections(text);
    let mut out = UsersInfo::default();
    for line in section(&secs, "users").unwrap_or(&[]) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 6 {
            continue;
        }
        let Ok(uid) = f[1].trim().parse::<u32>() else { continue };
        out.users.push(StoreUser {
            name: f[0].trim().to_string(),
            uid,
            home: f[2].trim().to_string(),
            podman: f[3].trim() == "yes",
            docker: f[4].trim() == "yes",
            runtime_dir: f[5].trim() == "yes",
        });
    }
    for l in section(&secs, "root").unwrap_or(&[]) {
        match l.trim() {
            "podman" => out.root_podman = true,
            "docker" => out.root_docker = true,
            _ => {}
        }
    }
    out
}

/// Fase 4a: imágenes (agrupadas por id) con sus contenedores.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImageListing {
    pub images: Vec<ImageInfo>,
    pub error: Option<String>,
}

/// Id corto (12) sin «sha256:».
pub fn short_id(id: &str) -> String {
    id.trim().trim_start_matches("sha256:").chars().take(12).collect()
}

pub fn parse_images(engine: Engine, text: &str) -> ImageListing {
    let secs = sections(text);
    let mut out = ImageListing {
        error: section(&secs, "error").and_then(|l| l.first()).map(|s| s.to_string()),
        ..Default::default()
    };
    let mut errors: Vec<String> = Vec::new();
    for line in section(&secs, "images").unwrap_or(&[]) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 2 {
            if !line.trim().is_empty() {
                errors.push(line.trim().to_string());
            }
            continue;
        }
        let id = short_id(f[0]);
        if id.len() < 12 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let tag = f[1].trim();
        let tag = (!tag.is_empty() && !tag.contains("<none>")).then(|| tag.to_string());
        match out.images.iter_mut().find(|i| i.id == id) {
            Some(img) => {
                if let Some(t) = tag
                    && !img.tags.contains(&t)
                {
                    img.tags.push(t);
                }
            }
            None => out.images.push(ImageInfo { engine: Some(engine), id, tags: tag.into_iter().collect(), ..Default::default() }),
        }
    }
    for line in section(&secs, "containers").unwrap_or(&[]) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 4 {
            continue;
        }
        let img = short_id(f[2]);
        if let Some(i) = out.images.iter_mut().find(|i| !img.is_empty() && i.id == img) {
            i.containers.push(ContainerRef {
                id: short_id(f[0]),
                name: f[1].trim().trim_start_matches('/').to_string(),
                state: f[3].trim().to_string(),
            });
        }
    }
    if out.images.is_empty() && out.error.is_none() && !errors.is_empty() {
        out.error = Some(errors.join(" ").chars().take(300).collect());
    }
    out
}

/// Fase 4b: lo leído de una imagen.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImageRead {
    pub os: OsRelease,
    pub method: Option<String>,
    pub pm: Option<PackageManager>,
    pub packages: Vec<Package>,
    pub trivy: Option<(Option<String>, Vec<TrivyFinding>)>,
    pub error: Option<String>,
    pub complete: bool,
}

pub fn parse_image(text: &str) -> ImageRead {
    let secs = sections(text);
    let mut r = ImageRead {
        complete: section(&secs, "end").is_some(),
        error: section(&secs, "error").and_then(|l| l.first()).map(|s| s.to_string()),
        ..Default::default()
    };
    if let Some(t) = section_text(&secs, "os") {
        r.os = osrelease::parse(&t);
    }
    r.method = secs.iter().rev().find(|(n, _)| n == "method").and_then(|(_, l)| l.first()).map(|s| s.to_string());
    if let Some(t) = section_text(&secs, "trivy") {
        let ver = section(&secs, "trivyver").and_then(|l| l.first()).and_then(|s| trivy::version(s));
        r.trivy = Some((ver, trivy::parse(&t)));
        return r;
    }
    if let Some(t) = section_text(&secs, "dpkgstatus") {
        r.pm = Some(PackageManager::Dpkg);
        r.packages = dpkg::parse_status(&t);
    } else if let Some(t) = section_text(&secs, "apkdb") {
        r.pm = Some(PackageManager::Apk);
        r.packages = apk::parse_installed(&t);
    } else if let Some((_, lines)) = secs.iter().rev().find(|(n, _)| n == "rpm") {
        r.pm = Some(PackageManager::Rpm);
        r.packages = rpm::parse_qa(&lines.join("\n")).into_iter().map(|(p, _)| p).collect();
    } else if section(&secs, "nopkgdb").is_some() {
        r.pm = Some(PackageManager::None);
        if r.error.is_none() {
            r.error = Some("la imagen no tiene base de paquetes conocida (dpkg, apk o rpm)".into());
        }
    } else if section(&secs, "needrpm").is_some() && r.error.is_none() {
        r.error = Some("imagen RPM y el servidor no tiene rpm".into());
    }
    if r.packages.is_empty() && r.error.is_none() && r.pm.is_some() && r.pm != Some(PackageManager::None) {
        r.error = Some("no se pudo leer la lista de paquetes".into());
    }
    r
}
