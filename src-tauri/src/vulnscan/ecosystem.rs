//! Ecosistemas de OSV.dev: de `os-release` al nombre exacto que acepta la API.
//!
//! La lista es FIJA (probada contra la API el 12/11/2026): un ecosistema inválido tumba el lote entero
//! de `querybatch`, así que nunca se arman nombres a ciegas.

use super::model::{DistroTool, OsRelease};
use super::parse::inventory::Detect;

/// Major de una versión («9.0» → «9», «12» → «12»).
fn major(v: &str) -> Option<&str> {
    let m = v.split('.').next()?.trim();
    (!m.is_empty() && m.chars().all(|c| c.is_ascii_digit())).then_some(m)
}

/// Major.minor («3.18.0» → «3.18»).
fn major_minor(v: &str) -> Option<String> {
    let mut it = v.split('.');
    let a = it.next()?.trim();
    let b = it.next()?.trim();
    let b: String = b.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!a.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && !b.is_empty()).then(|| format!("{a}.{b}"))
}

/// Ecosistema OSV de la distro. None = la distro no está en OSV (Fedora, RHEL, SLES, Arch…).
pub fn for_os(os: &OsRelease) -> Option<String> {
    match os.id.as_str() {
        "debian" => {
            if let Some(m) = major(&os.version_id) {
                Some(format!("Debian:{m}"))
            } else if os.pretty_name.contains("sid") || os.version_codename == "sid" {
                Some("Debian:sid".into())
            } else {
                None
            }
        }
        "ubuntu" => {
            let v = major_minor(&os.version_id)?;
            if os.version.contains("LTS") || os.pretty_name.contains("LTS") {
                Some(format!("Ubuntu:{v}:LTS"))
            } else {
                Some(format!("Ubuntu:{v}"))
            }
        }
        "alpine" => major_minor(&os.version_id).map(|v| format!("Alpine:v{v}")),
        "rocky" => major(&os.version_id).map(|m| format!("Rocky Linux:{m}")),
        "almalinux" => major(&os.version_id).map(|m| format!("AlmaLinux:{m}")),
        "opensuse-leap" => major_minor(&os.version_id).map(|v| format!("openSUSE:Leap {v}")),
        "opensuse-tumbleweed" => Some("openSUSE:Tumbleweed".into()),
        _ => None,
    }
}

/// Ecosistema extra de Ubuntu Pro (ESM), solo en LTS con Pro activado.
pub fn ubuntu_pro(os: &OsRelease, attached: bool) -> Option<String> {
    if !attached || os.id != "ubuntu" {
        return None;
    }
    let base = for_os(os)?;
    let v = base.strip_prefix("Ubuntu:")?.strip_suffix(":LTS")?;
    Some(format!("Ubuntu:Pro:{v}:LTS"))
}

/// En RPM se consulta el nombre fuente Y el binario (Rocky sale mejor por fuente, Alma por binario).
pub fn rpm_query_both(eco: &str) -> bool {
    eco.starts_with("Rocky Linux:") || eco.starts_with("AlmaLinux:") || eco.starts_with("openSUSE:")
}

/// Por qué la distro no tiene ecosistema (para el aviso del informe).
pub fn no_osv_reason(os: &OsRelease) -> String {
    match os.id.as_str() {
        "fedora" => "Fedora no está en OSV: solo se ven las actualizaciones de seguridad pendientes (dnf), \
                     no las vulnerabilidades que aún no tienen arreglo"
            .into(),
        "rhel" => "RHEL: la fuente principal es dnf (OSV agrupa Red Hat por repositorio y no se usa)".into(),
        "sles" | "sled" => "SLES: la fuente principal es zypper (OSV agrupa SUSE por módulo y no se usa)".into(),
        "centos" | "ol" | "amzn" => format!("{} no está en OSV: solo la herramienta de la distro", os.display()),
        "" => "No se pudo saber qué distro es".into(),
        _ => format!("Tu distro ({}) no tiene base de datos en OSV: solo programas sueltos e imágenes", os.display()),
    }
}

/// Qué herramienta de seguridad de la distro usar (si está instalada).
pub fn distro_tool(d: &Detect) -> Option<DistroTool> {
    let os = &d.os;
    if os.id == "ubuntu" && d.has("pro") {
        return Some(DistroTool::Pro);
    }
    if os.id == "debian" && d.has("debsecan") {
        return Some(DistroTool::Debsecan);
    }
    if (os.is_like("suse") || os.id.starts_with("opensuse") || os.id == "sles") && d.has("zypper") {
        return Some(DistroTool::Zypper);
    }
    if os.is_like("rhel") || os.is_like("fedora") || os.is_like("centos") || os.id == "amzn" {
        if d.has("dnf5") || (d.has("dnf") && d.dnf5) {
            return Some(DistroTool::Dnf5);
        }
        if d.has("dnf") {
            return Some(DistroTool::Dnf4);
        }
        if d.has("yum") {
            return Some(DistroTool::Yum);
        }
    }
    None
}

/// Paquete del kernel de la distro (se agrupa en una fila y pide reiniciar).
pub fn is_kernel(source: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "linux-signed", "linux-hwe", "linux-lts", "linux-virt", "linux-aws", "linux-azure", "linux-gcp",
        "linux-oracle", "linux-kvm", "linux-lowlatency", "linux-raspi", "linux-ibm", "linux-image-",
    ];
    source == "linux" || source == "kernel" || source == "kernel-rt" || PREFIXES.iter().any(|p| source.starts_with(p))
}

/// En Debian/Ubuntu el kernel firmado se consulta además como su paquete «sin firmar»
/// («linux-signed-amd64» → «linux»; «linux-signed-hwe-6.8» → «linux-hwe-6.8»).
pub fn kernel_alias(source: &str) -> Option<String> {
    let rest = source.strip_prefix("linux-signed")?;
    if rest.is_empty() || rest.starts_with("-amd64") || rest.starts_with("-arm64") || rest.starts_with("-i386") {
        return Some("linux".into());
    }
    Some(format!("linux{rest}"))
}

/// ¿El id es un aviso de una distro (sirve para el comando de actualizar)?
pub fn is_advisory(id: &str) -> bool {
    const P: &[&str] = &[
        "DSA-", "DLA-", "DTSA-", "RLSA-", "RXSA-", "ALSA-", "ALBA-", "ALEA-", "RHSA-", "USN-", "LSN-", "SUSE-SU-",
        "openSUSE-SU-", "FEDORA-", "ELSA-", "ALAS",
    ];
    P.iter().any(|p| id.starts_with(p))
}

/// Programa suelto: ecosistema y nombre en OSV, y versión a partir de la línea de `--version`.
/// None si no hay ecosistema útil (sudo, OpenSSH) o no se entiende la versión.
pub fn upstream(program: &str, version_line: &str) -> Option<(String, String, String)> {
    let v = extract_version(program, version_line)?;
    let (eco, name) = match program {
        "node" => ("Bitnami", "node".to_string()),
        "python3" => ("Bitnami", "python".into()),
        "php" => ("Bitnami", "php".into()),
        "java" => {
            // «1.8.0_381» (Java 8) no tiene el formato de Bitnami: no se consulta.
            if v.starts_with("1.") {
                return None;
            }
            ("Bitnami", "java".into())
        }
        "nginx" => ("Bitnami", "nginx".into()),
        "httpd" | "apache2" => ("Bitnami", "apache".into()),
        "postgres" => ("Bitnami", "postgresql".into()),
        "caddy" => ("Go", "github.com/caddyserver/caddy/v2".into()),
        "podman" => {
            let m = major(&v)?;
            let path = match m {
                "1" | "2" => "github.com/containers/podman".to_string(),
                m => format!("github.com/containers/podman/v{m}"),
            };
            ("Go", path)
        }
        "docker" => ("Go", "github.com/docker/docker".into()),
        _ => return None,
    };
    Some((eco.to_string(), name, v))
}

/// Saca la versión de la primera línea de `--version` de cada programa.
pub fn extract_version(program: &str, line: &str) -> Option<String> {
    let line = line.trim();
    let candidate = match program {
        // «openjdk version "17.0.1" 2021-10-19» / «java version "1.8.0_381"»
        "java" => line.split('"').nth(1).map(str::to_string),
        // «nginx version: nginx/1.20.0», «Server version: Apache/2.4.57 (Unix)»
        "nginx" | "httpd" | "apache2" => line.split('/').nth(1).and_then(|s| s.split_whitespace().next()).map(str::to_string),
        // «v2.6.0 h1:…», «v18.0.0»
        "caddy" | "node" => line.split_whitespace().next().map(|s| s.trim_start_matches('v').to_string()),
        // «Python 3.10.0», «PHP 8.1.0 (cli)…», «podman version 4.0.0», «Docker version 27.0.0, build x»,
        // «postgres (PostgreSQL) 15.3»
        _ => line
            .split_whitespace()
            .map(|w| w.trim_end_matches(',').trim_start_matches('v'))
            .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.'))
            .map(str::to_string),
    }?;
    // Solo la parte numérica inicial con puntos (y sufijos tipo «-rc1» fuera).
    let v: String = candidate.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let v = v.trim_end_matches('.').to_string();
    (v.contains('.') || program == "java").then_some(v).filter(|v| !v.is_empty())
}

/// ¿El vendedor/mantenedor del paquete dueño es la propia distro?
pub fn is_distro_vendor(os: &OsRelease, vendor: Option<&str>) -> bool {
    let Some(v) = vendor.map(|v| v.to_ascii_lowercase()) else { return true };
    if v.is_empty() {
        return true;
    }
    let known = [
        "debian", "ubuntu", "canonical", "red hat", "fedora", "rocky", "almalinux", "cloudlinux", "suse", "opensuse",
        "centos", "oracle", "amazon", "alpine",
    ];
    if known.iter().any(|k| v.contains(k)) {
        return true;
    }
    // Derivadas (Mint, Pop!_OS…) empaquetan con su nombre: si coincide con la distro, también vale.
    !os.id.is_empty() && v.contains(&os.id)
}
