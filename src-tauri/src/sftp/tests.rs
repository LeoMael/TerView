//! Tests contra el servidor de pruebas (127.0.0.1:2222). Ejecutar con:
//! `cargo test --lib sftp -- --ignored --test-threads=1`

use std::sync::Arc;

use super::SftpStore;
use crate::error::AppError;
use crate::ssh::connect::testutil::connect_test_server;
use crate::ssh::SshSession;
use crate::types::FileKind;

struct Ctx {
    ssh: Arc<SshSession>,
    store: SftpStore,
    base: String,
}

impl Ctx {
    async fn new() -> Self {
        let ssh = connect_test_server().await;
        let store = SftpStore::default();
        let base = format!("/config/tmp-sftp-{}", uuid::Uuid::new_v4().simple());
        store.mkdir(&ssh, &base).await.expect("mkdir base");
        Ctx { ssh, store, base }
    }
    fn p(&self, rel: &str) -> String {
        format!("{}/{rel}", self.base)
    }
    async fn cleanup(self) {
        self.store.delete(&self.ssh, std::slice::from_ref(&self.base)).await.expect("cleanup");
        assert!(matches!(self.store.stat(&self.ssh, &self.base).await, Err(AppError::NotFound(_))));
    }
}

fn podman_exec(args: &[&str]) {
    let st = std::process::Command::new("podman")
        .args(["exec", "terview-sshd"])
        .args(args)
        .status()
        .expect("podman");
    assert!(st.success(), "podman exec {args:?}");
}

#[tokio::test]
#[ignore]
async fn home_and_basic_ops() {
    let c = Ctx::new().await;
    let home = c.store.home(&c.ssh).await.unwrap();
    assert_eq!(home, "/config");

    // mkdir + create_file + duplicados
    c.store.mkdir(&c.ssh, &c.p("dir")).await.unwrap();
    let e = c.store.mkdir(&c.ssh, &c.p("dir")).await.unwrap_err();
    assert!(e.to_string().contains("Ya existe"), "{e}");
    c.store.create_file(&c.ssh, &c.p("a.txt")).await.unwrap();
    let e = c.store.create_file(&c.ssh, &c.p("a.txt")).await.unwrap_err();
    assert!(e.to_string().contains("Ya existe"), "{e}");

    // rename (incluido destino existente)
    c.store.create_file(&c.ssh, &c.p("b.txt")).await.unwrap();
    let e = c.store.rename(&c.ssh, &c.p("a.txt"), &c.p("b.txt")).await.unwrap_err();
    assert!(e.to_string().contains("Ya existe"), "{e}");
    c.store.rename(&c.ssh, &c.p("a.txt"), &c.p("c.txt")).await.unwrap();
    assert!(matches!(c.store.stat(&c.ssh, &c.p("a.txt")).await, Err(AppError::NotFound(_))));
    let st = c.store.stat(&c.ssh, &c.p("c.txt")).await.unwrap();
    assert_eq!(st.kind, FileKind::File);
    assert_eq!(st.name, "c.txt");
    assert_eq!(st.path, c.p("c.txt"));

    // chmod conserva el tipo
    c.store.chmod(&c.ssh, &c.p("c.txt"), 0o640).await.unwrap();
    let st = c.store.stat(&c.ssh, &c.p("c.txt")).await.unwrap();
    assert_eq!(st.permissions, Some(0o640));
    assert_eq!(st.permissions_str, "-rw-r-----");
    c.store.chmod(&c.ssh, &c.p("dir"), 0o750).await.unwrap();
    let st = c.store.stat(&c.ssh, &c.p("dir")).await.unwrap();
    assert_eq!(st.permissions_str, "drwxr-x---");

    // no encontrado
    let e = c.store.stat(&c.ssh, &c.p("nope")).await.unwrap_err();
    assert_eq!(e.kind(), "NotFound");

    c.cleanup().await;
}

#[tokio::test]
#[ignore]
async fn text_roundtrip_and_atomic_save() {
    let c = Ctx::new().await;
    let f = c.p("texto.md");
    let content = "Hola ñandú 🚀\nlínea 2\n";
    let entry = c.store.write_text(&c.ssh, &f, content).await.unwrap();
    assert_eq!(entry.size as usize, content.len());
    let rt = c.store.read_text(&c.ssh, &f, 1 << 20).await.unwrap();
    assert_eq!(rt.content, content);
    assert_eq!(rt.path, f);

    // Sobrescritura atómica conserva permisos
    c.store.chmod(&c.ssh, &f, 0o751).await.unwrap();
    let entry = c.store.write_text(&c.ssh, &f, "nuevo ✓").await.unwrap();
    assert_eq!(entry.permissions, Some(0o751));
    assert_eq!(c.store.read_text(&c.ssh, &f, 1 << 20).await.unwrap().content, "nuevo ✓");
    // OpenSSH ofrece posix-rename: el reemplazo es realmente atómico
    assert!(c.store.get_raw(&c.ssh).await.unwrap().posix_rename);
    // No quedan temporales
    let list = c.store.list_dir(&c.ssh, &c.base).await.unwrap();
    assert_eq!(list.len(), 1, "{list:?}");

    // Guardar a través de un symlink escribe en el destino y mantiene el enlace
    c.store.write_text(&c.ssh, &c.p("real.txt"), "uno").await.unwrap();
    podman_exec(&["ln", "-s", "real.txt", &c.p("link.txt")]);
    let e = c.store.write_text(&c.ssh, &c.p("link.txt"), "dos").await.unwrap();
    assert_eq!(e.kind, FileKind::Symlink);
    assert_eq!(c.store.read_text(&c.ssh, &c.p("real.txt"), 100).await.unwrap().content, "dos");

    // Demasiado grande
    let e = c.store.read_text(&c.ssh, &f, 3).await.unwrap_err();
    assert!(matches!(e, AppError::FileTooLarge(_)), "{e:?}");

    // Binario (NUL) y UTF-8 inválido
    podman_exec(&["sh", "-c", &format!("printf 'ab\\000cd' > {}", c.p("bin.dat"))]);
    let e = c.store.read_text(&c.ssh, &c.p("bin.dat"), 1 << 20).await.unwrap_err();
    assert!(e.to_string().contains("no es un archivo de texto"), "{e}");
    podman_exec(&["sh", "-c", &format!("printf 'ab\\377\\376' > {}", c.p("latin.txt"))]);
    let e = c.store.read_text(&c.ssh, &c.p("latin.txt"), 1 << 20).await.unwrap_err();
    assert!(e.to_string().contains("no es un archivo de texto"), "{e}");

    // Carpeta
    c.store.mkdir(&c.ssh, &c.p("d")).await.unwrap();
    assert!(c.store.read_text(&c.ssh, &c.p("d"), 100).await.is_err());
    assert!(c.store.write_text(&c.ssh, &c.p("d"), "x").await.is_err());

    c.cleanup().await;
}

#[tokio::test]
#[ignore]
async fn listing_sorting_and_symlinks() {
    let c = Ctx::new().await;
    for f in ["file10.txt", "File2.txt", "file1.txt", ".hidden", "b.txt"] {
        c.store.create_file(&c.ssh, &c.p(f)).await.unwrap();
    }
    for d in ["zeta", "Alpha"] {
        c.store.mkdir(&c.ssh, &c.p(d)).await.unwrap();
    }
    podman_exec(&["ln", "-s", "zeta", &c.p("mid-link")]);
    podman_exec(&["ln", "-s", "b.txt", &c.p("a-filelink")]);
    podman_exec(&["ln", "-s", "missing", &c.p("broken")]);

    let list = c.store.list_dir(&c.ssh, &format!("{}/", c.base)).await.unwrap();
    let names: Vec<_> = list.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Alpha", "mid-link", "zeta", ".hidden", "a-filelink", "b.txt", "broken", "file1.txt", "File2.txt", "file10.txt"]
    );
    let get = |n: &str| list.iter().find(|e| e.name == n).unwrap();
    assert!(get("mid-link").is_dir_link);
    assert_eq!(get("mid-link").kind, FileKind::Symlink);
    assert!(get("mid-link").permissions_str.starts_with('l'));
    assert!(!get("a-filelink").is_dir_link);
    assert!(!get("broken").is_dir_link);
    assert!(get("Alpha").permissions_str.starts_with('d'));
    assert_eq!(get("b.txt").path, c.p("b.txt"));
    assert!(get("b.txt").modified.is_some());

    // stat de un enlace a carpeta
    let st = c.store.stat(&c.ssh, &c.p("mid-link")).await.unwrap();
    assert!(st.is_dir_link);

    c.cleanup().await;
}

#[tokio::test]
#[ignore]
async fn recursive_delete_never_follows_links() {
    let c = Ctx::new().await;
    // Carpeta fuera del árbol a borrar, enlazada desde dentro.
    c.store.mkdir(&c.ssh, &c.p("keep")).await.unwrap();
    c.store.write_text(&c.ssh, &c.p("keep/precious.txt"), "no borrar").await.unwrap();

    c.store.mkdir(&c.ssh, &c.p("tree")).await.unwrap();
    c.store.mkdir(&c.ssh, &c.p("tree/sub")).await.unwrap();
    c.store.mkdir(&c.ssh, &c.p("tree/sub/deeper")).await.unwrap();
    for i in 0..40 {
        c.store.create_file(&c.ssh, &c.p(&format!("tree/sub/f{i}"))).await.unwrap();
    }
    c.store.write_text(&c.ssh, &c.p("tree/sub/deeper/x.txt"), "x").await.unwrap();
    podman_exec(&["ln", "-s", &c.p("keep"), &c.p("tree/link-to-keep")]);
    podman_exec(&["ln", "-s", &c.p("keep"), &c.p("toplink")]);

    c.store.delete(&c.ssh, &[c.p("tree"), c.p("toplink")]).await.unwrap();
    assert!(matches!(c.store.stat(&c.ssh, &c.p("tree")).await, Err(AppError::NotFound(_))));
    assert!(matches!(c.store.stat(&c.ssh, &c.p("toplink")).await, Err(AppError::NotFound(_))));
    let rt = c.store.read_text(&c.ssh, &c.p("keep/precious.txt"), 100).await.unwrap();
    assert_eq!(rt.content, "no borrar");

    // La raíz nunca se borra
    assert!(c.store.delete(&c.ssh, &["/".to_string()]).await.is_err());

    c.cleanup().await;
}

#[tokio::test]
#[ignore]
async fn permission_denied_message() {
    let c = Ctx::new().await;
    let e = c.store.mkdir(&c.ssh, "/root/terview-nope").await.unwrap_err();
    assert!(e.to_string().contains("permiso denegado"), "{e}");
    c.cleanup().await;
}

#[tokio::test]
#[ignore]
async fn reopens_dead_channel() {
    let c = Ctx::new().await;
    let s = c.store.get(&c.ssh).await.unwrap();
    s.close().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    // El canal está muerto: debe reabrirse solo y funcionar.
    let list = c.store.list_dir(&c.ssh, &c.base).await.unwrap();
    assert!(list.is_empty());
    let s2 = c.store.get(&c.ssh).await.unwrap();
    assert!(!Arc::ptr_eq(&s, &s2));
    c.cleanup().await;
}
