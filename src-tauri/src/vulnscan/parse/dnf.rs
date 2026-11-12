//! dnf / yum: avisos de seguridad pendientes.
//!
//! - dnf4 y yum: `updateinfo list --security` (aviso, gravedad, NEVRA) + `updateinfo info --security`
//!   (CVE y título de cada aviso).
//! - dnf5: `advisory list --security --json` + `advisory info --security --json` (los CVE salen de las
//!   referencias de Bugzilla y de la descripción; `--with-cve` en dnf5 no muestra nada).

use std::collections::HashMap;

use serde::Deserialize;

use super::rpm::split_nevra;
use super::{find_cves, short, ToolFinding};

/// Un aviso con sus CVE (de `info`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Advisory {
    pub id: String,
    pub title: Option<String>,
    pub severity: Option<String>,
    pub cves: Vec<String>,
    /// Frase de cada CVE en la descripción («acl: Symlink traversal…»).
    pub cve_text: HashMap<String, String>,
}

/// Fila de `updateinfo list`: (aviso, gravedad, NEVRA).
pub fn parse_list4(text: &str) -> Vec<(String, Option<String>, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() != 3 {
            continue;
        }
        let (id, kind, nevra) = (f[0], f[1], f[2]);
        if !kind.ends_with("/Sec.") && !kind.eq_ignore_ascii_case("security") {
            continue;
        }
        if !id.contains('-') || split_nevra(nevra).is_none() {
            continue;
        }
        let sev = kind.strip_suffix("/Sec.").map(str::to_string).filter(|s| !s.is_empty() && s != "None");
        out.push((id.to_string(), sev, nevra.to_string()));
    }
    out
}

/// Bloques de `updateinfo info`: «====», título, «====» y luego líneas «Clave: valor» (las líneas
/// que siguen a una clave empiezan por «           :»).
pub fn parse_info4(text: &str) -> Vec<Advisory> {
    #[derive(PartialEq)]
    enum St {
        Start,
        Title,
        Body,
    }
    let mut out: Vec<Advisory> = Vec::new();
    let mut cur = Advisory::default();
    let mut st = St::Start;
    let mut key = String::new();
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.starts_with("=====") {
            st = match st {
                St::Title => St::Body,
                St::Start | St::Body => {
                    if !cur.id.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                    cur = Advisory::default();
                    key.clear();
                    St::Title
                }
            };
            continue;
        }
        match st {
            St::Start => continue,
            St::Title => {
                if cur.title.is_none() && !line.trim().is_empty() {
                    cur.title = Some(line.trim().to_string());
                }
                continue;
            }
            St::Body => {}
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if !k.is_empty() {
            key = k.to_string();
        }
        match key.as_str() {
            "Update ID" => cur.id = v.to_string(),
            "Severity" => cur.severity = Some(v.to_string()).filter(|s| !s.is_empty() && s != "None"),
            "CVEs" => {
                for c in find_cves(v) {
                    if !cur.cves.contains(&c) {
                        cur.cves.push(c);
                    }
                }
            }
            "Description" => {
                // «* acl: Symlink traversal privilege escalation via libacl functions (CVE-2026-54369)»
                if let Some(t) = v.strip_prefix('*') {
                    let t = t.trim();
                    let cves = find_cves(t);
                    if cves.len() == 1 {
                        let text = t.rsplit_once('(').map(|(a, _)| a.trim()).unwrap_or(t);
                        cur.cve_text.entry(cves[0].clone()).or_insert_with(|| short(text, 200));
                    }
                }
            }
            _ => {}
        }
    }
    if !cur.id.is_empty() {
        out.push(cur);
    }
    out
}

/// Junta `list` e `info` (dnf4/yum) en hallazgos: uno por aviso, paquete y CVE.
pub fn findings4(list: &str, info: &str) -> Vec<ToolFinding> {
    let advisories: HashMap<String, Advisory> = parse_info4(info).into_iter().map(|a| (a.id.clone(), a)).collect();
    let mut out = Vec::new();
    for (id, sev, nevra) in parse_list4(list) {
        let Some((name, vr)) = split_nevra(&nevra) else { continue };
        let adv = advisories.get(&id);
        let severity = sev.or_else(|| adv.and_then(|a| a.severity.clone()));
        let title = adv.and_then(|a| a.title.clone());
        let cves = adv.map(|a| a.cves.clone()).unwrap_or_default();
        push_per_cve(&mut out, &id, &name, &vr, severity, title, &cves, adv.map(|a| &a.cve_text));
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn push_per_cve(
    out: &mut Vec<ToolFinding>,
    advisory: &str,
    package: &str,
    fixed: &str,
    severity: Option<String>,
    title: Option<String>,
    cves: &[String],
    cve_text: Option<&HashMap<String, String>>,
) {
    let base = ToolFinding {
        advisory: Some(advisory.to_string()),
        package: package.to_string(),
        fixed: Some(fixed.to_string()),
        has_fix: true,
        severity,
        summary: title,
        ..Default::default()
    };
    if cves.is_empty() {
        out.push(base);
        return;
    }
    for c in cves {
        let mut f = base.clone();
        f.cves = vec![c.clone()];
        if let Some(t) = cve_text.and_then(|m| m.get(c)) {
            f.summary = Some(t.clone());
        }
        out.push(f);
    }
}

#[derive(Deserialize)]
struct List5 {
    name: String,
    #[serde(default)]
    severity: Option<String>,
    nevra: String,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct Ref5 {
    #[serde(default, rename = "Title")]
    title: String,
}

#[derive(Deserialize)]
struct Info5 {
    #[serde(rename = "Name")]
    name: String,
    #[serde(default, rename = "Title")]
    title: Option<String>,
    #[serde(default, rename = "Severity")]
    severity: Option<String>,
    #[serde(default, rename = "Description")]
    description: Option<String>,
    #[serde(default)]
    references: Vec<Ref5>,
}

/// Junta `advisory list --json` e `info --json` (dnf5).
pub fn findings5(list: &str, info: &str) -> Vec<ToolFinding> {
    let list: Vec<List5> = serde_json::from_str(list.trim()).unwrap_or_default();
    let info: Vec<Info5> = serde_json::from_str(info.trim()).unwrap_or_default();
    let mut adv: HashMap<String, Advisory> = HashMap::new();
    for i in info {
        let mut a = Advisory {
            id: i.name.clone(),
            title: i.title.clone(),
            severity: i.severity.clone().filter(|s| !s.is_empty() && s != "None"),
            ..Default::default()
        };
        for r in &i.references {
            for c in find_cves(&r.title) {
                // «CVE-2026-8932 curl: libcurl: Security feature bypass … [fedora-all]»
                let text = r.title.trim_start_matches(c.as_str()).trim();
                let text = text.rsplit_once(" [").map(|(a, _)| a).unwrap_or(text);
                if !text.is_empty() {
                    a.cve_text.entry(c.clone()).or_insert_with(|| short(text, 200));
                }
                if !a.cves.contains(&c) {
                    a.cves.push(c);
                }
            }
        }
        for c in find_cves(i.description.as_deref().unwrap_or("")) {
            if !a.cves.contains(&c) {
                a.cves.push(c);
            }
        }
        adv.insert(a.id.clone(), a);
    }
    let mut out = Vec::new();
    for l in list {
        if l.kind.as_deref().is_some_and(|k| k != "security") {
            continue;
        }
        let Some((name, vr)) = split_nevra(&l.nevra) else { continue };
        let a = adv.get(&l.name);
        let severity = l.severity.clone().filter(|s| !s.is_empty() && s != "None").or_else(|| a.and_then(|a| a.severity.clone()));
        let title = a.and_then(|a| a.title.clone());
        let cves = a.map(|a| a.cves.clone()).unwrap_or_default();
        push_per_cve(&mut out, &l.name, &name, &vr, severity, title, &cves, a.map(|a| &a.cve_text));
    }
    out
}
