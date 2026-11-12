//! Exportar un informe: JSON (el mismo formato del historial) y Markdown (resumen + tabla por gravedad).

use super::model::{Report, Severity, SourceId, TargetKind};

/// Nombre genérico cuando se pide quitar el del servidor.
pub const ANON_SERVER: &str = "servidor-1";

/// JSON del informe. Con `hide_server`, el id del servidor se sustituye por «servidor-1».
pub fn to_json(report: &Report, hide_server: bool) -> String {
    let mut r = report.clone();
    if hide_server {
        r.server_id = ANON_SERVER.into();
    }
    serde_json::to_string_pretty(&r).unwrap_or_else(|_| "{}".into())
}

fn esc(s: &str) -> String {
    s.replace('|', "\\|").replace(['\n', '\r'], " ")
}

fn source_label(s: SourceId) -> &'static str {
    match s {
        SourceId::Osv => "OSV",
        SourceId::Distro => "distro",
        SourceId::Trivy => "Trivy",
    }
}

/// Markdown legible. `server_name` = None para no ponerlo («servidor-1»).
pub fn to_markdown(report: &Report, server_name: Option<&str>) -> String {
    let mut md = String::new();
    let name = server_name.filter(|s| !s.trim().is_empty()).unwrap_or(ANON_SERVER);
    md.push_str(&format!("# Vulnerabilidades de {}\n\n", esc(name)));
    md.push_str(&format!("- **Fecha:** {}\n", report.created_at));
    md.push_str(&format!("- **Sistema:** {}", esc(&report.host.os.display())));
    if !report.host.kernel.is_empty() {
        md.push_str(&format!(" · kernel {}", esc(&report.host.kernel)));
    }
    md.push('\n');
    md.push_str(&format!("- **Con sudo:** {}\n", if report.elevated { "sí" } else { "no" }));
    let used: Vec<String> = report.sources.iter().filter(|s| s.used).map(|s| s.label.clone()).collect();
    md.push_str(&format!("- **Fuentes:** {}\n\n", if used.is_empty() { "ninguna".into() } else { used.join(", ") }));

    let s = &report.summary;
    md.push_str("## Resumen\n\n| Crítica | Alta | Media | Baja | Sin clasificar | Con arreglo |\n|---|---|---|---|---|---|\n");
    md.push_str(&format!("| {} | {} | {} | {} | {} | {} |\n\n", s.critical, s.high, s.medium, s.low, s.unknown, s.with_fix));
    if s.unimportant > 0 {
        md.push_str(&format!(
            "Además hay {} que la distro considera sin importancia (no se listan).\n\n",
            s.unimportant
        ));
    }
    if !report.notes.is_empty() {
        md.push_str("## Avisos del análisis\n\n");
        for n in &report.notes {
            md.push_str(&format!("- {}\n", esc(&n.text)));
        }
        md.push('\n');
    }
    let label_of = |key: &str| -> String {
        report
            .targets
            .iter()
            .find(|t| t.key == key)
            .map(|t| match t.kind {
                TargetKind::System => "Sistema".to_string(),
                TargetKind::Runtime => "Programa suelto".to_string(),
                TargetKind::Image => t.label.clone(),
            })
            .unwrap_or_else(|| key.to_string())
    };
    for sev in [Severity::Critical, Severity::High, Severity::Medium, Severity::Low, Severity::Unknown] {
        let rows: Vec<_> = report.findings.iter().filter(|f| f.severity == sev && !f.unimportant).collect();
        if rows.is_empty() {
            continue;
        }
        let mut title = sev.label().to_string();
        if let Some(c) = title.get_mut(0..1) {
            c.make_ascii_uppercase();
        }
        md.push_str(&format!("## {title} ({})\n\n", rows.len()));
        md.push_str("| CVE / aviso | Paquete | Instalada | Arreglada | Dónde | Fuente | Resumen |\n|---|---|---|---|---|---|---|\n");
        for f in rows {
            let fixed = f.fixed.clone().unwrap_or_else(|| if f.has_fix { "sí".into() } else { "—".into() });
            let src: Vec<&str> = f.sources.iter().map(|s| source_label(*s)).collect();
            md.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} | {} |\n",
                esc(&f.id),
                esc(&f.package),
                esc(&f.installed),
                esc(&fixed),
                esc(&label_of(&f.target)),
                src.join(", "),
                esc(f.summary.as_deref().unwrap_or("")),
            ));
        }
        md.push('\n');
    }
    if let Some(ai) = &report.ai {
        md.push_str(&format!("## Explicación generada por IA ({}) — revísala\n\n{}\n", esc(&ai.model), ai.text));
    }
    md
}
