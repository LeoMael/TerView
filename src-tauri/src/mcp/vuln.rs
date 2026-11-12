//! Resumen de un informe del escáner de vulnerabilidades para el asistente (`get_vuln_report` y
//! `scan_vulnerabilities`): recuento por gravedad, fuentes, avisos y los hallazgos más graves, con
//! un límite. El informe entero (miles de filas) no se manda nunca: se ve en TerView.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::vulnscan::model::{Finding, NoteLevel, Report, Severity};

/// Hallazgos que se muestran por defecto y como máximo.
pub const DEFAULT_LIMIT: u32 = 20;
pub const MAX_LIMIT: u32 = 100;
/// Largo máximo del título de cada hallazgo y de cada aviso.
const MAX_SUMMARY_CHARS: usize = 160;
/// Avisos del análisis que se muestran como máximo.
const MAX_NOTES: usize = 10;

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn severity_code(s: Severity) -> &'static str {
    match s {
        Severity::Critical => "critical",
        Severity::High => "high",
        Severity::Medium => "medium",
        Severity::Low => "low",
        Severity::Unknown => "unknown",
    }
}

/// Orden de «los más importantes»: gravedad, con arreglo antes, CVSS más alto, id.
fn rank(a: &Finding, b: &Finding) -> std::cmp::Ordering {
    a.severity
        .cmp(&b.severity)
        .then(b.has_fix.cmp(&a.has_fix))
        .then(b.cvss.unwrap_or(-1.0).total_cmp(&a.cvss.unwrap_or(-1.0)))
        .then(a.id.cmp(&b.id))
        .then(a.package.cmp(&b.package))
}

/// Resumen del informe `r` del servidor `server` con como mucho `limit` hallazgos (1–100).
pub fn summarize(server: &str, r: &Report, limit: Option<u32>) -> Value {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    let labels: HashMap<&str, &str> = r.targets.iter().map(|t| (t.key.as_str(), t.label.as_str())).collect();
    let mut shown: Vec<&Finding> = r.findings.iter().filter(|f| !f.unimportant).collect();
    let total = shown.len();
    shown.sort_by(|a, b| rank(a, b));
    shown.truncate(limit);
    let findings: Vec<Value> = shown
        .iter()
        .map(|f| {
            json!({
                "id": f.id,
                "severity": severity_code(f.severity),
                "cvss": f.cvss,
                "package": f.package,
                "installed": f.installed,
                "fixed": f.fixed,
                "hasFix": f.has_fix,
                "target": labels.get(f.target.as_str()).copied().unwrap_or(f.target.as_str()),
                "kernel": f.kernel,
                "approximate": f.upstream,
                "summary": f.summary.as_deref().map(|s| clip(s, MAX_SUMMARY_CHARS)),
            })
        })
        .collect();
    let sources: Vec<Value> = r
        .sources
        .iter()
        .map(|s| json!({ "name": s.label, "used": s.used, "note": s.note }))
        .collect();
    let notes: Vec<String> = r
        .notes
        .iter()
        .filter(|n| n.level != NoteLevel::Info)
        .take(MAX_NOTES)
        .map(|n| clip(&n.text, MAX_SUMMARY_CHARS))
        .collect();
    let images = r.targets.iter().filter(|t| t.image.is_some()).count();
    let unreadable: Vec<String> = r
        .targets
        .iter()
        .filter_map(|t| t.error.as_ref().map(|e| clip(&format!("{}: {e}", t.label), MAX_SUMMARY_CHARS)))
        .take(MAX_NOTES)
        .collect();
    let os = if r.host.os.pretty_name.is_empty() { r.host.os.id.clone() } else { r.host.os.pretty_name.clone() };
    let s = &r.summary;
    let headline = format!(
        "{} críticas, {} altas, {} medias, {} bajas y {} sin clasificar ({} en total, {} con arreglo).",
        s.critical, s.high, s.medium, s.low, s.unknown, s.total, s.with_fix
    );
    json!({
        "server": server,
        "reportId": r.id,
        "createdAt": r.created_at,
        "durationSecs": (r.duration_ms as f64 / 100.0).round() / 10.0,
        "withSudo": r.elevated,
        "os": os,
        "kernel": r.host.kernel,
        "summary": {
            "critical": s.critical,
            "high": s.high,
            "medium": s.medium,
            "low": s.low,
            "unknown": s.unknown,
            "total": s.total,
            "withFix": s.with_fix,
            "hiddenUnimportant": s.unimportant,
            "text": headline,
        },
        "sources": sources,
        "notes": notes,
        "images": images,
        "unreadableTargets": unreadable,
        "topFindings": findings,
        "shown": shown.len(),
        "of": total,
        "more": if total > shown.len() {
            format!(
                "Se muestran los {} más graves de {total}. La lista completa, el detalle y el comando para actualizar están en TerView → Administración → Vulnerabilidades.",
                shown.len()
            )
        } else {
            "El detalle y el comando para actualizar están en TerView → Administración → Vulnerabilidades.".to_string()
        },
    })
}

/// Informes de ejemplo para las pruebas (también las de `mcp/tests.rs`).
#[cfg(test)]
pub(crate) mod fixtures {
    use crate::vulnscan::model::*;

    pub fn finding(id: &str, sev: Severity, fix: bool, cvss: Option<f64>) -> Finding {
        Finding {
            key: format!("{id}|openssl|system"),
            id: id.into(),
            aliases: vec![],
            advisories: vec![],
            package: "openssl".into(),
            binaries: vec![],
            installed: "3.0.1".into(),
            fixed: fix.then(|| "3.0.9".into()),
            has_fix: fix,
            severity: sev,
            distro_severity: None,
            cvss,
            cvss_vector: None,
            unimportant: false,
            status: None,
            summary: Some("x".repeat(400)),
            target: "system".into(),
            sources: vec![SourceId::Osv],
            kernel: false,
            ecosystem: None,
            upstream: false,
        }
    }

    pub fn report(findings: Vec<Finding>) -> Report {
        Report {
            id: "r1".into(),
            server_id: "s1".into(),
            created_at: "2026-11-12T10:00:00Z".into(),
            duration_ms: 12_345,
            elevated: false,
            host: HostInfo::default(),
            sources: vec![],
            targets: vec![Target {
                key: "system".into(),
                kind: TargetKind::System,
                label: "Sistema".into(),
                user: None,
                ecosystem: None,
                packages: 10,
                image: None,
                sources: vec![],
                error: None,
            }],
            programs: vec![],
            summary: Summary { total: findings.len() as u32, ..Default::default() },
            findings,
            notes: vec![],
            ai: None,
            osv_sample: vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{finding, report};
    use super::*;
    use crate::vulnscan::model::Severity;

    #[test]
    fn most_severe_first_and_limited() {
        let mut unimportant = finding("CVE-0", Severity::Critical, true, Some(9.9));
        unimportant.unimportant = true;
        let r = report(vec![
            finding("CVE-1", Severity::Low, true, None),
            finding("CVE-2", Severity::High, false, Some(8.0)),
            finding("CVE-3", Severity::High, true, Some(7.0)),
            finding("CVE-4", Severity::Critical, false, Some(9.8)),
            unimportant,
        ]);
        let v = summarize("web", &r, Some(3));
        let ids: Vec<&str> = v["topFindings"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["CVE-4", "CVE-3", "CVE-2"]);
        assert_eq!(v["shown"], 3);
        assert_eq!(v["of"], 4, "los «unimportant» no cuentan");
        assert_eq!(v["topFindings"][0]["target"], "Sistema");
        assert_eq!(v["topFindings"][0]["severity"], "critical");
        assert!(v["topFindings"][0]["summary"].as_str().unwrap().chars().count() <= MAX_SUMMARY_CHARS);
        assert!(v["more"].as_str().unwrap().contains("3 más graves de 4"));
        assert_eq!(v["durationSecs"], 12.3);
        // Límites: 0 → 1, enorme → 100.
        assert_eq!(summarize("web", &r, Some(0))["shown"], 1);
        let many = report((0..150).map(|i| finding(&format!("CVE-{i}"), Severity::Medium, true, None)).collect());
        assert_eq!(summarize("web", &many, Some(10_000))["shown"], MAX_LIMIT);
        assert_eq!(summarize("web", &many, None)["shown"], DEFAULT_LIMIT);
    }
}
