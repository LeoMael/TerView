//! Pruebas del escáner con salidas REALES capturadas el 12/11/2026 (carpeta `fixtures/`, ver
//! PENDIENTES 10.13) y una OSV falsa en memoria. Las que hablan con OSV de verdad, con contenedores o
//! con el servidor de pruebas están en `live_tests.rs` (`#[ignore]`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::analyze::analyze;
use super::cache::OsvCache;
use super::commands::{plan_from, select_images};
use super::ecosystem;
use super::export;
use super::model::*;
use super::osv::{self, BatchItem, Hit, OsvApi, OsvError, OsvVuln, Query};
use super::parse::{self, apk, debsecan, dnf, dpkg, inventory, osrelease, rpm, trivy, ubuntu_pro, zypper};
use super::scripts;
use super::severity;
use super::store::History;

macro_rules! fx {
    ($name:literal) => {
        include_str!(concat!("fixtures/", $name))
    };
}

struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("sshorus-vulnscan-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn no_progress() -> impl Fn(&str, usize, usize, &str) + Send + Sync {
    |_: &str, _: usize, _: usize, _: &str| {}
}

// ───────────── Secciones y utilidades ─────────────

#[test]
fn sections_split_by_marker() {
    let s = parse::sections("basura\n@@os\nID=x\n@@rc 3\n@@error no se pudo\n@@end\n");
    assert_eq!(s.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["os", "rc", "error", "end"]);
    assert_eq!(parse::section(&s, "os").unwrap(), ["ID=x"]);
    assert_eq!(parse::section(&s, "rc").unwrap(), ["3"]);
    assert_eq!(parse::section(&s, "error").unwrap(), ["no se pudo"]);
}

#[test]
fn cve_helpers() {
    assert!(parse::is_cve("CVE-2024-12133"));
    assert!(parse::is_cve("CVE-2026-114406"));
    assert!(!parse::is_cve("CVE-24-1"));
    assert!(!parse::is_cve("DSA-5863-1"));
    assert_eq!(
        parse::find_cves("Fix (CVE-2026-8932), CVE-2026-13608 y CVE-2026-8932 otra vez; CVE-"),
        ["CVE-2026-8932", "CVE-2026-13608"]
    );
    assert_eq!(parse::short("  hola   mundo\n", 50), "hola mundo");
    assert_eq!(parse::short("abcdefghij", 5), "abcd…");
}

// ───────────── os-release → ecosistema ─────────────

fn os(text: &str) -> OsRelease {
    osrelease::parse(text)
}

#[test]
fn os_release_to_ecosystem() {
    assert_eq!(ecosystem::for_os(&os(fx!("os-release-debian.txt"))).as_deref(), Some("Debian:12"));
    assert_eq!(ecosystem::for_os(&os(fx!("os-release-ubuntu.txt"))).as_deref(), Some("Ubuntu:22.04:LTS"));
    assert_eq!(ecosystem::for_os(&os(fx!("os-release-alpine.txt"))).as_deref(), Some("Alpine:v3.18"));
    assert_eq!(ecosystem::for_os(&os(fx!("os-release-rockylinux.txt"))).as_deref(), Some("Rocky Linux:9"));
    assert_eq!(ecosystem::for_os(&os(fx!("os-release-almalinux.txt"))).as_deref(), Some("AlmaLinux:9"));
    assert_eq!(ecosystem::for_os(&os(fx!("os-release-fedora.txt"))), None, "Fedora no está en OSV");
    // Ubuntu sin LTS, Leap y Tumbleweed (os-release de ejemplo).
    let u = os("ID=ubuntu\nVERSION_ID=\"23.10\"\nVERSION=\"23.10 (Mantic Minotaur)\"\n");
    assert_eq!(ecosystem::for_os(&u).as_deref(), Some("Ubuntu:23.10"));
    let leap = os("NAME=\"openSUSE Leap\"\nVERSION=\"15.6\"\nID=\"opensuse-leap\"\nID_LIKE=\"suse opensuse\"\nVERSION_ID=\"15.6\"\nPRETTY_NAME=\"openSUSE Leap 15.6\"\n");
    assert_eq!(ecosystem::for_os(&leap).as_deref(), Some("openSUSE:Leap 15.6"));
    assert_eq!(ecosystem::for_os(&os("ID=opensuse-tumbleweed\nVERSION_ID=\"20261101\"\n")).as_deref(), Some("openSUSE:Tumbleweed"));
    assert_eq!(ecosystem::for_os(&os("ID=arch\n")), None);
    // Ubuntu Pro (ESM) solo en LTS con Pro activado.
    let ubu = os(fx!("os-release-ubuntu.txt"));
    assert_eq!(ecosystem::ubuntu_pro(&ubu, true).as_deref(), Some("Ubuntu:Pro:22.04:LTS"));
    assert_eq!(ecosystem::ubuntu_pro(&ubu, false), None);
    assert_eq!(ecosystem::ubuntu_pro(&u, true), None);
    // Nombres para mostrar.
    assert_eq!(os(fx!("os-release-ubuntu.txt")).version_codename, "jammy");
    assert!(os(fx!("os-release-rockylinux.txt")).is_like("rhel"));
}

// ───────────── Paquetes ─────────────

#[test]
fn rpm_qa_rocky_source_and_no_epoch() {
    let pkgs = rpm::parse_qa(fx!("rpm-rockylinux.txt"));
    assert_eq!(pkgs.len(), 157);
    let ossl = &pkgs.iter().find(|(p, _)| p.name == "openssl-libs").unwrap().0;
    assert_eq!(ossl.source, "openssl");
    assert_eq!(ossl.version, "1:3.0.1-23.el9_0", "se muestra con epoch");
    assert_eq!(ossl.source_version, "3.0.1-23.el9_0", "a OSV va sin epoch");
    let lib = &pkgs.iter().find(|(p, _)| p.name == "libcurl").unwrap().0;
    assert_eq!(lib.source, "curl");
    assert_eq!(rpm::source_name("libssh-0.9.6-3.el9.src.rpm").as_deref(), Some("libssh"));
    assert_eq!(rpm::source_name("(none)"), None);
    assert_eq!(rpm::split_nevra("openssl-libs-1:3.5.9-1.fc44.x86_64"), Some(("openssl-libs".into(), "1:3.5.9-1.fc44".into())));
    assert_eq!(
        rpm::split_nevra("ca-certificates-2026.2.92_v9.0.319-90.3.el9_8.noarch"),
        Some(("ca-certificates".into(), "2026.2.92_v9.0.319-90.3.el9_8".into()))
    );
    assert_eq!(rpm::strip_epoch("0:7.76.1-14.el9_0.5"), "7.76.1-14.el9_0.5");
    // Con vendedor (7.ª columna).
    let v = rpm::parse_qa("docker-ce\t3\t27.0.0\t1.el9\tx86_64\tdocker-ce-27.0.0-1.el9.src.rpm\tDocker\n");
    assert_eq!(v[0].1.as_deref(), Some("Docker"));
    assert_eq!(v[0].0.version, "3:27.0.0-1.el9");
}

#[test]
fn rpm_qa_alma_and_fedora() {
    let alma = rpm::parse_qa(fx!("rpm-almalinux.txt"));
    assert!(alma.iter().any(|(p, _)| p.name == "curl-minimal" && p.source == "curl"));
    let fed = rpm::parse_qa(fx!("rpm-fedora.txt"));
    assert!(!fed.is_empty());
    assert!(fed.iter().all(|(p, _)| !p.source.is_empty() && !p.source_version.contains(':')));
}

#[test]
fn dpkg_query_debian_and_ubuntu() {
    let deb = dpkg::parse_query(fx!("dpkg-debian.txt"));
    assert_eq!(deb.len(), 88);
    let bsd = deb.iter().find(|p| p.name == "bsdutils").unwrap();
    assert_eq!((bsd.source.as_str(), bsd.source_version.as_str()), ("util-linux", "2.38.1-5"));
    assert_eq!(bsd.version, "1:2.38.1-5+b1");
    let z = deb.iter().find(|p| p.name == "zlib1g").unwrap();
    assert_eq!((z.source.as_str(), z.source_version.as_str()), ("zlib", "1:1.2.13.dfsg-1"));
    let ubu = dpkg::parse_query(fx!("dpkg-ubuntu.txt"));
    assert!(ubu.iter().any(|p| p.name == "libncursesw6" && p.source == "ncurses"));
    // Solo instalados («ii»), no «rc» (quitados con su configuración).
    assert!(dpkg::parse_query("rc \tviejo\t1.0\tviejo\t1.0\n").is_empty());
}

#[test]
fn dpkg_status_file() {
    let text = "Package: bsdutils\nStatus: install ok installed\nVersion: 1:2.38.1-5+b1\nSource: util-linux (2.38.1-5)\nArchitecture: amd64\n\n\
                Package: borrado\nStatus: deinstall ok config-files\nVersion: 1\n\n\
                Package: base-files\nVersion: 12.4\nArchitecture: amd64\nPackage: zlib1g\nVersion: 1:1.2.13.dfsg-1\nSource: zlib\n";
    let p = dpkg::parse_status(text);
    assert_eq!(p.len(), 3, "sin el borrado; status.d sin línea en blanco entre estrofas");
    assert_eq!((p[0].source.as_str(), p[0].source_version.as_str()), ("util-linux", "2.38.1-5"));
    assert_eq!(p[1].name, "base-files");
    assert_eq!((p[2].source.as_str(), p[2].source_version.as_str()), ("zlib", "1:1.2.13.dfsg-1"));
}

#[test]
fn apk_list_and_installed_db() {
    let l = apk::parse_list(fx!("apk-list-alpine.txt"));
    assert_eq!(l.len(), 15);
    let c = l.iter().find(|p| p.name == "libcrypto3").unwrap();
    assert_eq!((c.source.as_str(), c.version.as_str()), ("openssl", "3.1.0-r4"));
    let origins: std::collections::BTreeSet<_> = l.iter().map(|p| p.source.clone()).collect();
    assert_eq!(origins.len(), 10, "10 orígenes, como en 10.13");
    let db = apk::parse_installed(fx!("apk-installed-alpine.txt"));
    assert_eq!(db.len(), 15);
    assert!(db.iter().any(|p| p.name == "libssl3" && p.source == "openssl" && p.version == "3.1.0-r4"));
    let sshd = apk::parse_list(fx!("apk-list-terview-sshd.txt"));
    assert_eq!(sshd.iter().map(|p| p.source.clone()).collect::<std::collections::BTreeSet<_>>().len(), 46);
    assert_eq!(apk::split_name_version("sudo-1.9.17_p2-r2"), Some(("sudo".into(), "1.9.17_p2-r2".into())));
    assert_eq!(apk::split_name_version("py3-a-1-0.2-r0"), Some(("py3-a-1".into(), "0.2-r0".into())));
}

// ───────────── Herramientas de la distro ─────────────

#[test]
fn dnf4_rocky_list_and_info() {
    let info = dnf::parse_info4(fx!("dnf4-updateinfo-info-rocky.txt"));
    let curl = info.iter().find(|a| a.id == "RLSA-2022:6157").unwrap();
    assert_eq!(curl.cves, ["CVE-2022-32206", "CVE-2022-32207", "CVE-2022-32208"]);
    assert_eq!(curl.severity.as_deref(), Some("Moderate"));
    assert_eq!(curl.title.as_deref(), Some("Moderate: curl security update"));
    let acl = info.iter().find(|a| a.id == "RLSA-2026:42736").unwrap();
    assert_eq!(acl.cve_text.get("CVE-2026-54369").map(String::as_str), Some("acl: Symlink traversal privilege escalation via libacl functions"));

    let f = dnf::findings4(fx!("dnf4-updateinfo-list-rocky.txt"), fx!("dnf4-updateinfo-info-rocky.txt"));
    let c = f.iter().find(|x| x.advisory.as_deref() == Some("RLSA-2022:6157") && x.cves == ["CVE-2022-32206"]).unwrap();
    assert_eq!(c.package, "curl");
    assert_eq!(c.fixed.as_deref(), Some("7.76.1-14.el9_0.5"));
    assert!(c.has_fix);
    let ca = f.iter().find(|x| x.cves == ["CVE-2026-114406"]).unwrap();
    assert_eq!(ca.severity.as_deref(), Some("Critical"));
    assert_eq!(ca.package, "ca-certificates");
    // dbus lleva epoch en el NEVRA.
    assert!(f.iter().any(|x| x.package == "dbus" && x.fixed.as_deref() == Some("1:1.12.20-7.el9_1")));
    assert!(dnf::parse_list4(fx!("dnf4-updateinfo-list-rocky.txt")).len() > 250);
}

#[test]
fn dnf5_fedora_json() {
    let f = dnf::findings5(fx!("dnf5-advisory-list-fedora44.json"), fx!("dnf5-advisory-info-fedora44.json"));
    // curl: 3 CVE sacados de las referencias de Bugzilla, para curl y libcurl.
    let curl: Vec<_> = f.iter().filter(|x| x.advisory.as_deref() == Some("FEDORA-2026-a06b828d65")).collect();
    assert_eq!(curl.len(), 6);
    let c = curl.iter().find(|x| x.package == "curl" && x.cves == ["CVE-2026-8932"]).unwrap();
    assert_eq!(c.severity.as_deref(), Some("Moderate"));
    assert_eq!(c.summary.as_deref(), Some("curl: libcurl: Security feature bypass due to improper mTLS connection reuse"));
    assert_eq!(c.fixed.as_deref(), Some("8.18.0-14.fc44"));
    // openssl: sin CVE → fila con el aviso.
    let o = f.iter().find(|x| x.advisory.as_deref() == Some("FEDORA-2026-12f3f3d569")).unwrap();
    assert!(o.cves.is_empty());
    assert_eq!(o.package, "openssl-libs");
    assert_eq!(o.severity.as_deref(), Some("Important"));
    // sudo: el CVE sale de la descripción.
    assert!(f.iter().any(|x| x.package == "sudo" && x.cves == ["CVE-2026-96512"]));
    assert!(dnf::findings5("[]", "[]").is_empty());
    assert!(dnf::findings5("no es json", "").is_empty());
}

#[test]
fn debsecan_detail_debian12() {
    let f = debsecan::parse_detail(fx!("debsecan-detail-debian12.txt"));
    assert_eq!(f.len(), 435, "un bloque por CVE y binario");
    let unique: std::collections::BTreeSet<_> = f.iter().map(|x| x.cves[0].clone()).collect();
    assert!(unique.len() >= 200);
    let wall = f.iter().find(|x| x.cves == ["CVE-2024-28085"] && x.package == "bsdutils").unwrap();
    assert_eq!(wall.source.as_deref(), Some("util-linux"));
    assert_eq!(wall.installed.as_deref(), Some("1:2.38.1-5+b1"));
    assert!(wall.has_fix);
    assert!(wall.summary.as_deref().unwrap().starts_with("wall in util-linux"));
    assert!(f.iter().any(|x| x.severity.as_deref() == Some("low")), "«(low urgency)»");
    let sin = f.iter().find(|x| x.cves == ["CVE-2026-13595"]).unwrap();
    assert!(!sin.has_fix);
}

#[test]
fn ubuntu_pro_api() {
    let f = ubuntu_pro::parse(fx!("pro-api-cves-ubuntu22.json")).unwrap();
    assert_eq!(f.len(), 247);
    let c = f.iter().find(|x| x.package == "coreutils" && x.cves == ["CVE-2016-2781"]).unwrap();
    assert_eq!(c.severity.as_deref(), Some("low"));
    assert_eq!(c.cvss, Some(6.5));
    assert!(!c.has_fix);
    assert_eq!(c.status.as_deref(), Some("vulnerable"));
    let fail = r#"{"_schema_version":"v1","data":{"meta":{}},"errors":[{"code":"api-invalid-endpoint"}],"result":"failure"}"#;
    assert!(ubuntu_pro::parse(fail).is_err());
    assert!(ubuntu_pro::parse("basura").is_err());
}

#[test]
fn zypper_xml() {
    assert!(zypper::parse(fx!("zypper-leap156-vacio.xml")).is_empty());
    // Formato de zypper con parches pendientes (ejemplo hecho a mano: no se pudo capturar uno real).
    let xml = r#"<?xml version='1.0'?><stream><update-status version="0.6"><update-list>
<update kind="patch" name="openSUSE-SLE-15.6-2024-1234" edition="1" arch="noarch" status="needed" category="security" severity="important" pkgmanager="false" restart="false" interactive="false">
<summary>Security update for curl</summary><description>Fixes &lt;bugs&gt;</description>
<issue-list><issue type="bugzilla" id="1234"/><issue type="cve" id="CVE-2024-6197"/><issue type="cve" id="CVE-2024-6874"/></issue-list>
</update>
<update kind="patch" name="openSUSE-2024-9" status="needed" category="recommended" severity="low"><summary>Bugfix</summary></update>
</update-list></update-status></stream>"#;
    let f = zypper::parse(xml);
    assert_eq!(f.len(), 2);
    assert_eq!(f[0].package, "curl");
    assert_eq!(f[0].cves, ["CVE-2024-6197"]);
    assert_eq!(f[1].cves, ["CVE-2024-6874"]);
    assert_eq!(f[0].severity.as_deref(), Some("important"));
    assert_eq!(f[0].advisory.as_deref(), Some("openSUSE-SLE-15.6-2024-1234"));
}

#[test]
fn trivy_template_rocky() {
    let f = trivy::parse(fx!("trivy-rootfs-rocky90.tsv"));
    assert_eq!(f.len(), 592, "592 hallazgos, como en 10.13");
    let acl = &f[0];
    assert_eq!((acl.class.as_str(), acl.id.as_str(), acl.package.as_str()), ("os-pkgs", "CVE-2026-54369", "acl"));
    assert_eq!(acl.fixed.as_deref(), Some("2.4.0-1.el9_8"));
    assert_eq!(acl.severity, "HIGH");
    assert_eq!(acl.status.as_deref(), Some("fixed"));
    assert_eq!(acl.path, None);
    assert!(f.iter().any(|x| x.severity == "CRITICAL"));
    assert_eq!(trivy::version("Version: 0.76.2").as_deref(), Some("0.76.2"));
    // La plantilla es la que produjo ese archivo.
    assert!(scripts::TRIVY_TEMPLATE.contains("{{ $c }}\t{{ .VulnerabilityID }}\t{{ .PkgName }}"));
}

// ───────────── Scripts propios ─────────────

#[test]
fn inventory_prototype_sshorus_sshd() {
    // Salida del prototipo del script de inventario contra el servidor de pruebas (4 columnas en @@tools).
    let inv = inventory::parse_inventory(fx!("inventario-terview-sshd.txt"));
    assert!(inv.complete);
    assert_eq!(inv.pm, Some(PackageManager::Apk));
    assert_eq!(inv.packages.iter().map(|p| p.source.clone()).collect::<std::collections::BTreeSet<_>>().len(), 46);
    let sudo = inv.programs.iter().find(|p| p.name == "sudo").unwrap();
    assert_eq!(sudo.owner.as_deref(), Some("sudo"));
    assert_eq!(sudo.version_line, "Sudo version 1.9.17p2");
    let d = inventory::parse_detect(fx!("inventario-terview-sshd.txt"));
    assert_eq!(d.os.id, "alpine");
    assert_eq!(d.kernel, "7.2.15-300.fc45.x86_64");
    assert_eq!(ecosystem::for_os(&d.os).as_deref(), Some("Alpine:v3.24"));
}

#[test]
fn detect_and_plan() {
    let out = "@@os\nID=rocky\nID_LIKE=\"rhel centos fedora\"\nVERSION_ID=\"9.0\"\nPRETTY_NAME=\"Rocky Linux 9.0\"\n\
               @@kernel\nLinux 5.14.0 x86_64\n@@id\nana\n1000\n@@container\nno\n@@pm\nrpm\n\
               @@tools\ndnf\t/usr/bin/dnf\npodman\t/usr/bin/podman\ntrivy\t/usr/bin/trivy\n\
               @@dnf\n4.14.0\n@@trivy\nVersion: 0.76.2\n@@pro\n@@docker\nno\n@@end\n";
    let p = plan_from(out);
    assert_eq!(p.distro_tool, Some(DistroTool::Dnf4));
    assert_eq!(p.ecosystem.as_deref(), Some("Rocky Linux:9"));
    assert_eq!(p.trivy.as_deref(), Some("0.76.2"));
    assert!(p.podman && !p.docker && !p.is_root && p.complete);
    let fed = out.replace("ID=rocky", "ID=fedora").replace("4.14.0", "dnf5 version 5.2.17.0");
    assert_eq!(plan_from(&fed).distro_tool, Some(DistroTool::Dnf5));
    let deb = "@@os\nID=debian\nVERSION_ID=\"12\"\nVERSION_CODENAME=bookworm\n@@tools\ndebsecan\t/usr/bin/debsecan\n@@end\n";
    let p = plan_from(deb);
    assert_eq!((p.distro_tool, p.codename.as_str()), (Some(DistroTool::Debsecan), "bookworm"));
    let ubu = "@@os\nID=ubuntu\nVERSION_ID=\"22.04\"\n@@tools\npro\t/usr/bin/pro\n@@id\nroot\n0\n@@end\n";
    let p = plan_from(ubu);
    assert_eq!(p.distro_tool, Some(DistroTool::Pro));
    assert!(p.is_root);
    assert_eq!(plan_from("@@os\nID=arch\n@@end\n").distro_tool, None);
}

#[test]
fn users_and_images_listing() {
    let u = inventory::parse_users("@@users\nana\t1000\t/home/ana\tyes\tno\tno\nbeto\t1001\t/home/beto\tno\tyes\tyes\n@@root\npodman\n@@end\n");
    assert_eq!(u.users.len(), 2);
    assert!(u.users[0].podman && !u.users[0].runtime_dir);
    assert!(u.users[1].docker && u.users[1].runtime_dir);
    assert!(u.root_podman && !u.root_docker);

    let podman = "@@images\n5e2b554c1c45\tdocker.io/library/alpine:3.18.0\n5e2b554c1c45\tlocalhost/mio:1\n\
                  3676c78a12ad\tdocker.io/library/debian:12.0\n0f224cd42fb8\t<none>:<none>\naaaaaaaaaaaa\t<none>:<none>\n\
                  @@containers\nc1c1c1c1c1c1\tweb\t3676c78a12ad3676c78a12ad3676c78a12ad3676c78a12ad3676c78a12ad1234\trunning\n\
                  c2c2c2c2c2c2\tvieja\t0f224cd42fb8aaaa\texited\n@@end\n";
    let l = inventory::parse_images(Engine::Podman, podman);
    assert_eq!(l.images.len(), 4);
    assert_eq!(l.images[0].tags, ["docker.io/library/alpine:3.18.0", "localhost/mio:1"]);
    let deb = l.images.iter().find(|i| i.id == "3676c78a12ad").unwrap();
    assert_eq!(deb.containers[0].name, "web");
    // Orden: con contenedores primero; sin etiqueta y sin uso, fuera.
    let v = select_images(Engine::Podman, podman, 50);
    assert_eq!(v.total, 4);
    assert_eq!(v.selected.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["3676c78a12ad", "0f224cd42fb8", "5e2b554c1c45"]);
    assert_eq!(select_images(Engine::Podman, podman, 1).selected.len(), 1);

    let docker = "@@images\nsha256:7cac34a4d72b0000000000000000000000000000000000000000000000000000\tnginx:alpine\n\
                  @@containers\n0123456789abcdef\t/proxy\tsha256:7cac34a4d72b0000000000000000000000000000000000000000000000000000\texited\n@@end\n";
    let d = inventory::parse_images(Engine::Docker, docker);
    assert_eq!(d.images[0].id, "7cac34a4d72b");
    assert_eq!(d.images[0].containers[0].name, "proxy");
    let e = inventory::parse_images(Engine::Podman, "@@images\nError: cannot connect\n@@containers\n@@end\n");
    assert!(e.error.unwrap().contains("cannot connect"));
}

#[test]
fn image_read_variants() {
    let deb = format!(
        "@@method montada\n@@os\n{}\n@@dpkgstatus\nPackage: libtasn1-6\nStatus: install ok installed\nVersion: 4.19.0-2\n\n@@end\n",
        fx!("os-release-debian.txt")
    );
    let r = inventory::parse_image(&deb);
    assert_eq!(r.method.as_deref(), Some("montada"));
    assert_eq!(r.pm, Some(PackageManager::Dpkg));
    assert_eq!(r.packages.len(), 1);
    assert_eq!(ecosystem::for_os(&r.os).as_deref(), Some("Debian:12"));
    // Anfitrión sin rpm: la primera parte pide rpm y la segunda lo trae de la imagen.
    let alma = format!(
        "@@method montada\n@@os\n{}\n@@needrpm\n@@end\n@@method rpm de la imagen\n@@rpm\n{}@@end\n",
        fx!("os-release-almalinux.txt"),
        fx!("rpm-almalinux.txt")
    );
    let r = inventory::parse_image(&alma);
    assert_eq!(r.pm, Some(PackageManager::Rpm));
    assert_eq!(r.method.as_deref(), Some("rpm de la imagen"));
    assert!(r.packages.len() > 100);
    assert!(r.error.is_none());
    let t = format!("@@os\nID=rocky\nVERSION_ID=9.0\n@@trivyver\nVersion: 0.76.2\n@@trivy\n{}@@rc 0\n@@end\n", fx!("trivy-rootfs-rocky90.tsv"));
    let r = inventory::parse_image(&t);
    let (ver, items) = r.trivy.unwrap();
    assert_eq!(ver.as_deref(), Some("0.76.2"));
    assert_eq!(items.len(), 592);
    let r = inventory::parse_image("@@error no se pudo montar la imagen: x\n@@end\n");
    assert!(r.error.unwrap().contains("montar"));
    let r = inventory::parse_image("@@os\nID=x\n@@nopkgdb\n@@end\n");
    assert!(r.error.is_some());
}

/// Los scripts tienen que ser sh válido (dash/busybox): se comprueba la sintaxis con `sh -n`.
#[cfg(unix)]
#[test]
fn scripts_are_valid_sh() {
    use std::io::Write;
    let user = scripts::UserCtx { name: "ana".into(), uid: 1000, home: "/home/ana".into() };
    let all = [
        scripts::detect_script(),
        scripts::users_script(),
        scripts::inventory_script(),
        scripts::distro_script(DistroTool::Dnf4, ""),
        scripts::distro_script(DistroTool::Dnf5, ""),
        scripts::distro_script(DistroTool::Yum, ""),
        scripts::distro_script(DistroTool::Debsecan, "bookworm"),
        scripts::distro_script(DistroTool::Pro, ""),
        scripts::distro_script(DistroTool::Zypper, ""),
        scripts::images_list_script(Engine::Podman, None),
        scripts::images_list_script(Engine::Podman, Some(&user)),
        scripts::images_list_script(Engine::Docker, None),
        scripts::images_list_script(Engine::Docker, Some(&user)),
        scripts::image_script(Engine::Podman, None, "5e2b554c1c45", true),
        scripts::image_script(Engine::Podman, Some(&user), "5e2b554c1c45", false),
        scripts::image_script(Engine::Docker, None, "sha256:5e2b554c1c45", true),
        scripts::image_script(Engine::Docker, Some(&user), "5e2b554c1c45", false),
        scripts::as_owner_script(Engine::Podman, None, "podman pull docker.io/library/nginx:1.27"),
        scripts::as_owner_script(Engine::Podman, Some(&user), "podman pull 'a b'\nsystemctl --user restart web.service"),
        scripts::as_owner_script(Engine::Docker, Some(&user), "cd /srv/app && docker compose pull"),
    ];
    for s in all {
        let mut child = std::process::Command::new("sh")
            .arg("-n")
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "sh -n falló: {}\n---\n{s}", String::from_utf8_lossy(&out.stderr));
    }
    // Nada de nombres raros en los argumentos.
    assert!(!scripts::image_script(Engine::Podman, None, "abc;rm -rf /", false).contains("rm -rf"));
    let bad = scripts::UserCtx { name: "a;b".into(), uid: 1, home: "/x".into() };
    assert!(!scripts::images_list_script(Engine::Podman, Some(&bad)).contains("a;b"));
    assert!(scripts::distro_script(DistroTool::Debsecan, "x; rm").contains("debsecan --format"));
    // «Actualizar imagen» con un usuario raro: no se ejecuta nada (ni como root).
    let s = scripts::as_owner_script(Engine::Podman, Some(&bad), "podman pull x");
    assert!(!s.contains("podman pull") && s.contains("exit 1"), "{s}");
    let s = scripts::as_owner_script(Engine::Podman, Some(&user), "podman pull x");
    assert!(s.contains("runuser -u 'ana'") && s.contains("XDG_RUNTIME_DIR=/run/user/1000"), "{s}");
    assert!(scripts::as_owner_script(Engine::Docker, Some(&user), "docker pull x").contains("DOCKER_HOST=unix://$s"));
}

/// «Actualizar imagen» sin el sh del contenedor: el script sale con el código de lo de dentro.
#[cfg(unix)]
#[test]
fn as_owner_script_keeps_exit_code() {
    let run = |inner: &str| {
        std::process::Command::new("sh").arg("-c").arg(scripts::as_owner_script(Engine::Podman, None, inner)).output().unwrap()
    };
    assert!(run("true").status.success());
    assert_eq!(run("echo hola; exit 3").status.code(), Some(3));
    assert_eq!(String::from_utf8_lossy(&run("echo hola").stdout), "hola\n");
}

/// Fases 1 y 2 de verdad en este PC (Linux): el inventario sale con paquetes.
#[cfg(target_os = "linux")]
#[test]
fn detect_and_inventory_run_locally() {
    let run = |s: String| {
        let out = std::process::Command::new("sh").arg("-c").arg(&s).output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let d = inventory::parse_detect(&run(scripts::detect_script()));
    assert!(d.complete);
    assert!(!d.os.id.is_empty());
    assert!(!d.kernel.is_empty());
    let inv = inventory::parse_inventory(&run(scripts::inventory_script()));
    assert!(inv.complete);
    if d.pm.is_some_and(|p| p != PackageManager::None) {
        assert!(inv.packages.len() > 20, "pocos paquetes: {}", inv.packages.len());
    }
}

// ───────────── Programas sueltos ─────────────

#[test]
fn upstream_programs() {
    let u = |p: &str, l: &str| ecosystem::upstream(p, l).map(|(e, n, v)| format!("{e}/{n}@{v}"));
    assert_eq!(u("node", "v18.0.0").as_deref(), Some("Bitnami/node@18.0.0"));
    assert_eq!(u("python3", "Python 3.10.0").as_deref(), Some("Bitnami/python@3.10.0"));
    assert_eq!(u("php", "PHP 8.1.0 (cli) (built: Nov 22 2021)").as_deref(), Some("Bitnami/php@8.1.0"));
    assert_eq!(u("java", "openjdk version \"17.0.1\" 2021-10-19").as_deref(), Some("Bitnami/java@17.0.1"));
    assert_eq!(u("java", "java version \"1.8.0_381\""), None);
    assert_eq!(u("nginx", "nginx version: nginx/1.20.0").as_deref(), Some("Bitnami/nginx@1.20.0"));
    assert_eq!(u("httpd", "Server version: Apache/2.4.57 (Unix)").as_deref(), Some("Bitnami/apache@2.4.57"));
    assert_eq!(u("caddy", "v2.6.0 h1:abc=").as_deref(), Some("Go/github.com/caddyserver/caddy/v2@2.6.0"));
    assert_eq!(u("podman", "podman version 4.0.0").as_deref(), Some("Go/github.com/containers/podman/v4@4.0.0"));
    assert_eq!(u("podman", "podman version 5.2.1").as_deref(), Some("Go/github.com/containers/podman/v5@5.2.1"));
    assert_eq!(u("docker", "Docker version 27.0.0, build 7d4bcd8").as_deref(), Some("Go/github.com/docker/docker@27.0.0"));
    assert_eq!(u("sudo", "Sudo version 1.9.17p2"), None);
    let deb = os(fx!("os-release-debian.txt"));
    assert!(ecosystem::is_distro_vendor(&deb, Some("Debian Nginx Maintainers <pkg-nginx-maintainers@alioth-lists.debian.net>")));
    assert!(!ecosystem::is_distro_vendor(&deb, Some("NGINX Packaging <nginx-packaging@f5.com>")));
    assert!(ecosystem::is_distro_vendor(&deb, None));
    assert!(ecosystem::is_kernel("linux") && ecosystem::is_kernel("linux-signed-amd64") && ecosystem::is_kernel("kernel"));
    assert!(!ecosystem::is_kernel("linux-base") && !ecosystem::is_kernel("util-linux"));
    assert_eq!(ecosystem::kernel_alias("linux-signed-amd64").as_deref(), Some("linux"));
    assert_eq!(ecosystem::kernel_alias("linux-signed-hwe-6.8").as_deref(), Some("linux-hwe-6.8"));
}

// ───────────── Gravedad ─────────────

#[test]
fn severity_rules() {
    assert_eq!(severity::from_text("Important"), Some(Severity::High));
    assert_eq!(severity::from_text("Moderate"), Some(Severity::Medium));
    assert_eq!(severity::from_text("negligible"), Some(Severity::Low));
    assert_eq!(severity::from_text("unimportant"), Some(Severity::Low));
    assert_eq!(severity::from_text("low**"), Some(Severity::Low));
    assert_eq!(severity::from_text("CRITICAL"), Some(Severity::Critical));
    assert_eq!(severity::from_text("not yet assigned"), None);
    assert_eq!(severity::from_score(9.8), Severity::Critical);
    assert_eq!(severity::from_score(7.0), Severity::High);
    assert_eq!(severity::from_score(4.0), Severity::Medium);
    assert_eq!(severity::from_score(0.1), Severity::Low);
    assert_eq!(severity::cvss_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), Some(9.8));
    assert_eq!(severity::cvss_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:N/A:H"), Some(6.5));
    // CVSS 4.0 (va por tablas): ejemplos de la calculadora oficial de FIRST.
    assert_eq!(severity::cvss_score("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), Some(9.3));
    assert_eq!(severity::cvss_score("CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), Some(8.5));
    assert_eq!(severity::cvss_score("basura"), None);
    // La distro manda; si no hay, CVSS.
    assert_eq!(severity::combine(Some("low"), Some(9.8)), Severity::Low);
    assert_eq!(severity::combine(Some("not yet assigned"), Some(9.8)), Severity::Critical);
    assert_eq!(severity::combine(None, None), Severity::Unknown);
    assert_eq!(severity::from_summary_prefix("Moderate: curl security update").as_deref(), Some("Moderate"));
    assert_eq!(severity::from_summary_prefix("libtasn1-6 - security update"), None);
}

// ───────────── Avisos de OSV (respuestas reales) ─────────────

fn vuln(name: &str) -> OsvVuln {
    let text = match name {
        "DSA-5863-1" => fx!("osv/DSA-5863-1.json"),
        "DEBIAN-CVE-2023-45853" => fx!("osv/DEBIAN-CVE-2023-45853.json"),
        "ALPINE-CVE-2023-2650" => fx!("osv/ALPINE-CVE-2023-2650.json"),
        "RLSA-2022:6157" => fx!("osv/RLSA-2022_6157.json"),
        "UBUNTU-CVE-2023-50495" => fx!("osv/UBUNTU-CVE-2023-50495.json"),
        "ALSA-2023:0333" => fx!("osv/ALSA-2023_0333.json"),
        "CVE-2023-2650" => fx!("osv/CVE-2023-2650.json"),
        _ => panic!("sin fixture {name}"),
    };
    serde_json::from_str(text).unwrap()
}

#[test]
fn osv_vuln_fields() {
    let dsa = vuln("DSA-5863-1");
    assert_eq!(dsa.cves(), ["CVE-2024-12133"]);
    assert_eq!(dsa.fixed_for("Debian:12", "libtasn1-6", "4.19.0-2").as_deref(), Some("4.19.0-2+deb12u1"));
    assert!(ecosystem::is_advisory(&dsa.id));

    let z = vuln("DEBIAN-CVE-2023-45853");
    assert_eq!(z.cves(), ["CVE-2023-45853"]);
    assert_eq!(z.fixed_for("Debian:12", "zlib", "1:1.2.13.dfsg-1"), None, "zlib sin arreglo");
    assert_eq!(z.fixed_for("Debian:12", "minizip", "1.1-8").as_deref(), Some("1.1-8+deb12u1"));
    assert_eq!(z.distro_severity("Debian:12", "zlib").as_deref(), Some("not yet assigned"));
    assert_eq!(z.cvss("Debian:12", "zlib").map(|c| c.0), Some(9.8));

    let r = vuln("RLSA-2022:6157");
    assert_eq!(r.cves(), ["CVE-2022-32206", "CVE-2022-32207", "CVE-2022-32208"]);
    assert_eq!(r.fixed_for("Rocky Linux:9", "curl", "7.76.1-14.el9_0.4").as_deref(), Some("7.76.1-14.el9_0.5"), "sin «0:»");
    assert_eq!(r.distro_severity("Rocky Linux:9", "curl").as_deref(), Some("Moderate"));
    assert_eq!(r.cvss("Rocky Linux:9", "curl").map(|c| c.0), Some(9.8));

    let u = vuln("UBUNTU-CVE-2023-50495");
    assert_eq!(u.distro_severity("Ubuntu:22.04:LTS", "ncurses").as_deref(), Some("low"));
    assert!(u.related.iter().any(|x| x.starts_with("USN-")));

    let a = vuln("ALPINE-CVE-2023-2650");
    assert_eq!(a.cves(), ["CVE-2023-2650"]);
    assert!(a.title().unwrap().len() > 10, "sin summary: se usa el principio de details");

    let al = vuln("ALSA-2023:0333");
    assert_eq!(al.cves(), ["CVE-2022-32221"]);
    // Un CVE puro de OSV: sus «related» son avisos, no otros CVE.
    assert_eq!(vuln("CVE-2023-2650").cves(), ["CVE-2023-2650"]);
}

#[test]
fn version_compare() {
    use std::cmp::Ordering::*;
    assert_eq!(osv::cmp_versions("1.2.10", "1.2.9"), Greater);
    assert_eq!(osv::cmp_versions("4.19.0-2+deb12u1", "4.19.0-2"), Greater);
    assert_eq!(osv::cmp_versions("1.0~rc1", "1.0"), Less);
    assert_eq!(osv::cmp_versions("0:7.76.1-14.el9_0.5", "7.76.1-14.el9_0.4"), Greater);
    assert_eq!(osv::cmp_versions("3.1.1u-r0", "3.1.0-r4"), Greater);
    assert_eq!(osv::cmp_versions("18.16.1", "18.16.1"), Equal);
}

// ───────────── OSV falsa: lotes, páginas, ecosistemas inválidos, caché ─────────────

#[derive(Default)]
struct FakeOsv {
    /// (ecosistema, nombre, versión) → ids. Si hay más de `page` ids, se paginan.
    db: HashMap<(String, String), Vec<String>>,
    page: usize,
    bad_ecosystems: Vec<String>,
    vulns: HashMap<String, Value>,
    batch_calls: AtomicUsize,
    batch_sizes: Mutex<Vec<usize>>,
    vuln_calls: AtomicUsize,
}

impl OsvApi for FakeOsv {
    async fn querybatch(&self, queries: &[(Query, Option<String>)]) -> Result<Vec<BatchItem>, OsvError> {
        self.batch_calls.fetch_add(1, Ordering::SeqCst);
        self.batch_sizes.lock().unwrap().push(queries.len());
        if queries.len() > osv::MAX_BATCH {
            return Err(OsvError::BadRequest("too many queries".into()));
        }
        if queries.iter().any(|(q, _)| self.bad_ecosystems.contains(&q.ecosystem)) {
            return Err(OsvError::BadRequest("invalid ecosystem".into()));
        }
        Ok(queries
            .iter()
            .map(|(q, tok)| {
                let all = self.db.get(&(q.ecosystem.clone(), q.name.clone())).cloned().unwrap_or_default();
                let start: usize = tok.as_deref().map(|t| t.parse().unwrap()).unwrap_or(0);
                let page = if self.page == 0 { usize::MAX } else { self.page };
                let end = all.len().min(start.saturating_add(page));
                BatchItem {
                    vulns: all[start..end].iter().map(|id| Hit { id: id.clone(), modified: "2026-01-01T00:00:00Z".into() }).collect(),
                    next_page_token: (end < all.len()).then(|| end.to_string()),
                }
            })
            .collect())
    }

    async fn vuln(&self, id: &str) -> Result<Value, OsvError> {
        self.vuln_calls.fetch_add(1, Ordering::SeqCst);
        self.vulns.get(id).cloned().ok_or(OsvError::NotFound)
    }
}

fn q(eco: &str, name: &str) -> Query {
    Query { ecosystem: eco.into(), name: name.into(), version: "1".into() }
}

#[tokio::test]
async fn osv_batches_of_1000_and_pagination() {
    let mut api = FakeOsv { page: 2, ..Default::default() };
    api.db.insert(("Debian:12".into(), "p5".into()), (0..5).map(|i| format!("V{i}")).collect());
    let queries: Vec<Query> = (0..2500).map(|i| q("Debian:12", &format!("p{i}"))).collect();
    let out = osv::query_all(&api, &queries, &CancellationToken::new()).await.unwrap();
    // 3 lotes (1000+1000+500) y luego 2 rondas solo con la consulta paginada.
    assert_eq!(*api.batch_sizes.lock().unwrap(), [1000, 1000, 500, 1, 1]);
    assert_eq!(out.hits[5].iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["V0", "V1", "V2", "V3", "V4"]);
    assert!(out.hits[6].is_empty());
    assert!(out.rejected.is_empty());
}

#[tokio::test]
async fn osv_invalid_ecosystem_does_not_sink_the_rest() {
    let mut api = FakeOsv { bad_ecosystems: vec!["Fedora:41".into()], ..Default::default() };
    api.db.insert(("Alpine:v3.18".into(), "openssl".into()), vec!["ALPINE-CVE-2023-2650".into()]);
    let queries = vec![q("Fedora:41", "curl"), q("Alpine:v3.18", "openssl"), q("Alpine:v3.18", "musl")];
    let out = osv::query_all(&api, &queries, &CancellationToken::new()).await.unwrap();
    assert_eq!(out.hits[1][0].id, "ALPINE-CVE-2023-2650");
    assert!(out.rejected.contains("Fedora:41"));
    assert_eq!(api.batch_calls.load(Ordering::SeqCst), 3, "el lote + uno por ecosistema");
}

#[tokio::test]
async fn osv_details_use_the_cache() {
    let dir = TempDir::new();
    let cache = OsvCache::at(dir.0.join("osv"));
    let mut api = FakeOsv::default();
    api.vulns.insert("DSA-5863-1".into(), serde_json::from_str(fx!("osv/DSA-5863-1.json")).unwrap());
    let ids = vec![("DSA-5863-1".to_string(), "2026-01-01T00:00:00Z".to_string()), ("NO-EXISTE".to_string(), String::new())];
    let cancel = CancellationToken::new();
    let (d, failed) = osv::fetch_details(&api, &cache, &ids, &cancel, &|_, _| {}).await.unwrap();
    assert!(d.contains_key("DSA-5863-1"));
    assert_eq!(failed, 1);
    assert_eq!(api.vuln_calls.load(Ordering::SeqCst), 2);
    // Segunda vez: el DSA sale de la caché (su `modified` real coincide con el guardado).
    let real_mod = d["DSA-5863-1"].modified.clone().unwrap();
    let ids2 = vec![("DSA-5863-1".to_string(), real_mod)];
    osv::fetch_details(&api, &cache, &ids2, &cancel, &|_, _| {}).await.unwrap();
    assert_eq!(api.vuln_calls.load(Ordering::SeqCst), 2, "no se volvió a pedir");
    // Si OSV dice otra fecha, se pide de nuevo.
    let ids3 = vec![("DSA-5863-1".to_string(), "2099-01-01T00:00:00Z".to_string())];
    osv::fetch_details(&api, &cache, &ids3, &cancel, &|_, _| {}).await.unwrap();
    assert_eq!(api.vuln_calls.load(Ordering::SeqCst), 3);
    assert!(OsvCache::none().get("DSA-5863-1", None).is_none());
}

// ───────────── Análisis completo con OSV falsa ─────────────

fn raw(stdout: impl Into<String>) -> RawOutput {
    RawOutput { stdout: stdout.into(), ..Default::default() }
}

fn debian_input() -> ScanInput {
    let detect = format!(
        "@@os\n{}\n@@kernel\nLinux 6.1.0 x86_64\n@@id\nana\n1000\n@@container\nyes\n@@pm\ndpkg\n@@tools\ndebsecan\t/usr/bin/debsecan\n@@end\n",
        fx!("os-release-debian.txt")
    );
    let inventory = format!(
        "@@pm\ndpkg\n@@pkgs\n{}@@tools\nnode\t/home/ana/.nvm/versions/node/v18.0.0/bin/node\t\t\tv18.0.0\n\
         nginx\t/usr/sbin/nginx\tnginx\tNGINX Packaging <nginx-packaging@f5.com>\tnginx version: nginx/1.20.0\n@@home\n@@end\n",
        fx!("dpkg-debian.txt")
    );
    let debsecan = "@@debsecan\nCVE-2024-12133 (fixed, high urgency)\n  A flaw in libtasn1 ...\n  installed: libtasn1-6 4.19.0-2\n             (built from libtasn1-6 4.19.0-2)\n  fix is available for the selected suite (bookworm)\n\n@@rc 0\n@@end\n";
    ScanInput {
        server_id: "srv-prueba".into(),
        detect: raw(detect),
        inventory: raw(inventory),
        distro_tool: Some(DistroTool::Debsecan),
        distro_output: Some(raw(debsecan)),
        images: vec![],
        elevated: false,
        use_osv: true,
        notes: vec![],
        server_ms: 10,
    }
}

fn debian_osv() -> FakeOsv {
    let mut api = FakeOsv::default();
    api.db.insert(("Debian:12".into(), "libtasn1-6".into()), vec!["DSA-5863-1".into(), "DEBIAN-CVE-2024-12133".into()]);
    api.db.insert(("Debian:12".into(), "zlib".into()), vec!["DEBIAN-CVE-2023-45853".into()]);
    api.db.insert(("Bitnami".into(), "node".into()), vec!["BIT-node-2023-30581".into()]);
    api.vulns.insert("DSA-5863-1".into(), serde_json::from_str(fx!("osv/DSA-5863-1.json")).unwrap());
    api.vulns.insert(
        "DEBIAN-CVE-2024-12133".into(),
        json!({"id":"DEBIAN-CVE-2024-12133","modified":"2026-01-01T00:00:00Z","upstream":["CVE-2024-12133"],
               "details":"Potential DoS in libtasn1","severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"}],
               "affected":[{"package":{"ecosystem":"Debian:12","name":"libtasn1-6"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"4.19.0-2+deb12u1"}]}],
               "ecosystem_specific":{"urgency":"low"}}]}),
    );
    let mut z: Value = serde_json::from_str(fx!("osv/DEBIAN-CVE-2023-45853.json")).unwrap();
    z["affected"][1]["ecosystem_specific"]["urgency"] = json!("unimportant");
    api.vulns.insert("DEBIAN-CVE-2023-45853".into(), z);
    api.vulns.insert(
        "BIT-node-2023-30581".into(),
        json!({"id":"BIT-node-2023-30581","modified":"2026-01-01T00:00:00Z","aliases":["CVE-2023-30581"],"summary":"policy bypass",
               "database_specific":{"severity":"High"},
               "affected":[{"package":{"ecosystem":"Bitnami","name":"node"},"ranges":[{"type":"SEMVER","events":[{"introduced":"16.0.0"},{"fixed":"16.20.1"},{"introduced":"18.0.0"},{"fixed":"18.16.1"},{"introduced":"20.0.0"},{"fixed":"20.3.1"}]}]}]}),
    );
    api
}

#[tokio::test]
async fn analyze_merges_sources_by_cve() {
    let api = debian_osv();
    let dir = TempDir::new();
    let cache = OsvCache::at(dir.0.join("osv"));
    let p = no_progress();
    let r = analyze(&debian_input(), Some(&api), &cache, &CancellationToken::new(), &p).await.unwrap();

    // DSA-5863-1 + DEBIAN-CVE-2024-12133 + debsecan → una sola fila por CVE.
    let tasn: Vec<_> = r.findings.iter().filter(|f| f.package == "libtasn1-6").collect();
    assert_eq!(tasn.len(), 1, "{tasn:#?}");
    let t = tasn[0];
    assert_eq!(t.id, "CVE-2024-12133");
    assert_eq!(t.advisories, ["DSA-5863-1"]);
    assert!(t.aliases.contains(&"DEBIAN-CVE-2024-12133".to_string()));
    assert_eq!(t.sources, [SourceId::Osv, SourceId::Distro]);
    assert_eq!(t.fixed.as_deref(), Some("4.19.0-2+deb12u1"));
    assert!(t.has_fix);
    assert_eq!(t.severity, Severity::High, "la urgencia más alta de la distro (debsecan: high)");
    assert_eq!(t.binaries, ["libtasn1-6"]);
    assert_eq!(t.target, "system");

    // zlib «unimportant»: oculta y fuera de los totales.
    let z = r.findings.iter().find(|f| f.id == "CVE-2023-45853" && f.package == "zlib").unwrap();
    assert!(z.unimportant);
    assert!(!z.has_fix);
    assert_eq!(z.binaries, ["zlib1g"]);
    assert_eq!(r.summary.unimportant, 1);

    // Node suelto en $HOME → Bitnami, con la versión que arregla su rama.
    let n = r.findings.iter().find(|f| f.package == "node").unwrap();
    assert_eq!((n.id.as_str(), n.target.as_str()), ("CVE-2023-30581", "runtime"));
    assert_eq!(n.fixed.as_deref(), Some("18.16.1"));
    assert!(n.upstream);
    assert_eq!(n.severity, Severity::High);
    // nginx de nginx.org (terceros) → también suelto; y su paquete no se consulta como de Debian.
    assert!(r.osv_sample.iter().any(|s| s.ecosystem == "Bitnami" && s.name == "nginx" && s.version == "1.20.0"));
    assert!(r.programs.iter().any(|p| p.name == "nginx" && p.third_party));

    // Lo que viajó a OSV: solo ecosistema, nombre y versión; fuente en Debian.
    assert!(r.osv_sample.iter().any(|s| s.ecosystem == "Debian:12" && s.name == "util-linux" && s.version == "2.38.1-5"));
    assert!(!r.osv_sample.iter().any(|s| s.name == "bsdutils"));
    assert!(r.sources.iter().all(|s| s.used || s.id == SourceId::Trivy));
    assert_eq!(r.summary.total, r.findings.iter().filter(|f| !f.unimportant).count() as u32);
    assert!(r.notes.iter().any(|n| n.text.contains("contenedor")));
    assert!(r.notes.iter().any(|n| n.text.contains("Sin sudo")));
    assert_eq!(r.host.ecosystem.as_deref(), Some("Debian:12"));
}

#[tokio::test]
async fn analyze_without_osv_and_with_images() {
    let mut input = debian_input();
    input.use_osv = false;
    input.elevated = true;
    let listing = "@@images\ndd89c878aa26\tdocker.io/library/rockylinux:9.0\n@@containers\nc1c1c1c1c1c1\tapp\tdd89c878aa26ffff\trunning\n@@end\n";
    let trivy = format!("@@os\n{}\n@@trivyver\nVersion: 0.76.2\n@@trivy\n{}@@rc 0\n@@end\n", fx!("os-release-rockylinux.txt"), fx!("trivy-rootfs-rocky90.tsv"));
    input.images = vec![
        ImageRaw { engine: Some(Engine::Podman), user: Some("ana".into()), listing: Some(listing.into()), ..Default::default() },
        ImageRaw {
            engine: Some(Engine::Podman),
            user: Some("ana".into()),
            image_id: "dd89c878aa26".into(),
            output: Some(raw(trivy)),
            ..Default::default()
        },
    ];
    let p = no_progress();
    let r = analyze::<FakeOsv>(&input, None, &OsvCache::none(), &CancellationToken::new(), &p).await.unwrap();
    let img = r.targets.iter().find(|t| t.kind == TargetKind::Image).unwrap();
    assert_eq!(img.key, "image:podman:ana:dd89c878aa26");
    let info = img.image.as_ref().unwrap();
    assert_eq!(info.tags, ["docker.io/library/rockylinux:9.0"]);
    assert_eq!(info.containers[0].name, "app");
    assert_eq!(info.method.as_deref(), Some("Trivy 0.76.2"));
    let n = r.findings.iter().filter(|f| f.target == img.key).count();
    assert!(n > 500, "{n}");
    let acl = r.findings.iter().find(|f| f.target == img.key && f.id == "CVE-2026-54369").unwrap();
    assert_eq!(acl.severity, Severity::High);
    assert_eq!(acl.sources, [SourceId::Trivy]);
    let osv = r.sources.iter().find(|s| s.id == SourceId::Osv).unwrap();
    assert!(!osv.used);
    assert_eq!(osv.note.as_deref(), Some("desactivado en Ajustes"));
    assert!(r.sources.iter().find(|s| s.id == SourceId::Trivy).unwrap().used);
    // Solo debsecan para el sistema.
    assert!(r.findings.iter().any(|f| f.target == "system" && f.sources == [SourceId::Distro]));
}

#[tokio::test]
async fn analyze_fedora_tool_only() {
    let detect = format!("@@os\n{}\n@@pm\nrpm\n@@tools\ndnf\t/usr/bin/dnf\n@@dnf\ndnf5 version 5.2.17.0\n@@end\n", fx!("os-release-fedora.txt"));
    let inv = format!("@@pm\nrpm\n@@pkgs\n{}@@tools\n@@home\n@@end\n", fx!("rpm-fedora.txt"));
    let tool = format!(
        "@@list\n{}\n@@rc 0\n@@info\n{}\n@@rc 0\n@@end\n",
        fx!("dnf5-advisory-list-fedora44.json"),
        fx!("dnf5-advisory-info-fedora44.json")
    );
    let input = ScanInput {
        server_id: "fed".into(),
        detect: raw(detect),
        inventory: raw(inv),
        distro_tool: Some(DistroTool::Dnf5),
        distro_output: Some(raw(tool)),
        use_osv: true,
        ..Default::default()
    };
    let api = FakeOsv::default();
    let p = no_progress();
    let r = analyze(&input, Some(&api), &OsvCache::none(), &CancellationToken::new(), &p).await.unwrap();
    assert_eq!(api.batch_calls.load(Ordering::SeqCst), 0, "Fedora no va a OSV");
    assert!(r.notes.iter().any(|n| n.text.contains("Fedora no está en OSV")));
    // curl y libcurl → un hallazgo por CVE en el paquete fuente curl.
    let c = r.findings.iter().find(|f| f.id == "CVE-2026-8932").unwrap();
    assert_eq!(c.package, "curl");
    assert_eq!(c.binaries.len(), 2);
    assert_eq!(c.advisories, ["FEDORA-2026-a06b828d65"]);
    assert_eq!(c.severity, Severity::Medium);
    let o = r.findings.iter().find(|f| f.id == "FEDORA-2026-12f3f3d569").unwrap();
    assert_eq!((o.package.as_str(), o.severity), ("openssl", Severity::High));
    assert_eq!(r.summary.total as usize, r.findings.len());
    assert_eq!(r.summary.with_fix, r.summary.total);
}

#[tokio::test]
async fn analyze_can_be_canceled() {
    let api = debian_osv();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let p = no_progress();
    let r = analyze(&debian_input(), Some(&api), &OsvCache::none(), &cancel, &p).await;
    assert!(matches!(r, Err(crate::error::AppError::Canceled)));
}

// ───────────── Historial y exportar ─────────────

async fn sample_report() -> Report {
    let api = debian_osv();
    let p = no_progress();
    analyze(&debian_input(), Some(&api), &OsvCache::none(), &CancellationToken::new(), &p).await.unwrap()
}

#[tokio::test]
async fn history_keeps_20_and_ai() {
    let dir = TempDir::new();
    let h = History::at(&dir.0);
    let base = sample_report().await;
    let mut last = String::new();
    for i in 0..23 {
        let mut r = base.clone();
        r.id = format!("r{i}");
        h.save(&r).unwrap();
        last = r.id;
    }
    let list = h.list("srv-prueba").unwrap();
    assert_eq!(list.len(), 20);
    assert_eq!(list[0].id, last);
    assert_eq!(h.latest("srv-prueba").unwrap().unwrap().id, last);
    assert!(h.get("srv-prueba", "r0").is_err(), "el más viejo se fue");
    let ai = AiExplanation { model: "m".into(), created_at: "2026-11-12T00:00:00Z".into(), text: "hola".into() };
    let r = h.set_ai("srv-prueba", "r10", Some(ai.clone())).unwrap();
    assert_eq!(r.ai, Some(ai));
    assert!(h.list("srv-prueba").unwrap().iter().any(|m| m.id == "r10" && m.has_ai));
    h.delete("srv-prueba", Some("r10")).unwrap();
    assert_eq!(h.list("srv-prueba").unwrap().len(), 19);
    h.delete("srv-prueba", None).unwrap();
    assert!(h.list("srv-prueba").unwrap().is_empty());
    assert!(h.latest("../etc/passwd").is_err(), "ids raros no valen");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        h.save(&base).unwrap();
        let mode = std::fs::metadata(dir.0.join("srv-prueba.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[tokio::test]
async fn export_markdown_and_json() {
    let r = sample_report().await;
    let md = export::to_markdown(&r, Some("Mi servidor"));
    assert!(md.starts_with("# Vulnerabilidades de Mi servidor"));
    assert!(md.contains("| Crítica | Alta |"));
    assert!(md.contains("CVE-2024-12133"));
    assert!(md.contains("sin importancia"), "{md}");
    let anon = export::to_markdown(&r, None);
    assert!(anon.starts_with("# Vulnerabilidades de servidor-1"));
    let j = export::to_json(&r, true);
    let back: Report = serde_json::from_str(&j).unwrap();
    assert_eq!(back.server_id, "servidor-1");
    assert_eq!(back.findings.len(), r.findings.len());
}

// ───────────── Volver a analizar una imagen («Actualizar imagen») ─────────────

#[tokio::test]
async fn rescan_replaces_only_that_image() {
    let mut input = debian_input();
    input.use_osv = false;
    input.elevated = true;
    let listing = "@@images\ndd89c878aa26\tdocker.io/library/rockylinux:9.0\n@@containers\nc1c1c1c1c1c1\tapp\tdd89c878aa26ffff\trunning\n@@end\n";
    let trivy = format!("@@os\n{}\n@@trivyver\nVersion: 0.76.2\n@@trivy\n{}@@rc 0\n@@end\n", fx!("os-release-rockylinux.txt"), fx!("trivy-rootfs-rocky90.tsv"));
    input.images = vec![
        ImageRaw { engine: Some(Engine::Podman), user: Some("ana".into()), listing: Some(listing.into()), ..Default::default() },
        ImageRaw { engine: Some(Engine::Podman), user: Some("ana".into()), image_id: "dd89c878aa26".into(), output: Some(raw(trivy)), ..Default::default() },
    ];
    let p = no_progress();
    let base = analyze::<FakeOsv>(&input, None, &OsvCache::none(), &CancellationToken::new(), &p).await.unwrap();
    let old_key = "image:podman:ana:dd89c878aa26";
    let system = base.findings.iter().filter(|f| f.target == "system").count();
    assert!(base.findings.iter().any(|f| f.target == old_key));

    // La imagen nueva (otro id, misma etiqueta) ya no tiene nada.
    let listing = "@@images\neeeeeeeeeeee\tdocker.io/library/rockylinux:9.0\n@@containers\nc2c2c2c2c2c2\tapp\teeeeeeeeeeeeffff\trunning\n@@end\n";
    let out = format!("@@os\n{}\n@@trivyver\nVersion: 0.76.2\n@@trivy\n@@rc 0\n@@end\n", fx!("os-release-rockylinux.txt"));
    let partial_input = ScanInput {
        server_id: base.server_id.clone(),
        images: vec![
            ImageRaw { engine: Some(Engine::Podman), user: Some("ana".into()), listing: Some(listing.into()), ..Default::default() },
            ImageRaw { engine: Some(Engine::Podman), user: Some("ana".into()), image_id: "eeeeeeeeeeee".into(), output: Some(raw(out)), ..Default::default() },
        ],
        elevated: true,
        ..Default::default()
    };
    let partial = analyze::<FakeOsv>(&partial_input, None, &OsvCache::none(), &CancellationToken::new(), &p).await.unwrap();
    let m = super::analyze::merge_rescan(&base, old_key, &partial);
    assert_ne!(m.id, base.id);
    assert!(m.targets.iter().all(|t| t.key != old_key), "la imagen vieja se quita");
    let t = m.targets.iter().find(|t| t.key == "image:podman:ana:eeeeeeeeeeee").unwrap();
    assert_eq!(t.image.as_ref().unwrap().containers[0].name, "app");
    assert!(m.findings.iter().all(|f| f.target != old_key));
    assert_eq!(m.findings.iter().filter(|f| f.target == "system").count(), system, "el sistema no cambia");
    assert!(m.targets.iter().any(|t| t.key == "system"));
    assert_eq!(m.summary.total + m.summary.unimportant, m.findings.len() as u32);
    assert!(m.summary.total < base.summary.total);
    assert!(m.notes.iter().any(|n| n.text.contains("Actualizar imagen")));
    // Solo los avisos de imágenes del análisis parcial (no «detección incompleta», etc.).
    assert!(!m.notes.iter().any(|n| n.text.contains("detección")));
}
