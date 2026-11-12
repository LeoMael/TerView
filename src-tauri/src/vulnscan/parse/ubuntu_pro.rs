//! `pro api u.pro.security.cves.v1` (Ubuntu): JSON con los paquetes afectados y los datos de cada CVE.
//!
//! ```json
//! {"data":{"attributes":{
//!   "packages":{"coreutils":{"current_version":"8.32-4.1ubuntu1.4",
//!               "cves":[{"name":"CVE-2016-2781","fix_status":"vulnerable","fix_version":null}]}},
//!   "cves":{"CVE-2016-2781":{"cvss_score":6.5,"priority":"low","description":"…"}}}}}
//! ```

use std::collections::HashMap;

use serde::Deserialize;

use super::{short, ToolFinding};

#[derive(Deserialize, Default)]
struct Root {
    #[serde(default)]
    data: Data,
    #[serde(default)]
    result: Option<String>,
}

#[derive(Deserialize, Default)]
struct Data {
    #[serde(default)]
    attributes: Attrs,
}

#[derive(Deserialize, Default)]
struct Attrs {
    #[serde(default)]
    packages: HashMap<String, Pkg>,
    #[serde(default)]
    cves: HashMap<String, CveInfo>,
}

#[derive(Deserialize, Default)]
struct Pkg {
    #[serde(default)]
    current_version: Option<String>,
    #[serde(default)]
    cves: Vec<PkgCve>,
}

#[derive(Deserialize, Default)]
struct PkgCve {
    name: String,
    #[serde(default)]
    fix_status: Option<String>,
    #[serde(default)]
    fix_version: Option<String>,
    #[serde(default)]
    fix_origin: Option<String>,
}

#[derive(Deserialize, Default)]
struct CveInfo {
    #[serde(default)]
    cvss_score: Option<f64>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// Devuelve los hallazgos o un error legible si la respuesta no es válida o dice «failure».
pub fn parse(text: &str) -> Result<Vec<ToolFinding>, String> {
    let root: Root = serde_json::from_str(text.trim()).map_err(|e| format!("respuesta de pro no válida: {e}"))?;
    if root.result.as_deref() == Some("failure") {
        return Err("pro respondió con un error (¿versión vieja del cliente pro?)".into());
    }
    let a = root.data.attributes;
    let mut names: Vec<&String> = a.packages.keys().collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let p = &a.packages[name];
        for c in &p.cves {
            let info = a.cves.get(&c.name);
            let has_fix = c.fix_version.is_some() || matches!(c.fix_status.as_deref(), Some("fixed" | "released"));
            out.push(ToolFinding {
                advisory: None,
                cves: vec![c.name.clone()],
                package: name.clone(),
                source: None,
                installed: p.current_version.clone(),
                fixed: c.fix_version.clone(),
                has_fix,
                severity: info.and_then(|i| i.priority.clone()),
                cvss: info.and_then(|i| i.cvss_score),
                summary: info.and_then(|i| i.description.as_deref()).map(|d| short(d, 200)),
                status: c.fix_status.clone().map(|s| match &c.fix_origin {
                    Some(o) if !o.is_empty() => format!("{s} ({o})"),
                    _ => s,
                }),
            });
        }
    }
    Ok(out)
}
