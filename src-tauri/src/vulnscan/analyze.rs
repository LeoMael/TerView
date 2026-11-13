//! Fases 5 y 6: con lo que llegó del servidor, consulta OSV, junta todas las fuentes, quita
//! duplicados por CVE y calcula la gravedad. El resultado es el `Report` que se guarda.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::cache::OsvCache;
use super::ecosystem;
use super::model::*;
use super::osv::{self, OsvApi, OsvVuln, Query};
use super::parse::inventory::{self, Detect, ImageRead, Inventory};
use super::parse::trivy::TrivyFinding;
use super::parse::{debsecan, dnf, ubuntu_pro, zypper, ToolFinding};
use super::parse::{section, sections};
use super::severity;
use crate::error::{AppError, AppResult};

/// Progreso: (fase, hechos, total, texto).
pub type ProgressFn<'a> = &'a (dyn Fn(&str, usize, usize, &str) + Send + Sync);

/// Para qué sirve cada consulta a OSV (una consulta puede servir a varios objetivos).
#[derive(Debug, Clone)]
struct QueryUse {
    query: Query,
    target: String,
    /// Paquete con el que se muestra el hallazgo (fuente o programa).
    package: String,
    installed: String,
    binaries: Vec<String>,
    upstream: bool,
}

/// Lo que se saca de un objetivo con paquetes.
struct PkgTarget<'a> {
    key: &'a str,
    eco: &'a str,
    pm: PackageManager,
    packages: &'a [Package],
    /// Paquetes binarios que NO se consultan como de la distro (de terceros).
    skip: &'a BTreeSet<String>,
}

fn package_queries(t: &PkgTarget<'_>, extra_eco: Option<&str>, out: &mut Vec<QueryUse>) {
    // Agrupar binarios por (fuente, versión fuente).
    let mut groups: BTreeMap<(String, String), Vec<&Package>> = BTreeMap::new();
    for p in t.packages {
        if t.skip.contains(&p.name) {
            continue;
        }
        groups.entry((p.source.clone(), p.source_version.clone())).or_default().push(p);
    }
    let both = t.pm == PackageManager::Rpm && ecosystem::rpm_query_both(t.eco);
    let ecos: Vec<&str> = std::iter::once(t.eco).chain(extra_eco).collect();
    for ((source, sv), bins) in groups {
        let binaries: Vec<String> = bins.iter().map(|b| b.name.clone()).collect();
        for eco in &ecos {
            let mut names = vec![source.clone()];
            if t.pm != PackageManager::Rpm
                && let Some(alias) = ecosystem::kernel_alias(&source)
            {
                names.push(alias);
            }
            if both {
                for b in &binaries {
                    if !names.contains(b) {
                        names.push(b.clone());
                    }
                }
            }
            for name in names {
                out.push(QueryUse {
                    query: Query { ecosystem: eco.to_string(), name, version: sv.clone() },
                    target: t.key.to_string(),
                    package: source.clone(),
                    installed: sv.clone(),
                    binaries: binaries.clone(),
                    upstream: false,
                });
            }
        }
    }
}

/// Junta hallazgos por clave.
#[derive(Default)]
struct Merger {
    map: BTreeMap<String, Finding>,
}

fn generic_summary(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.ends_with("security update") || l.contains("security update for") || l.ends_with("- security update")
}

fn push_unique(v: &mut Vec<String>, items: impl IntoIterator<Item = String>) {
    for i in items {
        if !i.is_empty() && !v.contains(&i) {
            v.push(i);
        }
    }
}

impl Merger {
    fn add(&mut self, f: Finding) {
        match self.map.get_mut(&f.key) {
            None => {
                self.map.insert(f.key.clone(), f);
            }
            Some(e) => {
                push_unique(&mut e.aliases, f.aliases);
                push_unique(&mut e.advisories, f.advisories);
                push_unique(&mut e.binaries, f.binaries);
                let from_distro = f.sources.contains(&SourceId::Distro);
                for s in f.sources {
                    if !e.sources.contains(&s) {
                        e.sources.push(s);
                    }
                }
                e.sources.sort();
                if e.installed.is_empty() {
                    e.installed = f.installed;
                }
                // La versión arreglada de la distro manda; si no hay, la primera que llegue.
                if f.fixed.is_some() && (e.fixed.is_none() || from_distro) {
                    e.fixed = f.fixed;
                }
                e.has_fix |= f.has_fix;
                e.unimportant |= f.unimportant;
                let rank = |s: &Option<String>| s.as_deref().and_then(severity::from_text).unwrap_or(Severity::Unknown);
                if rank(&f.distro_severity) < rank(&e.distro_severity) {
                    e.distro_severity = f.distro_severity;
                }
                if f.cvss.unwrap_or(-1.0) > e.cvss.unwrap_or(-1.0) {
                    e.cvss = f.cvss;
                    e.cvss_vector = f.cvss_vector;
                }
                if e.status.is_none() {
                    e.status = f.status;
                }
                let better = match (&e.summary, &f.summary) {
                    (None, Some(_)) => true,
                    (Some(a), Some(b)) => generic_summary(a) && !generic_summary(b),
                    _ => false,
                };
                if better {
                    e.summary = f.summary;
                }
                if e.ecosystem.is_none() {
                    e.ecosystem = f.ecosystem;
                }
            }
        }
    }

    fn finish(self) -> Vec<Finding> {
        let mut v: Vec<Finding> = self
            .map
            .into_values()
            .map(|mut f| {
                // Debian «unimportant»: oculto por defecto, cuenta como baja.
                if f.distro_severity.as_deref().is_some_and(|s| s.trim().eq_ignore_ascii_case("unimportant")) {
                    f.unimportant = true;
                }
                f.severity = severity::combine(f.distro_severity.as_deref(), f.cvss);
                f.advisories.sort();
                f.aliases.retain(|a| a != &f.id && !f.advisories.contains(a));
                f
            })
            .collect();
        v.sort_by(|a, b| a.severity.cmp(&b.severity).then_with(|| a.package.cmp(&b.package)).then_with(|| a.id.cmp(&b.id)));
        v
    }
}

fn key(id: &str, package: &str, target: &str) -> String {
    format!("{id}|{package}|{target}")
}

#[allow(clippy::too_many_arguments)]
fn new_finding(
    id: &str,
    package: &str,
    target: &str,
    source: SourceId,
    installed: &str,
    kernel: bool,
    ecosystem: Option<&str>,
    upstream: bool,
) -> Finding {
    Finding {
        key: key(id, package, target),
        id: id.to_string(),
        aliases: Vec::new(),
        advisories: Vec::new(),
        package: package.to_string(),
        binaries: Vec::new(),
        installed: installed.to_string(),
        fixed: None,
        has_fix: false,
        severity: Severity::Unknown,
        distro_severity: None,
        cvss: None,
        cvss_vector: None,
        unimportant: false,
        status: None,
        summary: None,
        target: target.to_string(),
        sources: vec![source],
        kernel,
        ecosystem: ecosystem.map(str::to_string),
        upstream,
    }
}

/// Hallazgos de OSV para una consulta.
fn osv_findings(u: &QueryUse, v: &OsvVuln, merger: &mut Merger, system_target: bool) {
    let eco = &u.query.ecosystem;
    let name = &u.query.name;
    let cves = v.cves();
    let ids: Vec<String> = if cves.is_empty() { vec![v.id.clone()] } else { cves };
    let mut advisories: Vec<String> = Vec::new();
    for x in std::iter::once(&v.id).chain(&v.related).chain(&v.upstream) {
        if ecosystem::is_advisory(x) && !advisories.contains(x) {
            advisories.push(x.clone());
        }
    }
    let others: Vec<String> = v.other_ids().into_iter().filter(|x| !ecosystem::is_advisory(x)).collect();
    let fixed = v.fixed_for(eco, name, &u.installed);
    let dsev = v.distro_severity(eco, name);
    let cvss = v.cvss(eco, name);
    let title = v.title();
    let kernel = system_target && ecosystem::is_kernel(&u.package);
    for id in ids {
        let mut f = new_finding(&id, &u.package, &u.target, SourceId::Osv, &u.installed, kernel, Some(eco), u.upstream);
        f.aliases = others.clone();
        if v.id != id {
            push_unique(&mut f.aliases, [v.id.clone()]);
        }
        f.advisories = advisories.clone();
        f.binaries = u.binaries.clone();
        f.fixed = fixed.clone();
        f.has_fix = fixed.is_some();
        f.distro_severity = dsev.clone();
        f.unimportant = dsev.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("unimportant"));
        if let Some((s, vec)) = &cvss {
            f.cvss = Some(*s);
            f.cvss_vector = Some(vec.clone());
        }
        f.summary = title.clone();
        merger.add(f);
    }
}

/// Hallazgos de la herramienta de la distro.
fn tool_findings(items: Vec<ToolFinding>, inv: &Inventory, merger: &mut Merger) {
    let src_of: HashMap<&str, &Package> = inv.packages.iter().map(|p| (p.name.as_str(), p)).collect();
    for t in items {
        // Paquete fuente: el que diga la herramienta, el del inventario o el propio nombre.
        let (source, installed) = match (&t.source, src_of.get(t.package.as_str())) {
            (Some(s), p) => (s.clone(), t.installed.clone().or_else(|| p.map(|p| p.version.clone()))),
            (None, Some(p)) => (p.source.clone(), t.installed.clone().or_else(|| Some(p.version.clone()))),
            (None, None) => (t.package.clone(), t.installed.clone()),
        };
        let ids: Vec<String> = if t.cves.is_empty() { t.advisory.clone().into_iter().collect() } else { t.cves.clone() };
        for id in ids {
            let mut f = new_finding(
                &id,
                &source,
                "system",
                SourceId::Distro,
                installed.as_deref().unwrap_or(""),
                ecosystem::is_kernel(&source),
                None,
                false,
            );
            if let Some(a) = &t.advisory
                && a != &id
            {
                f.advisories.push(a.clone());
            }
            f.binaries = vec![t.package.clone()];
            f.fixed = t.fixed.clone();
            f.has_fix = t.has_fix;
            f.distro_severity = t.severity.clone();
            f.cvss = t.cvss;
            f.status = t.status.clone();
            f.summary = t.summary.clone();
            merger.add(f);
        }
    }
}

fn trivy_findings(items: &[TrivyFinding], target: &str, merger: &mut Merger) {
    for t in items {
        let mut f = new_finding(&t.id, &t.package, target, SourceId::Trivy, &t.installed, false, None, false);
        f.fixed = t.fixed.clone();
        f.has_fix = t.fixed.is_some() || t.status.as_deref() == Some("fixed");
        f.distro_severity = Some(t.severity.clone()).filter(|s| s != "UNKNOWN");
        f.status = t.status.clone();
        if t.class == "lang-pkgs"
            && let Some(p) = &t.path
        {
            f.binaries = vec![p.clone()];
        }
        merger.add(f);
    }
}

/// Parte la salida de la herramienta de la distro según cuál fue.
fn parse_tool(tool: DistroTool, out: &RawOutput) -> Result<Vec<ToolFinding>, String> {
    let secs = sections(&out.stdout);
    if section(&secs, "end").is_none() {
        return Err(if out.timed_out { "tardó demasiado".into() } else { "la salida llegó incompleta".into() });
    }
    // Código de salida de cada comando («@@rc N» después de su sección).
    let mut rcs = secs.iter().filter(|(n, _)| n == "rc").filter_map(|(_, l)| l.first().and_then(|s| s.trim().parse::<i32>().ok()));
    let text = |name: &str| super::parse::section_text(&secs, name).unwrap_or_default();
    match tool {
        DistroTool::Dnf4 | DistroTool::Yum => {
            let rc = rcs.next().unwrap_or(0);
            let list = text("list");
            if rc != 0 && list.trim().is_empty() {
                return Err(format!("{} terminó con código {rc}", tool.label()));
            }
            Ok(dnf::findings4(&list, &text("info")))
        }
        DistroTool::Dnf5 => {
            let rc = rcs.next().unwrap_or(0);
            let list = text("list");
            if rc != 0 && list.trim().is_empty() {
                return Err(format!("dnf advisory terminó con código {rc}"));
            }
            Ok(dnf::findings5(&list, &text("info")))
        }
        DistroTool::Debsecan => {
            let rc = rcs.next().unwrap_or(0);
            let t = text("debsecan");
            if rc != 0 && t.trim().is_empty() {
                return Err(format!("debsecan terminó con código {rc} (¿sin acceso a security-tracker.debian.org?)"));
            }
            Ok(debsecan::parse_detail(&t))
        }
        DistroTool::Pro => ubuntu_pro::parse(&text("pro")),
        DistroTool::Zypper => {
            let t = text("zypper");
            if !t.contains("<stream") && !t.contains("<update-status") {
                return Err("zypper no devolvió XML (¿hace falta root para refrescar los repositorios?)".into());
            }
            Ok(zypper::parse(&t))
        }
    }
}

/// Programa clave → info para el informe y, si va suelto, su consulta a OSV.
fn programs(inv: &Inventory, os: &OsRelease, out_q: &mut Vec<QueryUse>) -> Vec<ProgramInfo> {
    let mut list = Vec::new();
    for p in &inv.programs {
        let third = p.owner.is_some() && !ecosystem::is_distro_vendor(os, p.vendor.as_deref());
        let loose = p.owner.is_none() || third;
        let version = ecosystem::extract_version(&p.name, &p.version_line).or_else(|| {
            // sudo, ssh: se muestra la línea tal cual.
            Some(p.version_line.clone()).filter(|s| !s.is_empty())
        });
        let mut info = ProgramInfo {
            name: p.name.clone(),
            path: p.path.clone(),
            version,
            owner: p.owner.clone(),
            third_party: third,
            upstream_ecosystem: None,
        };
        if loose && let Some((eco, name, v)) = ecosystem::upstream(&p.name, &p.version_line) {
            info.upstream_ecosystem = Some(eco.clone());
            out_q.push(QueryUse {
                query: Query { ecosystem: eco, name, version: v.clone() },
                target: "runtime".into(),
                package: p.name.clone(),
                installed: v,
                binaries: vec![p.path.clone()],
                upstream: true,
            });
        }
        list.push(info);
    }
    list
}

/// Resumen (cuántas de cada gravedad) de una lista de hallazgos.
pub fn summary_of(findings: &[Finding]) -> Summary {
    let mut summary = Summary::default();
    for f in findings {
        if f.unimportant {
            summary.unimportant += 1;
            continue;
        }
        summary.total += 1;
        if f.has_fix {
            summary.with_fix += 1;
        }
        match f.severity {
            Severity::Critical => summary.critical += 1,
            Severity::High => summary.high += 1,
            Severity::Medium => summary.medium += 1,
            Severity::Low => summary.low += 1,
            Severity::Unknown => summary.unknown += 1,
        }
    }
    summary
}

fn image_label(img: &ImageInfo, user: Option<&str>) -> String {
    let name = img.tags.first().map(|t| t.as_str()).unwrap_or("(sin etiqueta)");
    match user {
        Some(u) => format!("Imagen {name} ({}) · {u}", img.id),
        None => format!("Imagen {name} ({})", img.id),
    }
}

/// Analiza todo. `api` = None si OSV está desactivado.
pub async fn analyze<A: OsvApi>(
    input: &ScanInput,
    api: Option<&A>,
    cache: &OsvCache,
    cancel: &CancellationToken,
    progress: ProgressFn<'_>,
) -> AppResult<Report> {
    let started = Instant::now();
    let mut notes: Vec<ScanNote> = input.notes.clone();
    let detect: Detect = inventory::parse_detect(&input.detect.stdout);
    if !detect.complete {
        notes.push(ScanNote::new("detect", NoteLevel::Warn, "La detección del sistema llegó incompleta"));
    }
    let inv = inventory::parse_inventory(&input.inventory.stdout);
    if !inv.complete {
        notes.push(ScanNote::new(
            "inventory",
            NoteLevel::Warn,
            if input.inventory.timed_out { "El inventario tardó demasiado: puede faltar algo" } else { "El inventario llegó incompleto" },
        ));
    }
    let os = detect.os.clone();
    let eco = ecosystem::for_os(&os);
    let pm = inv.pm.or(detect.pm);
    let host = HostInfo {
        os: os.clone(),
        kernel: detect.kernel.clone(),
        arch: detect.arch.clone(),
        package_manager: pm,
        ecosystem: eco.clone(),
        in_container: detect.in_container,
        tools: detect.tools.clone(),
    };
    if detect.in_container {
        notes.push(ScanNote::new("detect", NoteLevel::Info, "Es un contenedor: el kernel es el del anfitrión y no se analiza"));
    }

    let mut queries: Vec<QueryUse> = Vec::new();
    let mut targets: Vec<Target> = Vec::new();
    let mut merger = Merger::default();
    let mut sources_used: BTreeSet<SourceId> = BTreeSet::new();

    // ── Sistema ──
    // Paquetes RPM de terceros (vendedor que no es la distro) no se consultan como de la distro.
    let mut skip: BTreeSet<String> = inv
        .vendors
        .iter()
        .filter(|(_, v)| !ecosystem::is_distro_vendor(&os, Some(v)))
        .map(|(n, _)| n.clone())
        .collect();
    for p in &inv.programs {
        if let Some(o) = &p.owner
            && !ecosystem::is_distro_vendor(&os, p.vendor.as_deref())
        {
            skip.insert(o.clone());
        }
    }
    let mut system = Target {
        key: "system".into(),
        kind: TargetKind::System,
        label: "Sistema".into(),
        user: None,
        ecosystem: eco.clone(),
        packages: inv.packages.len() as u32,
        image: None,
        sources: Vec::new(),
        error: None,
    };
    match (&eco, pm) {
        (Some(e), Some(pm)) if !inv.packages.is_empty() => {
            let pro = ecosystem::ubuntu_pro(&os, detect.pro_attached);
            package_queries(&PkgTarget { key: "system", eco: e, pm, packages: &inv.packages, skip: &skip }, pro.as_deref(), &mut queries);
        }
        (None, _) => notes.push(ScanNote::new("osv", NoteLevel::Info, ecosystem::no_osv_reason(&os))),
        _ => {}
    }
    if inv.packages.is_empty() {
        system.error = Some("No se pudo leer la lista de paquetes".into());
    }
    if !skip.is_empty() {
        notes.push(ScanNote::new(
            "inventory",
            NoteLevel::Info,
            format!(
                "Paquetes de repositorios de terceros (no se comparan con la distro): {}",
                skip.iter().take(10).cloned().collect::<Vec<_>>().join(", ")
            ),
        ));
    }

    // ── Programas sueltos ──
    let program_list = programs(&inv, &os, &mut queries);
    let runtime_count = queries.iter().filter(|q| q.target == "runtime").count();

    // ── Herramienta de la distro ──
    let mut tool_label: Option<(DistroTool, Option<String>)> = None;
    if let (Some(tool), Some(out)) = (input.distro_tool, &input.distro_output) {
        match parse_tool(tool, out) {
            Ok(items) => {
                let n = items.len();
                tool_findings(items, &inv, &mut merger);
                system.sources.push(SourceId::Distro);
                sources_used.insert(SourceId::Distro);
                tool_label = Some((tool, None));
                if n == 0 {
                    notes.push(ScanNote::new("distro", NoteLevel::Info, format!("{}: no hay avisos de seguridad pendientes", tool.label())));
                }
            }
            Err(e) => {
                notes.push(ScanNote::new("distro", NoteLevel::Warn, format!("{}: {e}", tool.label())));
                tool_label = Some((tool, Some(e)));
            }
        }
    }

    // ── Imágenes ──
    let mut listings: HashMap<(Option<Engine>, Option<String>), inventory::ImageListing> = HashMap::new();
    for raw in &input.images {
        if let (Some(l), Some(engine)) = (&raw.listing, raw.engine) {
            let parsed = inventory::parse_images(engine, l);
            if let Some(e) = &parsed.error {
                notes.push(ScanNote::new(
                    "images",
                    NoteLevel::Warn,
                    format!("{} de {}: {e}", engine.cmd(), raw.user.as_deref().unwrap_or("tu usuario")),
                ));
            }
            listings.insert((raw.engine, raw.user.clone()), parsed);
        }
    }
    let mut trivy_version: Option<String> = None;
    for raw in input.images.iter().filter(|r| !r.image_id.is_empty()) {
        let short = inventory::short_id(&raw.image_id);
        let user_key = raw.user.clone().unwrap_or_default();
        let engine = raw.engine.unwrap_or(Engine::Podman);
        let tkey = format!("image:{}:{}:{}", engine.cmd(), user_key, short);
        let mut info = listings
            .get(&(raw.engine, raw.user.clone()))
            .and_then(|l| l.images.iter().find(|i| i.id == short))
            .cloned()
            .unwrap_or(ImageInfo { engine: Some(engine), id: short.clone(), ..Default::default() });
        let mut target = Target {
            key: tkey.clone(),
            kind: TargetKind::Image,
            label: image_label(&info, raw.user.as_deref()),
            user: raw.user.clone(),
            ecosystem: None,
            packages: 0,
            image: None,
            sources: Vec::new(),
            error: raw.error.clone(),
        };
        if let Some(out) = &raw.output {
            let read: ImageRead = inventory::parse_image(&out.stdout);
            info.os = Some(read.os.display()).filter(|s| !s.is_empty());
            info.method = read.method.clone();
            let ieco = ecosystem::for_os(&read.os);
            target.ecosystem = ieco.clone();
            if let Some((ver, items)) = &read.trivy {
                trivy_version = trivy_version.or(ver.clone());
                info.method = Some(format!("Trivy {}", ver.clone().unwrap_or_default()).trim().to_string());
                trivy_findings(items, &tkey, &mut merger);
                target.sources.push(SourceId::Trivy);
                sources_used.insert(SourceId::Trivy);
            } else {
                target.packages = read.packages.len() as u32;
                match (&ieco, read.pm) {
                    (Some(e), Some(pm)) if !read.packages.is_empty() => {
                        let none = BTreeSet::new();
                        package_queries(&PkgTarget { key: &tkey, eco: e, pm, packages: &read.packages, skip: &none }, None, &mut queries);
                    }
                    (None, _) if !read.packages.is_empty() => {
                        target.error = Some(format!("{}: sin base de datos en OSV", read.os.display()));
                    }
                    _ => {}
                }
            }
            if target.error.is_none() {
                target.error = read.error.clone().or_else(|| (!read.complete && read.trivy.is_none()).then(|| "lectura incompleta".to_string()));
            }
            if out.timed_out && target.error.is_none() {
                target.error = Some("tardó demasiado".into());
            }
        } else if target.error.is_none() {
            target.error = Some("no se leyó".into());
        }
        target.image = Some(info);
        targets.push(target);
    }
    // Imágenes de los listados que no se leyeron (límite, sin etiqueta y sin uso…).
    let read_ids: BTreeSet<String> = input.images.iter().map(|r| format!("{:?}{:?}{}", r.engine, r.user, inventory::short_id(&r.image_id))).collect();
    let mut skipped = 0;
    for ((engine, user), l) in &listings {
        for i in &l.images {
            if !read_ids.contains(&format!("{:?}{:?}{}", engine, user, i.id)) {
                skipped += 1;
            }
        }
    }
    if skipped > 0 {
        notes.push(ScanNote::new(
            "images",
            NoteLevel::Info,
            format!("{skipped} imágenes no se analizaron (límite de imágenes, o sin etiqueta y sin contenedores)"),
        ));
    }

    // ── OSV ──
    let mut osv_note: Option<String> = None;
    let mut osv_used = false;
    let mut sample: BTreeSet<OsvQueryView> = BTreeSet::new();
    if !queries.is_empty() {
        match (input.use_osv, api) {
            (false, _) | (_, None) => {
                osv_note = Some("desactivado en Ajustes".into());
            }
            (true, Some(api)) => {
                // Consultas únicas.
                let mut uniq: Vec<Query> = queries.iter().map(|q| q.query.clone()).collect();
                uniq.sort();
                uniq.dedup();
                for q in uniq.iter().take(osv::MAX_BATCH) {
                    sample.insert(OsvQueryView { ecosystem: q.ecosystem.clone(), name: q.name.clone(), version: q.version.clone() });
                }
                progress("osv", 0, uniq.len(), &format!("Consultando {} paquetes en OSV.dev", uniq.len()));
                match osv::query_all(api, &uniq, cancel).await {
                    Err(AppError::Canceled) => return Err(AppError::Canceled),
                    Err(e) => {
                        osv_note = Some(format!("no disponible: {e}"));
                        notes.push(ScanNote::new("osv", NoteLevel::Error, format!("OSV.dev no disponible: {e}")));
                    }
                    Ok(outcome) => {
                        for e in &outcome.rejected {
                            notes.push(ScanNote::new("osv", NoteLevel::Warn, format!("OSV no aceptó el ecosistema «{e}»")));
                        }
                        let ids = osv::unique_ids(&outcome.hits);
                        let total = ids.len();
                        let cb = |d: usize, t: usize| progress("osv", d, t, &format!("Detalle de avisos: {d} de {t}"));
                        match osv::fetch_details(api, cache, &ids, cancel, &cb).await {
                            Err(AppError::Canceled) => return Err(AppError::Canceled),
                            Err(e) => {
                                osv_note = Some(format!("no disponible: {e}"));
                                notes.push(ScanNote::new("osv", NoteLevel::Error, format!("OSV.dev no disponible: {e}")));
                            }
                            Ok((details, failed)) => {
                                osv_used = true;
                                if failed > 0 {
                                    notes.push(ScanNote::new(
                                        "osv",
                                        NoteLevel::Warn,
                                        format!("No se pudo leer el detalle de {failed} de {total} avisos"),
                                    ));
                                }
                                let index: HashMap<&Query, usize> = uniq.iter().enumerate().map(|(i, q)| (q, i)).collect();
                                for u in &queries {
                                    let Some(&i) = index.get(&u.query) else { continue };
                                    for h in &outcome.hits[i] {
                                        if let Some(v) = details.get(&h.id) {
                                            osv_findings(u, v, &mut merger, u.target == "system");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if osv_used {
        sources_used.insert(SourceId::Osv);
        if eco.is_some() {
            system.sources.insert(0, SourceId::Osv);
        }
        for t in targets.iter_mut().filter(|t| t.ecosystem.is_some() && t.sources.is_empty()) {
            t.sources.push(SourceId::Osv);
        }
    }

    // ── Juntar ──
    progress("merge", 0, 1, "Juntando resultados");
    let findings = merger.finish();
    let mut all_targets = vec![system];
    if !program_list.is_empty() {
        all_targets.push(Target {
            key: "runtime".into(),
            kind: TargetKind::Runtime,
            label: "Programas sueltos".into(),
            user: None,
            ecosystem: None,
            packages: runtime_count as u32,
            image: None,
            sources: if osv_used && runtime_count > 0 { vec![SourceId::Osv] } else { Vec::new() },
            error: None,
        });
    }
    all_targets.extend(targets);

    let summary = summary_of(&findings);

    let mut sources = vec![SourceInfo {
        id: SourceId::Osv,
        label: "OSV.dev".into(),
        used: osv_used,
        note: osv_note.or_else(|| (!osv_used && queries.is_empty()).then(|| "nada que consultar".into())),
    }];
    match tool_label {
        Some((tool, err)) => sources.push(SourceInfo { id: SourceId::Distro, label: tool.label().into(), used: err.is_none(), note: err }),
        None => sources.push(SourceInfo {
            id: SourceId::Distro,
            label: "Herramienta de la distro".into(),
            used: false,
            note: Some(match ecosystem::distro_tool(&detect) {
                Some(t) => format!("{} no se ejecutó", t.label()),
                None => "no hay ninguna instalada en el servidor".into(),
            }),
        }),
    }
    sources.push(SourceInfo {
        id: SourceId::Trivy,
        label: match &trivy_version {
            Some(v) => format!("Trivy {v}"),
            None => "Trivy".into(),
        },
        used: sources_used.contains(&SourceId::Trivy),
        note: (!sources_used.contains(&SourceId::Trivy)).then(|| {
            if detect.has("trivy") { "no se usó (sin imágenes que analizar)".into() } else { "no está instalado en el servidor".into() }
        }),
    });
    if !input.elevated {
        notes.push(ScanNote::new("images", NoteLevel::Info, "Sin sudo: no se ven los contenedores de otros usuarios ni los de root"));
    }
    if !sources.iter().any(|s| s.used) {
        notes.push(ScanNote::new("merge", NoteLevel::Warn, "Ninguna fuente de vulnerabilidades dio resultados: el informe está vacío"));
    }

    Ok(Report {
        id: uuid::Uuid::new_v4().to_string(),
        server_id: input.server_id.clone(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        duration_ms: input.server_ms + u64::try_from(started.elapsed().as_millis()).unwrap_or(0),
        elevated: input.elevated,
        host,
        sources,
        targets: all_targets,
        programs: program_list,
        findings,
        summary,
        notes,
        ai: None,
        osv_sample: sample.into_iter().collect(),
    })
}

/// Tras «Actualizar imagen»: el informe `base` con la imagen `old_key` sustituida por las imágenes
/// recién leídas de `partial` (un análisis que solo trae esas imágenes). Es un informe nuevo (otro id y
/// otra fecha); el resto (sistema, programas, otras imágenes) se copia tal cual.
pub fn merge_rescan(base: &Report, old_key: &str, partial: &Report) -> Report {
    let new_keys: BTreeSet<&str> = partial.targets.iter().filter(|t| t.kind == TargetKind::Image).map(|t| t.key.as_str()).collect();
    let drop = |k: &str| k == old_key || new_keys.contains(k);
    let mut targets: Vec<Target> = base.targets.iter().filter(|t| !drop(&t.key)).cloned().collect();
    targets.extend(partial.targets.iter().filter(|t| t.kind == TargetKind::Image).cloned());
    let mut findings: Vec<Finding> = base.findings.iter().filter(|f| !drop(&f.target)).cloned().collect();
    findings.extend(partial.findings.iter().filter(|f| new_keys.contains(f.target.as_str())).cloned());
    let mut notes = base.notes.clone();
    notes.extend(partial.notes.iter().filter(|n| n.phase == "images" && n.level != NoteLevel::Info).cloned());
    let label = partial.targets.iter().find(|t| t.kind == TargetKind::Image).map(|t| t.label.clone()).unwrap_or_else(|| old_key.to_string());
    notes.push(ScanNote::new("images", NoteLevel::Info, format!("{label}: vuelta a analizar tras «Actualizar imagen»")));
    let mut sources = base.sources.clone();
    for s in sources.iter_mut().filter(|s| !s.used) {
        if let Some(p) = partial.sources.iter().find(|p| p.id == s.id && p.used) {
            *s = p.clone();
        }
    }
    let mut sample: BTreeSet<OsvQueryView> = base.osv_sample.iter().cloned().collect();
    sample.extend(partial.osv_sample.iter().cloned());
    Report {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: partial.created_at.clone(),
        duration_ms: partial.duration_ms,
        summary: summary_of(&findings),
        targets,
        findings,
        notes,
        sources,
        osv_sample: sample.into_iter().collect(),
        ai: None,
        ..base.clone()
    }
}
