//! Gravedad: primero la de la distro (sabe cómo está compilado su paquete), luego CVSS y si no hay
//! nada, «sin clasificar». Ver PENDIENTES 10.3.

use std::str::FromStr;

use super::model::Severity;

/// Gravedad a partir del texto de una distro o herramienta:
/// Red Hat/Rocky/Alma/Fedora (Critical/Important/Moderate/Low), Ubuntu (critical/high/medium/low/negligible),
/// Debian (high/medium/low/unimportant), SUSE (critical/important/moderate/low), Trivy (CRITICAL…),
/// Bitnami/GitHub (CRITICAL/HIGH/MODERATE/LOW).
pub fn from_text(text: &str) -> Option<Severity> {
    let t: String = text.trim().to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphabetic() || *c == ' ').collect();
    match t.trim() {
        "critical" => Some(Severity::Critical),
        "important" | "high" => Some(Severity::High),
        "moderate" | "medium" => Some(Severity::Medium),
        "low" | "negligible" | "unimportant" => Some(Severity::Low),
        _ => None,
    }
}

/// Banda de una puntuación CVSS: ≥ 9 crítica, 7–8,9 alta, 4–6,9 media, 0,1–3,9 baja.
pub fn from_score(score: f64) -> Severity {
    if score >= 9.0 {
        Severity::Critical
    } else if score >= 7.0 {
        Severity::High
    } else if score >= 4.0 {
        Severity::Medium
    } else if score > 0.0 {
        Severity::Low
    } else {
        Severity::Unknown
    }
}

/// Puntuación base de un vector CVSS v2, v3 o v4 («CVSS:3.1/AV:N/…», «CVSS:4.0/…»). None si no es válido.
pub fn cvss_score(vector: &str) -> Option<f64> {
    let v = vector.trim();
    let c = cvss::Cvss::from_str(v).ok()?;
    let s = c.score();
    (s.is_finite() && (0.0..=10.0).contains(&s)).then_some((s * 10.0).round() / 10.0)
}

/// Gravedad final.
pub fn combine(distro: Option<&str>, cvss: Option<f64>) -> Severity {
    if let Some(s) = distro.and_then(from_text) {
        return s;
    }
    match cvss {
        Some(c) => from_score(c),
        None => Severity::Unknown,
    }
}

/// «Moderate: curl security update» → «Moderate» (resúmenes de avisos RHSA/RLSA/ALSA en OSV).
pub fn from_summary_prefix(summary: &str) -> Option<String> {
    let (head, _) = summary.split_once(':')?;
    from_text(head).map(|_| head.trim().to_string())
}
