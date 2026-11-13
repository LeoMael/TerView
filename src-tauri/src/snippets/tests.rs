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

#[test]
fn bootstrap_is_safe_for_any_login_shell() {
    let b = exec::bootstrap(1234);
    assert!(b.starts_with("sh -c '") && b.ends_with('\''));
    let inner = &b["sh -c '".len()..b.len() - 1];
    // Dentro de las comillas simples: nada que bash, zsh, fish o tcsh interpreten.
    for bad in ['\'', '\\', '!', '\n', '\r'] {
        assert!(!inner.contains(bad), "el arranque no puede llevar {bad:?}");
    }
    assert!(inner.contains("count=1234"));
}

#[test]
fn pid_mark_is_taken_out_of_stderr() {
    let mut err = b"aviso del .bashrc\n__TERVIEW_PID__=4321\nerror real\n".to_vec();
    let t = exec::take_pid_mark(&mut err).unwrap();
    assert_eq!(t, exec::RemoteTarget { pid: 4321 });
    assert_eq!(err, b"aviso del .bashrc\nerror real\n");
    // Una vez quitada, ya no está.
    assert!(exec::take_pid_mark(&mut err).is_none());

    // Incompleta (sin salto de línea todavía): no se toca.
    let mut half = b"__TERVIEW_PID__=12".to_vec();
    assert!(exec::take_pid_mark(&mut half).is_none());
    assert_eq!(half, b"__TERVIEW_PID__=12");
    // Valores inválidos (o PID 0/1): no se aceptan.
    for bad in [&b"__TERVIEW_PID__=abc\n"[..], b"__TERVIEW_PID__=1\n", b"__TERVIEW_PID__=55:2\n"] {
        let mut v = bad.to_vec();
        assert!(exec::take_pid_mark(&mut v).is_none());
    }
}

#[test]
fn kill_command_only_has_numbers() {
    let t = exec::RemoteTarget { pid: 500 };
    assert_eq!(t.kill_command("TERM"), "sh -c 'kill -TERM -500 2>/dev/null || kill -TERM 500 2>/dev/null; exit 0'");
}

#[test]
fn registry_register_cancel_and_cleanup() {
    let reg = exec::ExecRegistry::default();
    assert!(!reg.cancel("x"), "no existe");
    assert!(reg.register("  ").is_err());
    {
        let ticket = reg.register("a").unwrap();
        assert!(reg.register("a").is_err(), "id repetido");
        assert!(!ticket.token.is_cancelled());
        assert!(reg.cancel("a"));
        assert!(ticket.token.is_cancelled());
    }
    // Al terminar se quita de la lista.
    assert!(!reg.cancel("a"));
    assert!(reg.register("a").is_ok());
}

/// Busca un programa en el PATH (como `command -v`).
#[cfg(unix)]
fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// El arranque, probado en local con cada shell disponible como "shell de login" (sin SSH):
/// el comando real llega por stdin, lo que sigue en stdin queda para el comando y se usa `$SHELL`.
/// `/bin/sh` se prueba siempre; bash, dash, zsh y busybox solo si están en el PATH (si falta alguno
/// se avisa y se sigue: los runners de la CI no traen zsh, por ejemplo).
#[cfg(unix)]
#[test]
fn bootstrap_runs_with_local_shells() {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let tmp = TempDir::new();
    let mut shells = vec![PathBuf::from("/bin/sh")];
    let mut missing = Vec::new();
    for name in ["bash", "dash", "zsh", "busybox"] {
        match find_in_path(name) {
            // Con busybox el applet sale del nombre del programa: en Alpine el shell de login es
            // /bin/sh -> /bin/busybox. Se imita con un enlace `ash` (como `$SHELL`, `busybox -c` falla).
            Some(bb) if name == "busybox" => {
                let ash = tmp.file("ash");
                std::os::unix::fs::symlink(&bb, &ash).unwrap();
                shells.push(ash);
            }
            Some(p) => shells.push(p),
            None => missing.push(name),
        }
    }
    if !missing.is_empty() {
        eprintln!("aviso: sin probar (no están en el PATH): {}", missing.join(", "));
    }

    let user_cmd = "printf '%s|' \"$1x\" 'comillas \"dobles\" y $HOME literal'; echo \"${0##*/}\"; read -r l; echo \"stdin:$l\"";
    for shell in &shells {
        let shell = shell.to_str().unwrap();
        let mut child = Command::new(shell)
            .args(["-c", &exec::bootstrap(user_cmd.len())])
            .env("SHELL", shell)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = user_cmd.as_bytes().to_vec();
        input.extend_from_slice(b"linea secreta\n");
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let out = child.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut stderr = out.stderr.clone();
        let target = exec::take_pid_mark(&mut stderr).unwrap_or_else(|| panic!("{shell}: sin marca"));
        assert!(target.pid > 1);
        assert_eq!(String::from_utf8_lossy(&stderr), "", "{shell}");
        let name = shell.rsplit('/').next().unwrap();
        assert_eq!(
            stdout,
            format!("x|comillas \"dobles\" y $HOME literal|{name}\nstdin:linea secreta\n"),
            "{shell}"
        );
    }
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

/// Cuenta los procesos remotos cuya línea de comandos contiene `pattern` (p. ej. "slee[p] 3001":
/// los corchetes evitan contar al propio shell que ejecuta pgrep).
async fn remote_count(s: &crate::ssh::SshSession, pattern: &str) -> usize {
    let r = exec::run(s, &format!("pgrep -f '{pattern}' | wc -l"), 10).await.unwrap();
    r.stdout.trim().parse().unwrap()
}

/// Limpia restos de una ejecución anterior de las pruebas que haya fallado a medias.
async fn remote_cleanup(s: &crate::ssh::SshSession) {
    let _ = exec::run(s, "pkill -9 -f 'slee[p] 30[0-9][0-9]'; true", 10).await;
}

/// Espera a que el comando esté en marcha (comprueba que `pattern` existe en el servidor) y cancela.
async fn check_running_then_cancel(
    s: &crate::ssh::SshSession,
    pattern: &str,
    expected: usize,
    token: tokio_util::sync::CancellationToken,
) {
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    assert_eq!(remote_count(s, pattern).await, expected, "el comando debería estar en marcha");
    token.cancel();
}

/// Cancelar detiene el proceso remoto (con la señal del canal y con el respaldo por PID).
#[tokio::test]
#[ignore]
async fn live_exec_cancel_kills_remote_process() {
    let s = session().await;
    remote_cleanup(&s).await;
    for (channel_signals, n) in [(true, 3001), (false, 3002)] {
        let token = tokio_util::sync::CancellationToken::new();
        let cmd = format!("echo empieza; sleep {n}");
        let t0 = std::time::Instant::now();
        let pattern = format!("slee[p] {n}");
        let (r, ()) = tokio::join!(
            exec::run_inner(&s, &cmd, None, 120, Some(&token), channel_signals),
            check_running_then_cancel(&s, &pattern, 1, token.clone()),
        );
        assert!(matches!(r, Err(crate::error::AppError::Canceled)), "{r:?}");
        assert!(t0.elapsed() < std::time::Duration::from_secs(8));
        assert_eq!(remote_count(&s, &pattern).await, 0, "señales del canal: {channel_signals}");
    }
}

/// Un comando que ignora TERM (y deja hijos) también se detiene: se pasa a KILL y se mata todo el grupo.
#[tokio::test]
#[ignore]
async fn live_exec_cancel_kills_term_ignoring_group() {
    let s = session().await;
    remote_cleanup(&s).await;
    for (channel_signals, n) in [(true, 3010), (false, 3020)] {
        let token = tokio_util::sync::CancellationToken::new();
        let cmd = format!("trap '' TERM; sleep {a} & sleep {b}; wait", a = n + 1, b = n + 2);
        // "slee[p] 301" cubre los dos sleep (3011 y 3012) y el bash que los lanzó.
        let pattern = format!("slee[p] {}", n / 10);
        let (r, ()) = tokio::join!(
            exec::run_inner(&s, &cmd, None, 120, Some(&token), channel_signals),
            check_running_then_cancel(&s, &pattern, 3, token.clone()),
        );
        assert!(matches!(r, Err(crate::error::AppError::Canceled)), "{r:?}");
        assert_eq!(remote_count(&s, &pattern).await, 0, "señales del canal: {channel_signals}");
    }
}

/// Al vencer el tiempo tampoco queda el proceso vivo, y la salida parcial se conserva.
#[tokio::test]
#[ignore]
async fn live_exec_timeout_kills_remote_process() {
    let s = session().await;
    remote_cleanup(&s).await;
    for (channel_signals, n) in [(true, 3031), (false, 3032)] {
        let cmd = format!("echo antes; sleep {n}");
        let r = exec::run_inner(&s, &cmd, None, 1, None, channel_signals).await.unwrap();
        assert!(r.timed_out);
        assert_eq!(r.stdout, "antes\n");
        assert!(!r.stderr.contains("__TERVIEW_PID__"));
        assert_eq!(remote_count(&s, &format!("slee[p] {n}")).await, 0, "señales del canal: {channel_signals}");
    }
}

/// El comando se sigue ejecutando con el shell de login del usuario (bash en el servidor de pruebas),
/// con su stdin, y la marca de PID no aparece en la salida.
#[tokio::test]
#[ignore]
async fn live_exec_uses_login_shell_and_hides_mark() {
    let s = session().await;
    let r = exec::run(&s, "[[ -n $BASH_VERSION ]] && echo bash; echo err >&2", 10).await.unwrap();
    assert_eq!(r.stdout, "bash\n");
    assert_eq!(r.stderr, "err\n");
    let r = exec::run_with_stdin(&s, "read -r a; echo \"$a\"", b"hola\n", 10).await.unwrap();
    assert_eq!(r.stdout, "hola\n");
    // Ya cancelado antes de empezar: no se abre canal.
    let token = tokio_util::sync::CancellationToken::new();
    token.cancel();
    let r = exec::run_cancellable(&s, "echo nunca", None, 10, &token).await;
    assert!(matches!(r, Err(crate::error::AppError::Canceled)));
}
