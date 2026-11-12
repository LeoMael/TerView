//! Paquetes de Alpine: `apk list -I` y el archivo `lib/apk/db/installed`.

use crate::vulnscan::model::Package;

/// ¿Parece una versión de Alpine («3.1.0-r4», «20230506-r0», «1.36.0-r9»)?
fn is_apk_version(v: &str) -> bool {
    let Some((ver, rel)) = v.rsplit_once("-r") else { return false };
    !ver.is_empty() && ver.starts_with(|c: char| c.is_ascii_digit()) && !rel.is_empty() && rel.chars().all(|c| c.is_ascii_digit())
}

/// Separa «libcrypto3-3.1.0-r4» en («libcrypto3», «3.1.0-r4»).
pub fn split_name_version(s: &str) -> Option<(String, String)> {
    // La versión empieza en el primer «-<dígito>» tras el cual lo que queda es una versión válida.
    let b = s.as_bytes();
    for i in 1..b.len().saturating_sub(1) {
        if b[i] == b'-' && b[i + 1].is_ascii_digit() && is_apk_version(&s[i + 1..]) {
            return Some((s[..i].to_string(), s[i + 1..].to_string()));
        }
    }
    None
}

/// Líneas de `apk list -I`: «nombre-versión arch {origen} (licencia) [installed]».
pub fn parse_list(text: &str) -> Vec<Package> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.contains("[installed") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(nv) = parts.next() else { continue };
        let arch = parts.next().map(str::to_string);
        let Some((name, version)) = split_name_version(nv) else { continue };
        let origin = line
            .find('{')
            .and_then(|a| line[a + 1..].find('}').map(|b| line[a + 1..a + 1 + b].to_string()))
            .filter(|o| !o.is_empty())
            .unwrap_or_else(|| name.clone());
        out.push(Package { name, source: origin, source_version: version.clone(), version, arch });
    }
    out
}

/// `lib/apk/db/installed` (campos `P:` nombre, `V:` versión, `A:` arquitectura, `o:` origen).
pub fn parse_installed(text: &str) -> Vec<Package> {
    let mut out = Vec::new();
    let (mut p, mut v, mut a, mut o) = (String::new(), String::new(), None::<String>, String::new());
    let mut flush = |p: &mut String, v: &mut String, a: &mut Option<String>, o: &mut String| {
        if !p.is_empty() && !v.is_empty() {
            let src = if o.is_empty() { p.clone() } else { o.clone() };
            out.push(Package { name: p.clone(), source: src, version: v.clone(), source_version: v.clone(), arch: a.clone() });
        }
        p.clear();
        v.clear();
        *a = None;
        o.clear();
    };
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            flush(&mut p, &mut v, &mut a, &mut o);
            continue;
        }
        if let Some(x) = line.strip_prefix("P:") {
            if !p.is_empty() {
                flush(&mut p, &mut v, &mut a, &mut o);
            }
            p = x.trim().to_string();
        } else if let Some(x) = line.strip_prefix("V:") {
            v = x.trim().to_string();
        } else if let Some(x) = line.strip_prefix("A:") {
            a = Some(x.trim().to_string());
        } else if let Some(x) = line.strip_prefix("o:") {
            o = x.trim().to_string();
        }
    }
    flush(&mut p, &mut v, &mut a, &mut o);
    out
}
