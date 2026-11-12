//! Paquetes de Debian/Ubuntu: `dpkg-query -W` con `DPKG_FMT` y el archivo `var/lib/dpkg/status`.

use crate::vulnscan::model::Package;

/// Quita los «:arch» y los espacios de un nombre de paquete fuente («util-linux (2.38.1-5)» → util-linux).
fn clean_source(src: &str) -> (String, Option<String>) {
    let src = src.trim();
    // En `status`, «Source: util-linux (2.38.1-5)» lleva la versión fuente entre paréntesis.
    if let Some((name, rest)) = src.split_once(' ') {
        let ver = rest.trim().trim_start_matches('(').trim_end_matches(')').trim();
        return (name.to_string(), (!ver.is_empty()).then(|| ver.to_string()));
    }
    (src.to_string(), None)
}

/// Líneas de `dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${source:Package}\t${source:Version}[\t${Architecture}]\n'`.
/// Solo cuenta los instalados («ii», «hi»…: la segunda letra es `i`).
pub fn parse_query(text: &str) -> Vec<Package> {
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 3 {
            continue;
        }
        let status = f[0].trim();
        if status.as_bytes().get(1) != Some(&b'i') {
            continue;
        }
        let name = f[1].trim();
        let version = f[2].trim();
        if name.is_empty() || version.is_empty() {
            continue;
        }
        let source = f.get(3).map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(name);
        let source_version = f.get(4).map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(version);
        let arch = f.get(5).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        out.push(Package {
            name: name.to_string(),
            source: clean_source(source).0,
            version: version.to_string(),
            source_version: source_version.to_string(),
            arch,
        });
    }
    out
}

/// Archivo `status` (o los de `status.d/` de las imágenes «distroless»), ya filtrado o completo.
/// Cada estrofa empieza en «Package:» (aunque falte la línea en blanco entre estrofas).
pub fn parse_status(text: &str) -> Vec<Package> {
    #[derive(Default)]
    struct Cur {
        name: String,
        version: String,
        source: String,
        source_version: Option<String>,
        arch: Option<String>,
        status: Option<String>,
    }
    fn flush(cur: &mut Cur, out: &mut Vec<Package>) {
        let c = std::mem::take(cur);
        if c.name.is_empty() || c.version.is_empty() {
            return;
        }
        // Sin línea Status (status.d) = instalado. Si la hay, debe terminar en «installed».
        if let Some(st) = &c.status
            && !st.split_whitespace().last().is_some_and(|w| w == "installed")
        {
            return;
        }
        let (source, sv) = if c.source.is_empty() { (c.name.clone(), None) } else { clean_source(&c.source) };
        let source_version = c.source_version.or(sv).unwrap_or_else(|| c.version.clone());
        out.push(Package { name: c.name, source, version: c.version, source_version, arch: c.arch });
    }
    let mut out = Vec::new();
    let mut cur = Cur::default();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        match k {
            "Package" => {
                flush(&mut cur, &mut out);
                cur.name = v.to_string();
            }
            "Version" => cur.version = v.to_string(),
            "Source" => cur.source = v.to_string(),
            "Architecture" => cur.arch = Some(v.to_string()),
            "Status" => cur.status = Some(v.to_string()),
            _ => {}
        }
    }
    flush(&mut cur, &mut out);
    // En `status` el «Source» sin versión significa que la versión fuente es la del binario,
    // salvo binNMU («+b1»): se quita ese sufijo como hace dpkg con ${source:Version}.
    for p in &mut out {
        if p.source_version == p.version
            && let Some(i) = p.version.rfind("+b")
            && p.version[i + 2..].chars().all(|c| c.is_ascii_digit())
            && i + 2 < p.version.len()
        {
            p.source_version = p.version[..i].to_string();
        }
    }
    out
}
