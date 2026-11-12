//! Pruebas reales (todas `#[ignore]`, se ejecutan aparte):
//!
//! - OSV.dev de verdad (necesita red):
//!   `cargo test --lib vulnscan::live_tests::osv -- --ignored --nocapture`
//! - Contenedores de distros viejas con podman (imágenes `debian:12.0`, `alpine:3.18.0`, `rockylinux:9.0`,
//!   `almalinux:9.0`, `ubuntu:22.04` ya descargadas) + OSV:
//!   `cargo test --lib vulnscan::live_tests::distro -- --ignored --nocapture --test-threads=2`
//! - Lectura de imágenes con `podman unshare` + `image mount` en este PC:
//!   `cargo test --lib vulnscan::live_tests::images -- --ignored --nocapture`
//! - Servidor de pruebas `terview-sshd` (127.0.0.1:2222, usuario `test`, sin sudo):
//!   `cargo test --lib vulnscan::live_tests::sshd -- --ignored --nocapture`

use std::io::Write;
use std::process::{Command, Stdio};

use tokio_util::sync::CancellationToken;

use super::analyze::analyze;
use super::cache::OsvCache;
use super::commands::{plan_from, script_for, select_images, ScriptRequest};
use super::model::*;
use super::osv::{self, HttpOsv, Query};
use super::parse::{apk, inventory};
use super::scan::{scan_session, ScanOptions};

fn quiet() -> impl Fn(&str, usize, usize, &str) + Send + Sync {
    |phase: &str, done: usize, total: usize, text: &str| {
        if done == 0 || done == total {
            eprintln!("  [{phase}] {text}");
        }
    }
}

fn raw(stdout: String) -> RawOutput {
    RawOutput { stdout, exit_code: Some(0), ..Default::default() }
}

/// Ejecuta `script` con `sh` dentro de un contenedor efímero de `image` (stdin = script).
fn in_container(image: &str, script: &str, network: bool) -> String {
    let mut args = vec!["run", "--rm", "-i"];
    if !network {
        args.push("--network=none");
    }
    args.extend([image, "sh", "-s"]);
    let mut child = Command::new("podman").args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Ejecuta `script` en este PC.
fn local(script: &str) -> String {
    let out = Command::new("sh").arg("-c").arg(script).output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn has_image(image: &str) -> bool {
    Command::new("podman").args(["image", "exists", image]).status().is_ok_and(|s| s.success())
}

/// Fases 1–2 dentro del contenedor (sin red) y, si se pide, la herramienta de la distro (con red).
async fn scan_container(image: &str, with_tool: bool) -> Report {
    assert!(has_image(image), "falta la imagen {image} (podman pull {image})");
    let detect = in_container(image, &script_for(&ScriptRequest::Detect), false);
    let plan = plan_from(&detect);
    let inventory = in_container(image, &script_for(&ScriptRequest::Inventory), false);
    let mut input = ScanInput { server_id: "prueba".into(), detect: raw(detect), inventory: raw(inventory), use_osv: true, ..Default::default() };
    if with_tool && let Some(tool) = plan.distro_tool {
        let out = in_container(image, &script_for(&ScriptRequest::Distro { tool, codename: Some(plan.codename.clone()) }), true);
        input.distro_tool = Some(tool);
        input.distro_output = Some(raw(out));
    }
    let api = HttpOsv::default();
    let p = quiet();
    let r = analyze(&input, Some(&api), &OsvCache::system(), &CancellationToken::new(), &p).await.unwrap();
    eprintln!(
        "{image}: {} paquetes, {} hallazgos (crít {} alta {} media {} baja {} sin {}; ocultos {}), fuentes {:?}",
        r.targets[0].packages,
        r.findings.len(),
        r.summary.critical,
        r.summary.high,
        r.summary.medium,
        r.summary.low,
        r.summary.unknown,
        r.summary.unimportant,
        r.sources.iter().filter(|s| s.used).map(|s| s.label.clone()).collect::<Vec<_>>()
    );
    for n in &r.notes {
        eprintln!("  aviso: {}", n.text);
    }
    r
}

fn find<'a>(r: &'a Report, id: &str, package: &str) -> &'a Finding {
    r.findings
        .iter()
        .find(|f| f.id == id && f.package == package)
        .unwrap_or_else(|| panic!("no salió {id} en {package}"))
}

// ───────────── OSV real ─────────────

#[tokio::test]
#[ignore]
async fn osv_alpine_openssl_and_invalid_ecosystem() {
    let pkgs = apk::parse_list(include_str!("fixtures/apk-list-alpine.txt"));
    let mut queries: Vec<Query> = pkgs
        .iter()
        .map(|p| Query { ecosystem: "Alpine:v3.18".into(), name: p.source.clone(), version: p.source_version.clone() })
        .collect();
    queries.sort();
    queries.dedup();
    queries.insert(0, Query { ecosystem: "Fedora:41".into(), name: "curl".into(), version: "8.9.1-2.fc41".into() });
    let api = HttpOsv::default();
    let out = osv::query_all(&api, &queries, &CancellationToken::new()).await.unwrap();
    assert!(out.rejected.contains("Fedora:41"), "Fedora:41 debe dar «ecosistema no soportado»");
    let i = queries.iter().position(|q| q.name == "openssl").unwrap();
    let ids: Vec<&str> = out.hits[i].iter().map(|h| h.id.as_str()).collect();
    assert!(ids.contains(&"ALPINE-CVE-2023-2650"), "{ids:?}");
    let total: usize = out.hits.iter().map(Vec::len).sum();
    eprintln!("Alpine 3.18.0: {total} avisos ({} peticiones)", out.requests);
    assert!(total >= 20);
}

// ───────────── Contenedores de distros viejas ─────────────

#[tokio::test]
#[ignore]
async fn distro_debian_12_0() {
    let r = scan_container("docker.io/library/debian:12.0", false).await;
    assert_eq!(r.host.ecosystem.as_deref(), Some("Debian:12"));
    let t = find(&r, "CVE-2024-12133", "libtasn1-6");
    assert!(t.advisories.contains(&"DSA-5863-1".to_string()), "{t:#?}");
    assert_eq!(t.fixed.as_deref(), Some("4.19.0-2+deb12u1"));
    let z = find(&r, "CVE-2023-45853", "zlib");
    assert!(!z.has_fix, "zlib sin arreglo en bookworm");
    assert!(r.findings.len() > 150);
}

#[tokio::test]
#[ignore]
async fn distro_alpine_3_18_0() {
    let r = scan_container("docker.io/library/alpine:3.18.0", false).await;
    assert_eq!(r.host.ecosystem.as_deref(), Some("Alpine:v3.18"));
    let o = find(&r, "CVE-2023-2650", "openssl");
    assert!(o.aliases.contains(&"ALPINE-CVE-2023-2650".to_string()), "{o:#?}");
    assert!(o.has_fix);
    assert!(r.findings.iter().any(|f| f.package == "busybox"));
}

#[tokio::test]
#[ignore]
async fn distro_rocky_9_0() {
    let r = scan_container("docker.io/library/rockylinux:9.0", false).await;
    assert_eq!(r.host.ecosystem.as_deref(), Some("Rocky Linux:9"));
    let c = find(&r, "CVE-2022-32206", "curl");
    assert!(c.advisories.contains(&"RLSA-2022:6157".to_string()), "{c:#?}");
    assert_eq!(c.fixed.as_deref(), Some("7.76.1-14.el9_0.5"));
    assert_eq!(c.distro_severity.as_deref(), Some("Moderate"));
    assert!(c.binaries.contains(&"libcurl".to_string()));
}

#[tokio::test]
#[ignore]
async fn distro_alma_9_0_and_ubuntu_22_04() {
    let a = scan_container("docker.io/library/almalinux:9.0", false).await;
    assert!(a.findings.iter().any(|f| f.advisories.iter().any(|x| x == "ALSA-2023:0333")), "ALSA-2023:0333 (curl)");
    let u = scan_container("docker.io/library/ubuntu:22.04", false).await;
    assert_eq!(u.host.ecosystem.as_deref(), Some("Ubuntu:22.04:LTS"));
    assert!(u.findings.iter().any(|f| f.package == "ncurses"), "UBUNTU-CVE-2023-50495 (ncurses)");
}

/// Rocky 9.0 con `dnf updateinfo` (baja los metadatos del repo: necesita red y tarda).
#[tokio::test]
#[ignore]
async fn distro_rocky_9_0_with_dnf() {
    let r = scan_container("docker.io/library/rockylinux:9.0", true).await;
    let dnf = r.sources.iter().find(|s| s.id == SourceId::Distro).unwrap();
    assert!(dnf.used, "{dnf:?}");
    let c = find(&r, "CVE-2022-32206", "curl");
    assert_eq!(c.sources, [SourceId::Osv, SourceId::Distro], "OSV y dnf juntos en una fila");
    assert!(r.findings.iter().any(|f| f.sources.contains(&SourceId::Distro) && f.severity == Severity::Critical));
}

// ───────────── Imágenes de podman en este PC ─────────────

#[tokio::test]
#[ignore]
async fn images_podman_mount_in_this_pc() {
    let listing = local(&script_for(&ScriptRequest::Images { engine: Engine::Podman, user: None }));
    let view = select_images(Engine::Podman, &listing, 500);
    let mut input = ScanInput { server_id: "pc".into(), use_osv: true, elevated: false, ..Default::default() };
    input.detect = raw(local(&script_for(&ScriptRequest::Detect)));
    input.images.push(ImageRaw { engine: Some(Engine::Podman), listing: Some(listing.clone()), ..Default::default() });
    let wanted = ["docker.io/library/alpine:3.18.0", "docker.io/library/debian:12.0", "docker.io/library/rockylinux:9.0"];
    for tag in wanted {
        let img = view.selected.iter().find(|i| i.tags.iter().any(|t| t == tag)).unwrap_or_else(|| panic!("falta {tag}"));
        let out = local(&script_for(&ScriptRequest::Image { engine: Engine::Podman, user: None, image_id: img.id.clone(), trivy: false }));
        let read = inventory::parse_image(&out);
        eprintln!("{tag}: {:?}, {} paquetes, método {:?}, error {:?}", read.pm, read.packages.len(), read.method, read.error);
        assert!(read.packages.len() > 10, "{tag}: {out}");
        input.images.push(ImageRaw { engine: Some(Engine::Podman), image_id: img.id.clone(), output: Some(raw(out)), ..Default::default() });
    }
    // Nada quedó montado.
    let mounted = Command::new("podman").args(["unshare", "podman", "image", "mount"]).output().unwrap();
    assert!(String::from_utf8_lossy(&mounted.stdout).trim().is_empty(), "quedaron imágenes montadas");

    let api = HttpOsv::default();
    let p = quiet();
    let r = analyze(&input, Some(&api), &OsvCache::system(), &CancellationToken::new(), &p).await.unwrap();
    let key = |tag: &str| r.targets.iter().find(|t| t.image.as_ref().is_some_and(|i| i.tags.iter().any(|x| x == tag))).unwrap().key.clone();
    let alp = key("docker.io/library/alpine:3.18.0");
    assert!(r.findings.iter().any(|f| f.target == alp && f.id == "CVE-2023-2650" && f.package == "openssl"));
    let deb = key("docker.io/library/debian:12.0");
    assert!(r.findings.iter().any(|f| f.target == deb && f.id == "CVE-2024-12133" && f.advisories.contains(&"DSA-5863-1".into())));
    let rocky = key("docker.io/library/rockylinux:9.0");
    assert!(r.findings.iter().any(|f| f.target == rocky && f.advisories.contains(&"RLSA-2022:6157".into())));
    eprintln!("imágenes: {} hallazgos en total", r.findings.len());
}

// ───────────── Servidor de pruebas por SSH (sin sudo) ─────────────

#[tokio::test]
#[ignore]
async fn sshd_scan_without_sudo() {
    let s = crate::ssh::connect::testutil::connect_test_server().await;
    let mut opts = ScanOptions::new("test-profile");
    opts.save = false;
    let p = quiet();
    let r = scan_session(&s, &opts, &CancellationToken::new(), &p).await.unwrap();
    assert_eq!(r.host.os.id, "alpine");
    assert!(r.host.ecosystem.as_deref().is_some_and(|e| e.starts_with("Alpine:v")));
    assert!(r.targets[0].packages >= 40, "inventario sin sudo: {}", r.targets[0].packages);
    assert!(r.sources.iter().any(|s| s.id == SourceId::Osv && s.used), "{:?}", r.sources);
    assert!(r.programs.iter().any(|p| p.name == "sudo" && p.owner.as_deref() == Some("sudo")));
    assert!(!r.elevated);
    eprintln!(
        "terview-sshd: {} paquetes, {} hallazgos, {} consultas a OSV, avisos: {:?}",
        r.targets[0].packages,
        r.findings.len(),
        r.osv_sample.len(),
        r.notes.iter().map(|n| n.text.clone()).collect::<Vec<_>>()
    );
}

#[tokio::test]
#[ignore]
async fn sshd_scan_can_be_canceled() {
    let s = crate::ssh::connect::testutil::connect_test_server().await;
    let mut opts = ScanOptions::new("test-profile");
    opts.save = false;
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        c2.cancel();
    });
    let p = quiet();
    let r = scan_session(&s, &opts, &cancel, &p).await;
    assert!(matches!(r, Err(crate::error::AppError::Canceled)), "{:?}", r.map(|r| r.findings.len()));
}
