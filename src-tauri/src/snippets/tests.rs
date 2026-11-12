use std::fs;
use std::path::PathBuf;

use super::exec;
use super::store::SnippetStore;
use crate::types::{Snippet, SnippetScope};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("terview-snippets-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn snip(name: &str, command: &str) -> Snippet {
    Snippet {
        id: String::new(),
        name: name.into(),
        description: Some("  ".into()),
        command: command.into(),
        category: "".into(),
        scope: SnippetScope::Global,
        scope_id: Some("ignorado".into()),
        dangerous: false,
        sudo: false,
        read_only: true,
    }
}

#[test]
fn save_assigns_id_normalizes_and_persists() {
    let dir = TempDir::new();
    let path = dir.file("commands.json");
    let store = SnippetStore::load_from(&path);
    assert!(store.list().is_empty());

    let saved = store.save(snip("  Ver logs ", " podman logs {{c}} ")).unwrap();
    assert_eq!(uuid::Uuid::parse_str(&saved.id).unwrap().get_version_num(), 4);
    assert_eq!(saved.name, "Ver logs");
    assert_eq!(saved.command, "podman logs {{c}}");
    assert_eq!(saved.description, None);
    assert_eq!(saved.category, "Mis comandos");
    assert_eq!(saved.scope_id, None, "global no lleva scopeId");

    // Recargar desde disco.
    let again = SnippetStore::load_from(&path);
    let list = again.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, saved.id);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // No quedan temporales.
    let leftovers: Vec<_> = fs::read_dir(&dir.0).unwrap().filter_map(|e| e.ok()).collect();
    assert_eq!(leftovers.len(), 1);
}

#[test]
fn update_and_delete() {
    let dir = TempDir::new();
    let store = SnippetStore::load_from(dir.file("commands.json"));
    let a = store.save(snip("A", "echo a")).unwrap();
    let b = store.save(snip("B", "echo b")).unwrap();

    let mut a2 = a.clone();
    a2.command = "echo a2".into();
    a2.dangerous = true;
    store.save(a2).unwrap();
    let list = store.list();
    assert_eq!(list.len(), 2);
    let got = list.iter().find(|s| s.id == a.id).unwrap();
    assert_eq!(got.command, "echo a2");
    assert!(got.dangerous);

    // Actualizar uno que no existe → error.
    let mut ghost = snip("X", "echo x");
    ghost.id = "no-existe".into();
    assert!(store.save(ghost).is_err());

    store.delete(&b.id).unwrap();
    assert_eq!(store.list().len(), 1);
    assert!(store.delete(&b.id).is_err());

    let reloaded = SnippetStore::load_from(dir.file("commands.json"));
    assert_eq!(reloaded.list().len(), 1);
    assert_eq!(reloaded.list()[0].command, "echo a2");
}

#[test]
fn validation() {
    let dir = TempDir::new();
    let store = SnippetStore::load_from(dir.file("commands.json"));
    assert!(store.save(snip("  ", "ls")).is_err());
    assert!(store.save(snip("Nombre", "   ")).is_err());

    let mut s = snip("Proyecto", "ls");
    s.scope = SnippetScope::Project;
    s.scope_id = None;
    assert!(store.save(s.clone()).is_err());
    s.scope_id = Some("  ".into());
    assert!(store.save(s.clone()).is_err());
    s.scope_id = Some("p1".into());
    let saved = store.save(s).unwrap();
    assert_eq!(saved.scope_id.as_deref(), Some("p1"));

    let mut srv = snip("Servidor", "ls");
    srv.scope = SnippetScope::Server;
    srv.scope_id = None;
    assert!(store.save(srv).is_err());

    // Nada inválido llegó a disco.
    assert_eq!(SnippetStore::load_from(dir.file("commands.json")).list().len(), 1);
}

#[test]
fn corrupt_file_is_backed_up() {
    let dir = TempDir::new();
    let path = dir.file("commands.json");
    fs::write(&path, b"{ esto no es json").unwrap();
    let store = SnippetStore::load_from(&path);
    assert!(store.list().is_empty());
    assert!(!path.exists());
    let backups: Vec<_> = fs::read_dir(&dir.0)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("commands.json.bak-"))
        .collect();
    assert_eq!(backups.len(), 1);
    // Se puede seguir guardando.
    store.save(snip("A", "ls")).unwrap();
    assert!(path.exists());
}

#[test]
fn accepts_plain_list_and_repairs_ids() {
    let dir = TempDir::new();
    let path = dir.file("commands.json");
    fs::write(
        &path,
        r#"[
          {"id":"","name":"A","description":null,"command":"ls","category":"X","scope":"global","scopeId":null,"dangerous":false,"sudo":false,"readOnly":true},
          {"id":"dup","name":"B","description":null,"command":"ls","category":"X","scope":"global","scopeId":null,"dangerous":false,"sudo":false,"readOnly":true},
          {"id":"dup","name":"C","description":null,"command":"ls","category":"X","scope":"global","scopeId":null,"dangerous":false,"sudo":false,"readOnly":true},
          {"id":"bad","name":"","description":null,"command":"ls","category":"X","scope":"global","scopeId":null,"dangerous":false,"sudo":false,"readOnly":true}
        ]"#,
    )
    .unwrap();
    let store = SnippetStore::load_from(&path);
    let list = store.list();
    assert_eq!(list.len(), 3);
    let ids: std::collections::HashSet<_> = list.iter().map(|s| s.id.clone()).collect();
    assert_eq!(ids.len(), 3);
    assert!(list.iter().all(|s| !s.id.is_empty()));
}

#[test]
fn timeout_is_clamped() {
    assert_eq!(exec::clamp_timeout(0), 1);
    assert_eq!(exec::clamp_timeout(30), 30);
    assert_eq!(exec::clamp_timeout(10_000), 600);
}

// ───────────── Con el servidor de pruebas (127.0.0.1:2222) ─────────────

async fn session() -> std::sync::Arc<crate::ssh::SshSession> {
    crate::ssh::connect::testutil::connect_test_server().await
}

#[tokio::test]
#[ignore]
async fn live_exec_echo() {
    let s = session().await;
    let r = exec::run(&s, "echo hola mundo", 10).await.unwrap();
    assert_eq!(r.stdout, "hola mundo\n");
    assert_eq!(r.stderr, "");
    assert_eq!(r.exit_code, Some(0));
    assert!(!r.truncated && !r.timed_out);
}

#[tokio::test]
#[ignore]
async fn live_exec_stderr_and_exit_code() {
    let s = session().await;
    let r = exec::run(&s, "echo salida; echo fallo >&2; exit 3", 10).await.unwrap();
    assert_eq!(r.stdout, "salida\n");
    assert_eq!(r.stderr, "fallo\n");
    assert_eq!(r.exit_code, Some(3));
    assert!(!r.timed_out);
}

#[tokio::test]
#[ignore]
async fn live_exec_timeout() {
    let s = session().await;
    let t0 = std::time::Instant::now();
    let r = exec::run(&s, "echo antes; sleep 5; echo despues", 1).await.unwrap();
    assert!(r.timed_out);
    assert!(t0.elapsed() < std::time::Duration::from_secs(4));
    assert_eq!(r.stdout, "antes\n");
    // La sesión sigue sirviendo después de cortar un canal.
    let r2 = exec::run(&s, "echo ok", 10).await.unwrap();
    assert_eq!(r2.stdout, "ok\n");
}

#[tokio::test]
#[ignore]
async fn live_exec_truncates_big_output() {
    let s = session().await;
    // ~3 MB de salida.
    let r = exec::run(&s, "head -c 3000000 /dev/zero | tr '\\0' 'a'", 60).await.unwrap();
    assert!(r.truncated);
    assert_eq!(r.stdout.len(), exec::MAX_STREAM_BYTES);
    assert_eq!(r.exit_code, Some(0));
    assert!(!r.timed_out);
}

#[tokio::test]
#[ignore]
async fn live_exec_stdin_cat_echoes_input() {
    let s = session().await;
    let input = "línea 1\nlínea 2 con 'comillas' y $VAR\n";
    let r = exec::run_with_stdin(&s, "cat", input.as_bytes(), 10).await.unwrap();
    assert_eq!(r.stdout, input);
    assert_eq!(r.exit_code, Some(0));
    assert!(!r.timed_out);
}

#[tokio::test]
#[ignore]
async fn live_exec_stdin_read_line() {
    let s = session().await;
    let r = exec::run_with_stdin(&s, "sh -c 'read a; echo \"ok:$a\"'", b"secreto\nresto\n", 10)
        .await
        .unwrap();
    assert_eq!(r.stdout, "ok:secreto\n");
    assert_eq!(r.exit_code, Some(0));
}

#[tokio::test]
#[ignore]
async fn live_exec_stdin_ignored_by_command_and_large() {
    let s = session().await;
    // El comando no lee stdin: no debe bloquearse.
    let r = exec::run_with_stdin(&s, "echo hola", b"nada\n", 10).await.unwrap();
    assert_eq!(r.stdout, "hola\n");
    // Entrada grande (supera la ventana inicial del canal) mientras se lee la salida.
    let big = vec![b'x'; 3_000_000];
    let r = exec::run_with_stdin(&s, "wc -c", &big, 60).await.unwrap();
    assert_eq!(r.stdout.trim(), "3000000");
    // Sin EOF el comando quedaría esperando: con stdin vacío, `cat` termina enseguida.
    let r = exec::run_with_stdin(&s, "cat", b"", 5).await.unwrap();
    assert!(!r.timed_out);
    assert_eq!(r.stdout, "");
}

/// Mismo arranque que usa la pestaña Administración (src/features/privileges/elevate.ts): el script llega
/// por stdin, `dd` lee exactamente sus bytes y lo que sigue (secretos) queda para el script.
#[tokio::test]
#[ignore]
async fn live_exec_stdin_bootstrap_script() {
    let s = session().await;
    let script = "IFS= read -r p\nprintf 'got:%s\\n' \"$p\"\ncat\n";
    let command = format!("sh -c 'eval \"$(dd bs=1 count={} 2>/dev/null)\"'", script.len());
    let stdin = format!("{script}secreto con espacios\nusuario:clave\n");
    let r = exec::run_with_stdin(&s, &command, stdin.as_bytes(), 10).await.unwrap();
    assert_eq!(r.stdout, "got:secreto con espacios\nusuario:clave\n");
    assert_eq!(r.exit_code, Some(0));
}
