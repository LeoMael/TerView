//! Lectura de las salidas del servidor (scripts de `scripts.rs` y herramientas de la distro).
//!
//! Todos los parsers son tolerantes: una línea que no se entiende se salta, nunca hace fallar el
//! análisis entero.

pub mod apk;
pub mod debsecan;
pub mod dnf;
pub mod dpkg;
pub mod inventory;
pub mod osrelease;
pub mod rpm;
pub mod trivy;
pub mod ubuntu_pro;
pub mod zypper;

/// Divide una salida en secciones `@@nombre`. Devuelve (nombre, líneas) en orden; el texto de
/// la cabecera después del nombre («@@rc 0», «@@error …») queda como primera línea de la sección
/// con la clave `nombre`. Lo que haya antes de la primera cabecera se ignora.
pub fn sections(text: &str) -> Vec<(String, Vec<&str>)> {
    let mut out: Vec<(String, Vec<&str>)> = Vec::new();
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(head) = line.strip_prefix("@@") {
            let (name, rest) = match head.find([' ', '=']) {
                Some(i) => (&head[..i], head[i + 1..].trim()),
                None => (head.trim(), ""),
            };
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                let mut lines = Vec::new();
                if !rest.is_empty() {
                    lines.push(rest);
                }
                out.push((name.to_string(), lines));
                continue;
            }
        }
        if let Some((_, lines)) = out.last_mut() {
            lines.push(line);
        }
    }
    out
}

/// Líneas de la primera sección con ese nombre.
pub fn section<'a>(secs: &'a [(String, Vec<&'a str>)], name: &str) -> Option<&'a [&'a str]> {
    secs.iter().find(|(n, _)| n == name).map(|(_, l)| l.as_slice())
}

/// Texto de la primera sección con ese nombre (líneas unidas con «\n»).
pub fn section_text(secs: &[(String, Vec<&str>)], name: &str) -> Option<String> {
    section(secs, name).map(|l| l.join("\n"))
}

/// Hallazgo que da una herramienta de la distro (dnf, debsecan, pro, zypper).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolFinding {
    /// Aviso de la distro (RLSA-…, FEDORA-…, openSUSE-SU-…).
    pub advisory: Option<String>,
    pub cves: Vec<String>,
    /// Paquete binario (como lo nombra la herramienta).
    pub package: String,
    /// Paquete fuente, si la herramienta lo dice.
    pub source: Option<String>,
    pub installed: Option<String>,
    pub fixed: Option<String>,
    pub has_fix: bool,
    /// Gravedad de la distro en su texto original.
    pub severity: Option<String>,
    pub cvss: Option<f64>,
    pub summary: Option<String>,
    pub status: Option<String>,
}

/// ¿Es un id de CVE?
pub fn is_cve(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("CVE-") else { return false };
    let mut parts = rest.splitn(2, '-');
    let year = parts.next().unwrap_or("");
    let num = parts.next().unwrap_or("");
    year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()) && num.len() >= 4 && num.chars().all(|c| c.is_ascii_digit())
}

/// Todos los CVE que aparecen en un texto, sin repetir y en orden.
pub fn find_cves(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(pos) = text[i..].find("CVE-") {
        let start = i + pos;
        let mut end = start + 4;
        while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'-') {
            end += 1;
        }
        let cand = text[start..end].trim_end_matches('-');
        if is_cve(cand) && !out.iter().any(|c| c == cand) {
            out.push(cand.to_string());
        }
        i = end.max(start + 4);
    }
    out
}

/// Recorta un texto a `max` caracteres (por caracteres, no bytes) en una línea.
pub fn short(text: &str, max: usize) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        one
    } else {
        let mut s: String = one.chars().take(max.saturating_sub(1)).collect();
        s = s.trim_end().to_string();
        s.push('…');
        s
    }
}
