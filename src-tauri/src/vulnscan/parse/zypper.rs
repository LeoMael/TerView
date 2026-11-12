//! `zypper --xmlout list-patches --category security` (openSUSE / SLES).
//!
//! Solo se probó con un sistema al día (lista vacía). El formato de cada parche sigue el de zypper:
//! ```xml
//! <update kind="patch" name="openSUSE-SLE-15.6-2024-1234" status="needed" category="security" severity="important">
//!   <summary>Security update for curl</summary>
//!   <issue-list><issue type="cve" id="CVE-2024-1234"/></issue-list>
//! </update>
//! ```
//! Se lee sin dependencias: atributos y texto de las etiquetas que hacen falta.

use super::{find_cves, short, ToolFinding};

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Valor del atributo `name` dentro de una etiqueta de apertura.
fn attr(tag: &str, name: &str) -> Option<String> {
    let mut i = 0;
    while let Some(pos) = tag[i..].find(name) {
        let at = i + pos;
        let before_ok = at == 0 || tag.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = tag[at + name.len()..].trim_start();
        if before_ok && let Some(rest) = rest.strip_prefix('=') {
            let rest = rest.trim_start();
            let q = rest.chars().next()?;
            if q == '"' || q == '\'' {
                let end = rest[1..].find(q)?;
                return Some(unescape(&rest[1..1 + end]));
            }
        }
        i = at + name.len();
    }
    None
}

/// Texto de la primera etiqueta `<name>…</name>` dentro de `block`.
fn text_of(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}");
    let start = block.find(&open)?;
    let gt = block[start..].find('>')? + start;
    if block[..gt].ends_with('/') {
        return None;
    }
    let close = format!("</{name}>");
    let end = block[gt..].find(&close)? + gt;
    Some(unescape(block[gt + 1..end].trim()))
}

pub fn parse(xml: &str) -> Vec<ToolFinding> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(pos) = rest.find("<update ") {
        let block_start = &rest[pos..];
        let Some(tag_end) = block_start.find('>') else { break };
        let tag = &block_start[..tag_end];
        let end = block_start.find("</update>").map(|e| e + "</update>".len()).unwrap_or(tag_end + 1);
        let block = &block_start[..end];
        rest = &block_start[end..];

        if attr(tag, "kind").is_some_and(|k| k != "patch") {
            continue;
        }
        if attr(tag, "category").is_some_and(|c| c != "security") {
            continue;
        }
        if attr(tag, "status").is_some_and(|s| s == "applied" || s == "not-needed") {
            continue;
        }
        let name = attr(tag, "name").unwrap_or_default();
        let summary = text_of(block, "summary");
        // Los CVE: <issue type="cve" id="CVE-…"/>; si no hay, los que aparezcan en el texto.
        let mut cves: Vec<String> = Vec::new();
        let mut r = block;
        while let Some(p) = r.find("<issue ") {
            let t = &r[p..];
            let e = t.find('>').unwrap_or(t.len());
            let itag = &t[..e];
            if attr(itag, "type").as_deref() == Some("cve")
                && let Some(id) = attr(itag, "id")
            {
                let id = if id.starts_with("CVE-") { id } else { format!("CVE-{id}") };
                if !cves.contains(&id) {
                    cves.push(id);
                }
            }
            r = &t[e..];
        }
        if cves.is_empty() {
            cves = find_cves(block);
        }
        // «Security update for curl» → curl.
        let package = summary
            .as_deref()
            .and_then(|s| s.rsplit_once(" for ").map(|(_, p)| p.trim().to_string()))
            .filter(|p| !p.is_empty() && !p.contains(' '))
            .unwrap_or_else(|| name.clone());
        let base = ToolFinding {
            advisory: Some(name.clone()).filter(|n| !n.is_empty()),
            package,
            has_fix: true,
            severity: attr(tag, "severity").filter(|s| !s.is_empty() && s != "unspecified"),
            summary: summary.as_deref().map(|s| short(s, 200)),
            ..Default::default()
        };
        if cves.is_empty() {
            out.push(base);
        } else {
            for c in cves {
                let mut f = base.clone();
                f.cves = vec![c];
                out.push(f);
            }
        }
    }
    out
}
