//! `debsecan --suite <nombre> --format detail` (Debian).
//!
//! Un bloque por CVE y paquete binario instalado:
//! ```text
//! CVE-2024-28085 (fixed)
//!   wall in util-linux through 2.40, often installed with setgid tty permi ...
//!   installed: bsdutils 1:2.38.1-5+b1
//!              (built from util-linux 2.38.1-5)
//!   fixed on branch:   util-linux 2.38.1-5+deb12u1 (source package)
//!   fix is available for the selected suite (bookworm)
//! ```
//! Marcas de la cabecera: `fixed`, `remotely exploitable`, `low/medium/high urgency`, `obsolete`.

use super::{is_cve, short, ToolFinding};

pub fn parse_detail(text: &str) -> Vec<ToolFinding> {
    let mut out: Vec<ToolFinding> = Vec::new();
    let mut cur: Option<ToolFinding> = None;
    let mut first_text = true;
    for raw in text.lines() {
        let line = raw.trim_end();
        if !line.starts_with(' ') && !line.is_empty() {
            let mut parts = line.splitn(2, ' ');
            let id = parts.next().unwrap_or("");
            if is_cve(id) || id.starts_with("TEMP-") {
                if let Some(c) = cur.take()
                    && !c.package.is_empty()
                {
                    out.push(c);
                }
                let flags = parts.next().unwrap_or("").trim().trim_start_matches('(').trim_end_matches(')');
                let mut f = ToolFinding { cves: vec![id.to_string()], ..Default::default() };
                for fl in flags.split(',').map(str::trim) {
                    match fl {
                        "fixed" => f.has_fix = true,
                        "obsolete" => f.status = Some("obsolete".into()),
                        u if u.ends_with(" urgency") => f.severity = Some(u.trim_end_matches(" urgency").to_string()),
                        _ => {}
                    }
                }
                cur = Some(f);
                first_text = true;
            }
            continue;
        }
        let Some(f) = cur.as_mut() else { continue };
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("installed:") {
            let mut w = rest.split_whitespace();
            f.package = w.next().unwrap_or("").to_string();
            f.installed = w.next().map(str::to_string);
        } else if let Some(rest) = t.strip_prefix("(built from ") {
            let rest = rest.trim_end_matches(')');
            f.source = rest.split_whitespace().next().map(str::to_string);
        } else if t.starts_with("fix is available") {
            f.has_fix = true;
        } else if t.starts_with("fixed ") || t.starts_with("fix ") {
            // «fixed in unstable», «fixed on branch»: no dicen la versión para esta suite.
        } else if first_text && !t.is_empty() {
            f.summary = Some(short(t.trim_end_matches(" ...").trim_end_matches("..."), 200));
            first_text = false;
        }
    }
    if let Some(c) = cur
        && !c.package.is_empty()
    {
        out.push(c);
    }
    out
}
