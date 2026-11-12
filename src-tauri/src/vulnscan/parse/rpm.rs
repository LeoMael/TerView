//! Paquetes RPM: `rpm -qa --qf RPM_QF` y nombres NEVRA de dnf/yum.

use crate::vulnscan::model::Package;

/// Nombre del paquete fuente a partir de `%{SOURCERPM}` («glibc-2.34-28.el9_0.src.rpm» → glibc).
pub fn source_name(srpm: &str) -> Option<String> {
    let s = srpm.trim();
    let s = s.strip_suffix(".src.rpm").or_else(|| s.strip_suffix(".nosrc.rpm"))?;
    // Quitar «-versión-release» (los dos últimos guiones).
    let i = s.rfind('-')?;
    let j = s[..i].rfind('-')?;
    let name = &s[..j];
    (!name.is_empty()).then(|| name.to_string())
}

/// Líneas de `rpm -qa --qf '%{NAME}\t%{EPOCHNUM}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\t%{SOURCERPM}[\t%{VENDOR}]\n'`.
/// Devuelve también el vendedor de cada paquete (para saber si es de la distro).
pub fn parse_qa(text: &str) -> Vec<(Package, Option<String>)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 6 {
            continue;
        }
        let name = f[0].trim();
        if name.is_empty() || name == "gpg-pubkey" {
            continue;
        }
        let epoch = f[1].trim();
        let ver = f[2].trim();
        let rel = f[3].trim();
        if ver.is_empty() {
            continue;
        }
        let vr = if rel.is_empty() || rel == "(none)" { ver.to_string() } else { format!("{ver}-{rel}") };
        let version = match epoch {
            "" | "0" | "(none)" => vr.clone(),
            e => format!("{e}:{vr}"),
        };
        let source = source_name(f[5]).unwrap_or_else(|| name.to_string());
        let vendor = f.get(6).map(|v| v.trim()).filter(|v| !v.is_empty() && *v != "(none)").map(str::to_string);
        out.push((
            Package {
                name: name.to_string(),
                source,
                version,
                // A OSV se manda SIN epoch (con «1:» delante AlmaLinux perdía avisos).
                source_version: vr,
                arch: Some(f[4].trim().to_string()).filter(|a| !a.is_empty()),
            },
            vendor,
        ));
    }
    out
}

/// Partes de un NEVRA («openssl-libs-1:3.5.9-1.fc44.x86_64»): (nombre, «epoch:versión-release»).
pub fn split_nevra(nevra: &str) -> Option<(String, String)> {
    let s = nevra.trim();
    // Quitar la arquitectura si la hay (último «.algo» que no tenga guiones).
    const ARCHES: &[&str] = &[
        "x86_64", "noarch", "i686", "i386", "aarch64", "ppc64le", "s390x", "armv7hl", "src", "ppc64", "riscv64",
    ];
    let s = match s.rsplit_once('.') {
        Some((head, arch)) if ARCHES.contains(&arch) => head,
        _ => s,
    };
    let i = s.rfind('-')?;
    let j = s[..i].rfind('-')?;
    let name = &s[..j];
    let vr = &s[j + 1..];
    if name.is_empty() || vr.is_empty() {
        return None;
    }
    Some((name.to_string(), vr.to_string()))
}

/// Quita el epoch («1:3.0.1-43» → «3.0.1-43»; «0:7.76.1-14.el9_0.5» → «7.76.1-14.el9_0.5»).
pub fn strip_epoch(v: &str) -> &str {
    match v.split_once(':') {
        Some((e, rest)) if !e.is_empty() && e.chars().all(|c| c.is_ascii_digit()) => rest,
        _ => v,
    }
}
