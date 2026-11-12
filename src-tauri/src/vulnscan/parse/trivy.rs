//! Salida de Trivy con `TRIVY_TEMPLATE` (una línea por hallazgo, columnas separadas por tabulador):
//! clase, id, paquete, instalada, arreglada, gravedad, estado y ruta.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrivyFinding {
    /// `os-pkgs` (paquetes de la distro) o `lang-pkgs` (npm, pip, jar, Go…).
    pub class: String,
    pub id: String,
    pub package: String,
    pub installed: String,
    pub fixed: Option<String>,
    /// CRITICAL, HIGH, MEDIUM, LOW, UNKNOWN.
    pub severity: String,
    /// fixed, affected, will_not_fix, fix_deferred, end_of_life…
    pub status: Option<String>,
    pub path: Option<String>,
}

pub fn parse(text: &str) -> Vec<TrivyFinding> {
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 6 {
            continue;
        }
        let id = f[1].trim();
        let package = f[2].trim();
        if id.is_empty() || package.is_empty() {
            continue;
        }
        let opt = |i: usize| f.get(i).map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
        out.push(TrivyFinding {
            class: f[0].trim().to_string(),
            id: id.to_string(),
            package: package.to_string(),
            installed: f[3].trim().to_string(),
            fixed: opt(4),
            severity: f[5].trim().to_uppercase(),
            status: opt(6),
            path: opt(7),
        });
    }
    out
}

/// Versión de «Version: 0.76.2».
pub fn version(line: &str) -> Option<String> {
    let v = line.trim().trim_start_matches("Version:").trim();
    (!v.is_empty()).then(|| v.to_string())
}
