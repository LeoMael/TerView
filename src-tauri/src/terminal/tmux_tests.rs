use std::time::Duration;

use tokio::sync::mpsc;

use super::*;
use crate::terminal::shell::{spawn_terminal, ShellStart, TerminalHandle};

fn probe_of(version: &str) -> TmuxProbe {
    TmuxProbe {
        path: "/usr/bin/tmux".into(),
        version_text: version.into(),
        version: TmuxVersion::parse(version),
    }
}

/// Quita el `sh -c '…'` exterior.
fn inner(cmd: &str) -> &str {
    cmd.strip_prefix("sh -c '")
        .and_then(|c| c.strip_suffix('\''))
        .expect("formato sh -c '…'")
}

/// Comprueba la sintaxis con el `sh` local (sin ejecutar nada).
#[cfg(unix)]
fn sh_syntax_ok(script: &str) {
    let out = std::process::Command::new("sh")
        .args(["-n", "-c", script])
        .output()
        .expect("ejecutar sh");
    assert!(out.status.success(), "sintaxis: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn version_parse() {
    let v = |s| TmuxVersion::parse(s);
    assert_eq!(v("tmux 3.4"), Some(TmuxVersion { major: 3, minor: 4 }));
    assert_eq!(v("tmux 3.3a"), Some(TmuxVersion { major: 3, minor: 3 }));
    assert_eq!(v("tmux next-3.5"), Some(TmuxVersion { major: 3, minor: 5 }));
    assert_eq!(v("tmux 1.8"), Some(TmuxVersion { major: 1, minor: 8 }));
    assert_eq!(v("tmux 2"), Some(TmuxVersion { major: 2, minor: 0 }));
    assert_eq!(v("tmux master"), None);
    assert!(probe_of("tmux 1.8").supported());
    assert!(!probe_of("tmux 1.6").supported());
    // Sin número se asume una versión moderna.
    assert!(probe_of("tmux master").supported());
}

#[test]
fn names() {
    assert!(valid_name("sshorus-a1b2c3d4"));
    assert!(valid_name("sshorus-x_y-z"));
    assert!(!valid_name("sshorus-"));
    assert!(!valid_name("otra-a1b2"));
    assert!(!valid_name("sshorus-a b"));
    assert!(!valid_name("sshorus-a;rm"));
    assert!(!valid_name("sshorus-a'b"));
    assert!(!valid_name("sshorus-a:b"));
    assert!(!valid_name(&format!("sshorus-{}", "a".repeat(60))));
}

#[test]
fn probe_output() {
    assert_eq!(parse_probe("tv_tmux=0\n"), Some(ProbeResult::NotInstalled));
    assert_eq!(parse_probe("basura\n"), None);
    let r = parse_probe("tv_tmux=1\r\ntv_path=/usr/bin/tmux\r\ntv_version=tmux 3.4\r\n");
    assert_eq!(r, Some(ProbeResult::Found(probe_of("tmux 3.4"))));
    // Una ruta con caracteres raros no se usa.
    assert_eq!(
        parse_probe("tv_tmux=1\ntv_path=/opt/my tmux/tmux\ntv_version=tmux 3.4\n"),
        Some(ProbeResult::NotInstalled)
    );
}

#[test]
fn scripts_have_no_forbidden_chars() {
    let attach = attach_command(&probe_of("tmux 3.4"), "sshorus-abc", 30, true).unwrap();
    let kill = kill_command(&["sshorus-a".into(), "sshorus-b".into()]).unwrap();
    for cmd in [probe_command(), list_command(), attach, kill] {
        let body = inner(&cmd);
        assert!(!body.contains('\''), "comilla simple en: {body}");
        assert!(!body.contains('!'), "«!» en: {body}");
        assert!(!body.contains('\n'), "salto de línea en: {body}");
        #[cfg(unix)]
        sh_syntax_ok(body);
    }
}

#[test]
fn attach_command_content() {
    let cmd = attach_command(&probe_of("tmux 3.4"), "sshorus-abc", 3, false).unwrap();
    assert!(cmd.contains("-L sshorus"));
    assert!(cmd.contains("-f /dev/null start-server"));
    assert!(cmd.contains("new-session -A -s \"$s\""));
    assert!(cmd.contains("set -g status off"));
    assert!(cmd.contains("smcup@:rmcup@"));
    assert!(cmd.contains("window-size latest"));
    assert!(cmd.contains("hyperlinks"));
    assert!(!cmd.contains("capture-pane"), "sin replay no se vuelca historial");

    let replay = attach_command(&probe_of("tmux 3.4"), "sshorus-abc", 3, true).unwrap();
    assert!(replay.contains("capture-pane -p -e -J -S -10000 -E -1"));
    assert!(replay.contains("printf \"\\n\\n\\n\""), "{replay}");

    // Versiones viejas: sin opciones que no conocen.
    let old = attach_command(&probe_of("tmux 2.6"), "sshorus-abc", 3, false).unwrap();
    assert!(!old.contains("window-size"));
    assert!(!old.contains("terminal-features"));
    assert!(old.contains("aggressive-resize on"));

    assert!(attach_command(&probe_of("tmux 3.4"), "sshorus-a;b", 3, false).is_err());
    let mut bad = probe_of("tmux 3.4");
    bad.path = "/tmp/x\"y".into();
    assert!(attach_command(&bad, "sshorus-abc", 3, false).is_err());
}

#[test]
fn list_output() {
    let out = "tv_tmux=1\n\
               tv_version=tmux 3.4\n\
               tv_s=sshorus-aaa|100|150|0|1|bash|/home/u\n\
               tv_s=sshorus-bbb|200|300|1|2|vim|/srv/a|b\n\
               tv_s=otra|1|1|0|1|bash|/\n\
               tv_s=sshorus-roto|1\n\
               tv_end=1\n";
    let l = parse_list(out);
    assert!(l.installed);
    assert_eq!(l.version.as_deref(), Some("tmux 3.4"));
    assert_eq!(l.sessions.len(), 2);
    // Más recientes primero; la ruta puede tener «|».
    assert_eq!(l.sessions[0].name, "sshorus-bbb");
    assert_eq!(l.sessions[0].path, "/srv/a|b");
    assert_eq!(l.sessions[0].attached, 1);
    assert_eq!(l.sessions[0].command, "vim");
    assert_eq!(l.sessions[1].created, Some(100));

    let none = parse_list("tv_tmux=0\n");
    assert!(!none.installed);
    assert!(none.sessions.is_empty());
}

#[test]
fn kill_validates() {
    assert!(kill_command(&[]).is_err());
    assert!(kill_command(&["sshorus-a".into(), "x; reboot".into()]).is_err());
    let k = kill_command(&["sshorus-a".into()]).unwrap();
    assert!(k.contains("kill-session -t \"$s\""));
}

// ───────── Con el servidor de pruebas (tmux instalado en terview-sshd) ─────────

async fn read_until(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, acc: &mut String, needle: &str) -> bool {
    let fut = async {
        while !acc.contains(needle) {
            match rx.recv().await {
                Some(d) => acc.push_str(&String::from_utf8_lossy(&d)),
                None => return false,
            }
        }
        true
    };
    tokio::time::timeout(Duration::from_secs(15), fut).await.unwrap_or(false)
}

async fn open_tmux(
    session: Arc<SshSession>,
    probe: &TmuxProbe,
    name: &str,
    replay: bool,
) -> (TerminalHandle, mpsc::UnboundedReceiver<Vec<u8>>) {
    let cmd = attach_command(probe, name, 24, replay).unwrap();
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let h = spawn_terminal(
        session,
        ShellStart::Exec(cmd),
        100,
        24,
        move |d| {
            let _ = tx.send(d);
        },
        |_| {},
    )
    .await
    .expect("abrir terminal tmux");
    (h, rx)
}

async fn found(session: &SshSession) -> TmuxProbe {
    match probe(session).await.expect("comprobar tmux") {
        ProbeResult::Found(p) => p,
        ProbeResult::NotInstalled => {
            panic!("instala tmux en el contenedor: podman exec terview-sshd apk add tmux")
        }
    }
}

/// Crea la sesión, corta la conexión con un proceso en marcha y vuelve a engancharse desde otra
/// conexión: el proceso sigue vivo, la shell es la misma y el historial se vuelca.
#[tokio::test]
#[ignore]
async fn survives_disconnect_and_reattaches() {
    use crate::ssh::connect::testutil::connect_test_server;
    let name = format!("sshorus-t{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);

    let s1 = connect_test_server().await;
    let p = found(&s1).await;
    let (h1, mut rx1) = open_tmux(s1.clone(), &p, &name, false).await;
    let mut out = String::new();
    h1.write(b"TV_MARK=marca-$((6*7)); seq 1 80 | sed s/^/fila-/; echo term=$TERM; echo listo-$((1+1))\n".to_vec())
        .unwrap();
    assert!(read_until(&mut rx1, &mut out, "listo-2").await, "salida: {out:?}");
    assert!(out.contains("term=tmux-256color") || out.contains("term=screen-256color"), "{out:?}");
    // Sin pantalla alternativa hacia xterm.js (si no, se perderían el historial y la búsqueda).
    assert!(!out.contains("\x1b[?1049h") && !out.contains("\x1b[?47h"), "{out:?}");
    // Sin barra de estado y con UTF-8 aunque el canal no tenga LANG.
    h1.write("printf \"%s-%s\\n\" ñandú $((3+4))\n".as_bytes().to_vec()).unwrap();
    assert!(read_until(&mut rx1, &mut out, "ñandú-7").await, "salida: {out:?}");
    // Un proceso en primer plano que debe sobrevivir al corte.
    h1.write(b"sleep 7777\n".to_vec()).unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Cortar la conexión (sin cerrar la terminal a propósito).
    let _ = s1
        .handle
        .disconnect(russh::Disconnect::ByApplication, "corte", "es")
        .await;
    drop(h1);
    drop(s1);
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Otra conexión: la sesión sigue ahí, con `sleep` en primer plano.
    let s2 = connect_test_server().await;
    let l = list(s2.clone()).await.expect("listar");
    let sess = l.sessions.iter().find(|s| s.name == name).expect("la sesión sigue viva");
    assert_eq!(sess.command, "sleep", "{sess:?}");
    let ps = exec::run(&s2, "ps -ef 2>/dev/null || ps", 5).await.unwrap();
    assert!(ps.stdout.contains("sleep 7777"), "{}", ps.stdout);

    // Engancharse con volcado de historial: llegan filas viejas y la misma shell.
    let (h2, mut rx2) = open_tmux(s2.clone(), &p, &name, true).await;
    let mut out2 = String::new();
    assert!(read_until(&mut rx2, &mut out2, "fila-5\r\n").await, "historial: {out2:?}");
    h2.write(b"\x03".to_vec()).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    h2.write(b"echo \"valor=$TV_MARK\"\n".to_vec()).unwrap();
    assert!(read_until(&mut rx2, &mut out2, "valor=marca-42").await, "salida: {out2:?}");

    // Configuración propia aplicada (y sin tocar ~/.tmux.conf).
    let st = exec::run(&s2, &format!("{} -L sshorus show -g status", p.path), 5).await.unwrap();
    assert!(st.stdout.contains("status off"), "{}", st.stdout);

    // Cerrar a propósito: se mata la sesión.
    kill(s2.clone(), std::slice::from_ref(&name)).await.expect("cerrar sesión");
    let l = list(s2.clone()).await.expect("listar");
    assert!(l.sessions.iter().all(|s| s.name != name));
    h2.close();
}

/// Dos terminales de la misma conexión son sesiones distintas.
#[tokio::test]
#[ignore]
async fn two_terminals_two_sessions() {
    use crate::ssh::connect::testutil::connect_test_server;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let a = format!("sshorus-a{}", &id[..8]);
    let b = format!("sshorus-b{}", &id[..8]);
    let s = connect_test_server().await;
    let p = found(&s).await;
    let (ha, mut rxa) = open_tmux(s.clone(), &p, &a, false).await;
    let (hb, mut rxb) = open_tmux(s.clone(), &p, &b, false).await;
    let (mut oa, mut ob) = (String::new(), String::new());
    ha.write(b"echo uno-$((0+1))\n".to_vec()).unwrap();
    hb.write(b"echo dos-$((1+1))\n".to_vec()).unwrap();
    assert!(read_until(&mut rxa, &mut oa, "uno-1").await, "{oa:?}");
    assert!(read_until(&mut rxb, &mut ob, "dos-2").await, "{ob:?}");
    assert!(!oa.contains("dos-2"));
    let l = list(s.clone()).await.unwrap();
    for n in [&a, &b] {
        let x = l.sessions.iter().find(|x| &x.name == n).expect("sesión listada");
        assert_eq!(x.attached, 1);
    }
    kill(s.clone(), &[a.clone(), b.clone()]).await.unwrap();
    // Al matar la sesión, el cliente tmux termina y la terminal también.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(ha.is_finished() && hb.is_finished());
}
