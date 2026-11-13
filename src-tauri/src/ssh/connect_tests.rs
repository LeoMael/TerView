//! Tests del módulo SSH contra el servidor de pruebas (127.0.0.1:2222).
//! Ejecutar: `cargo test --lib ssh -- --ignored --test-threads=1`
//! Nunca tocan el ~/.ssh/known_hosts real: cada test usa un known_hosts temporal.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::testutil::*;
use super::*;
use crate::types::HostKeyInfo;

/// Carpeta temporal que se borra al terminar.
struct TmpDir(PathBuf);
impl TmpDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("terview-ssh-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TmpDir(p)
    }
    fn kh(&self) -> PathBuf {
        self.0.join("known_hosts")
    }
}
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn pw(p: &str) -> Credentials {
    Credentials {
        password: Some(p.into()),
        ..Default::default()
    }
}

/// Ejecuta un comando y devuelve (stdout, código de salida).
pub(crate) async fn exec(session: &SshSession, cmd: &str) -> (String, Option<u32>) {
    let mut ch = session.open_channel().await.expect("canal");
    ch.exec(true, cmd).await.expect("exec");
    let mut out = Vec::new();
    let mut code = None;
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => out.extend_from_slice(&data),
            russh::ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            _ => {}
        }
    }
    (String::from_utf8_lossy(&out).into_owned(), code)
}

/// Obtiene la huella del servidor con un known_hosts vacío.
async fn server_key(kh: &Path) -> HostKeyInfo {
    match connect_with(&test_profile(), pw(TEST_PASSWORD), kh).await {
        Err(AppError::HostKeyUnknown(info)) => info,
        Err(e) => panic!("se esperaba HostKeyUnknown, llegó {e:?}"),
        Ok(_) => panic!("se esperaba HostKeyUnknown, conectó"),
    }
}

/// known_hosts temporal que ya confía en el servidor de pruebas.
async fn trusted_kh(tmp: &TmpDir) -> PathBuf {
    let kh = tmp.kh();
    let info = server_key(&kh).await;
    known_hosts::trust(&kh, &info.host, info.port, &info.key_openssh).unwrap();
    kh
}

fn ssh_keygen(path: &Path, passphrase: &str, kind: &[&str]) {
    let st = Command::new("ssh-keygen")
        .args(kind)
        .args(["-q", "-N", passphrase, "-C", "terview-test-key", "-f"])
        .arg(path)
        .status()
        .expect("ssh-keygen");
    assert!(st.success());
}

/// Añade una llave pública al authorized_keys del contenedor (como el usuario test).
fn install_pubkey(pub_path: &Path) {
    let key = std::fs::read_to_string(pub_path).unwrap();
    let mut child = Command::new("podman")
        .args([
            "exec",
            "-i",
            "-u",
            "test",
            "terview-sshd",
            "sh",
            "-c",
            "mkdir -p /config/.ssh && chmod 700 /config/.ssh && cat >> /config/.ssh/authorized_keys && chmod 600 /config/.ssh/authorized_keys",
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("podman");
    use std::io::Write;
    child.stdin.take().unwrap().write_all(key.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
}

/// Quita del authorized_keys del contenedor las llaves de estos tests.
fn uninstall_test_keys() {
    let _ = Command::new("podman")
        .args([
            "exec",
            "-u",
            "test",
            "terview-sshd",
            "sh",
            "-c",
            "f=/config/.ssh/authorized_keys; grep -v terview-test-key \"$f\" > \"$f.tmp\"; cat \"$f.tmp\" > \"$f\"; rm -f \"$f.tmp\"",
        ])
        .status();
}

fn key_profile(path: &Path) -> crate::types::ServerProfile {
    let mut p = test_profile();
    p.auth = AuthMethod::Key;
    p.key_path = Some(path.to_string_lossy().into_owned());
    p
}

#[tokio::test]
#[ignore]
async fn test_server_echo() {
    let s = connect_test_server().await;
    let (out, code) = exec(&s, "echo hola").await;
    assert_eq!(out.trim(), "hola");
    assert_eq!(code, Some(0));
}

#[tokio::test]
#[ignore]
async fn unknown_host_then_trust_then_password_ok() {
    let tmp = TmpDir::new();
    let kh = tmp.kh();
    assert!(!kh.exists());
    let info = server_key(&kh).await;
    assert_eq!(info.host, TEST_HOST);
    assert_eq!(info.port, TEST_PORT);
    assert!(info.fingerprint.starts_with("SHA256:"), "{}", info.fingerprint);
    assert!(info.key_openssh.starts_with(&info.algorithm) || info.key_openssh.starts_with("ssh-rsa"));
    // La verificación no crea el archivo.
    assert!(!kh.exists());

    known_hosts::trust(&kh, &info.host, info.port, &info.key_openssh).unwrap();
    let content = std::fs::read_to_string(&kh).unwrap();
    assert!(content.starts_with("[127.0.0.1]:2222 "), "{content}");

    let s = connect_with(&test_profile(), pw(TEST_PASSWORD), &kh).await.expect("conecta");
    assert_eq!(s.info.username, TEST_USER);
    assert_eq!(s.info.port, TEST_PORT);
    assert!(uuid::Uuid::parse_str(&s.info.id).is_ok());
    assert!(s.info.connected_at > 1_700_000_000_000);
    let (out, _) = exec(&s, "whoami").await;
    assert_eq!(out.trim(), TEST_USER);

    // Desconexión: el handle queda cerrado (lo que vigila `ssh_connect`).
    crate::ssh::disconnect_session(&s).await;
    for _ in 0..30 {
        if s.is_closed() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(s.is_closed());
}

#[tokio::test]
#[ignore]
async fn wrong_password_is_auth_failed() {
    let tmp = TmpDir::new();
    let kh = trusted_kh(&tmp).await;
    match connect_with(&test_profile(), pw("mala"), &kh).await {
        Err(AppError::AuthFailed(m)) => assert_eq!(m, WRONG_PASSWORD_MSG),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("no debía conectar"),
    }
}

#[tokio::test]
#[ignore]
async fn missing_password_needs_password() {
    let tmp = TmpDir::new();
    let r = connect_with(&test_profile(), Credentials::default(), &tmp.kh()).await;
    assert!(matches!(r, Err(AppError::NeedsPassword)), "{:?}", r.err());
}

#[tokio::test]
#[ignore]
async fn changed_key_detected_and_trust_replaces() {
    let tmp = TmpDir::new();
    let kh = tmp.kh();
    let info = server_key(&kh).await;

    // Llave falsa del mismo algoritmo.
    let kind: &[&str] = match info.algorithm.as_str() {
        "ssh-ed25519" => &["-t", "ed25519"],
        a if a.starts_with("ecdsa-sha2-nistp256") => &["-t", "ecdsa", "-b", "256"],
        a if a.starts_with("ecdsa-sha2-nistp384") => &["-t", "ecdsa", "-b", "384"],
        a if a.starts_with("ecdsa-sha2-nistp521") => &["-t", "ecdsa", "-b", "521"],
        _ => &["-t", "rsa", "-b", "2048"],
    };
    let fake = tmp.0.join("fake");
    ssh_keygen(&fake, "", kind);
    let fake_pub = std::fs::read_to_string(fake.with_extension("pub")).unwrap();
    let fake_pub = fake_pub.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let other = "otro.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    std::fs::write(
        &kh,
        format!("# mis hosts\n{other}\n[127.0.0.1]:2222\t{fake_pub}\n"),
    )
    .unwrap();

    match connect_with(&test_profile(), pw(TEST_PASSWORD), &kh).await {
        Err(AppError::HostKeyChanged(i)) => {
            assert_eq!(i.fingerprint, info.fingerprint);
            assert_eq!(i.key_openssh, info.key_openssh);
        }
        Err(e) => panic!("se esperaba HostKeyChanged: {e:?}"),
        Ok(_) => panic!("no debía conectar con la llave cambiada"),
    }

    // El usuario confirma: se reemplaza la entrada vieja y se conserva el resto.
    known_hosts::trust(&kh, TEST_HOST, TEST_PORT, &info.key_openssh).unwrap();
    let content = std::fs::read_to_string(&kh).unwrap();
    assert!(content.starts_with(&format!("# mis hosts\n{other}\n")), "{content}");
    assert_eq!(content.matches("[127.0.0.1]:2222").count(), 1, "{content}");
    assert!(!content.contains(&fake_pub), "{content}");

    let s = connect_with(&test_profile(), pw(TEST_PASSWORD), &kh).await.expect("conecta");
    crate::ssh::disconnect_session(&s).await;
}

#[tokio::test]
#[ignore]
async fn key_auth_plain_and_with_passphrase() {
    let tmp = TmpDir::new();
    let kh = trusted_kh(&tmp).await;
    uninstall_test_keys();

    // Llave sin frase.
    let k1 = tmp.0.join("id_plain");
    ssh_keygen(&k1, "", &["-t", "ed25519"]);
    // Llave con frase.
    let k2 = tmp.0.join("id_frase");
    ssh_keygen(&k2, "frase secreta", &["-t", "ed25519"]);

    // Antes de instalarla: el servidor la rechaza.
    match connect_with(&key_profile(&k1), Credentials::default(), &kh).await {
        Err(AppError::AuthFailed(m)) => assert!(m.contains("rechazó la llave"), "{m}"),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("no debía conectar"),
    }

    install_pubkey(&k1.with_extension("pub"));
    install_pubkey(&k2.with_extension("pub"));

    let s = connect_with(&key_profile(&k1), Credentials::default(), &kh)
        .await
        .expect("llave sin frase");
    let (out, _) = exec(&s, "echo llave").await;
    assert_eq!(out.trim(), "llave");
    crate::ssh::disconnect_session(&s).await;

    // Sin frase → NeedsPassphrase.
    let r = connect_with(&key_profile(&k2), Credentials::default(), &kh).await;
    assert!(matches!(r, Err(AppError::NeedsPassphrase)), "{:?}", r.err());

    // Frase incorrecta → AuthFailed(WRONG_PASSPHRASE_MSG).
    let bad = Credentials {
        passphrase: Some("otra".into()),
        ..Default::default()
    };
    match connect_with(&key_profile(&k2), bad, &kh).await {
        Err(AppError::AuthFailed(m)) => assert_eq!(m, WRONG_PASSPHRASE_MSG),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("no debía conectar"),
    }

    // Frase correcta → OK.
    let good = Credentials {
        passphrase: Some("frase secreta".into()),
        ..Default::default()
    };
    let s = connect_with(&key_profile(&k2), good, &kh).await.expect("llave con frase");
    crate::ssh::disconnect_session(&s).await;

    uninstall_test_keys();
}

/// Autenticación con agente: agente vacío, sin agente y con una llave cargada.
/// Usa un `ssh-agent` propio en un socket temporal (no toca el agente real del usuario).
#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn agent_auth() {
    struct AgentGuard(std::process::Child, Option<std::ffi::OsString>);
    impl Drop for AgentGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
            // SAFETY: tests con servidor, en un solo hilo (--test-threads=1).
            unsafe {
                match self.1.take() {
                    Some(v) => std::env::set_var("SSH_AUTH_SOCK", v),
                    None => std::env::remove_var("SSH_AUTH_SOCK"),
                }
            }
        }
    }

    let tmp = TmpDir::new();
    let kh = trusted_kh(&tmp).await;
    uninstall_test_keys();
    let mut profile = test_profile();
    profile.auth = AuthMethod::Agent;

    let sock = tmp.0.join("agent.sock");
    let child = Command::new("ssh-agent")
        .arg("-D")
        .arg("-a")
        .arg(&sock)
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("ssh-agent");
    let _guard = AgentGuard(child, std::env::var_os("SSH_AUTH_SOCK"));
    for _ in 0..50 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Socket inexistente → sin agente.
    // SAFETY: ver AgentGuard.
    unsafe { std::env::set_var("SSH_AUTH_SOCK", tmp.0.join("no-existe.sock")) };
    match connect_with(&profile, Credentials::default(), &kh).await {
        Err(AppError::AuthFailed(m)) => assert!(m.contains("no hay un agente SSH"), "{m}"),
        r => panic!("se esperaba AuthFailed, llegó {:?}", r.err()),
    }

    // Agente vacío.
    unsafe { std::env::set_var("SSH_AUTH_SOCK", &sock) };
    match connect_with(&profile, Credentials::default(), &kh).await {
        Err(AppError::AuthFailed(m)) => assert!(m.contains("no tiene llaves"), "{m}"),
        r => panic!("se esperaba AuthFailed, llegó {:?}", r.err()),
    }

    // Con la llave cargada e instalada en el servidor → conecta.
    let k = tmp.0.join("id_agente");
    ssh_keygen(&k, "", &["-t", "ed25519"]);
    let st = Command::new("ssh-add")
        .arg("-q")
        .arg(&k)
        .env("SSH_AUTH_SOCK", &sock)
        .status()
        .expect("ssh-add");
    assert!(st.success());
    install_pubkey(&k.with_extension("pub"));
    let s = connect_with(&profile, Credentials::default(), &kh).await.expect("agente");
    let (out, _) = exec(&s, "echo agente").await;
    assert_eq!(out.trim(), "agente");
    crate::ssh::disconnect_session(&s).await;

    uninstall_test_keys();
}

#[tokio::test]
#[ignore]
async fn key_file_errors() {
    let tmp = TmpDir::new();
    let missing = tmp.0.join("no-existe");
    let r = connect_with(&key_profile(&missing), Credentials::default(), &tmp.kh()).await;
    assert!(matches!(r, Err(AppError::Invalid(_))), "{:?}", r.err());

    let k = tmp.0.join("id_x");
    ssh_keygen(&k, "", &["-t", "ed25519"]);
    let r = connect_with(&key_profile(&k.with_extension("pub")), Credentials::default(), &tmp.kh()).await;
    assert!(matches!(r, Err(AppError::Invalid(ref m)) if m.contains("pública")), "{:?}", r.err());

    let mut p = test_profile();
    p.auth = AuthMethod::Key;
    p.key_path = None;
    let r = connect_with(&p, Credentials::default(), &tmp.kh()).await;
    assert!(matches!(r, Err(AppError::Invalid(_))), "{:?}", r.err());
}

#[tokio::test]
#[ignore]
async fn network_errors() {
    let tmp = TmpDir::new();
    let mut p = test_profile();
    p.port = 1; // nada escucha ahí
    match connect_with(&p, pw("x"), &tmp.kh()).await {
        Err(AppError::Network(m)) => assert!(m.contains("rechazó la conexión"), "{m}"),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("no debía conectar"),
    }
    let mut p = test_profile();
    p.host = "no-existe.invalid".into();
    match connect_with(&p, pw("x"), &tmp.kh()).await {
        Err(AppError::Network(m)) => assert!(m.contains("No se encontró"), "{m}"),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("no debía conectar"),
    }
}

#[test]
fn tilde_expansion() {
    let home = dirs::home_dir().unwrap();
    assert_eq!(expand_tilde("~/.ssh/id_ed25519"), home.join(".ssh/id_ed25519"));
    assert_eq!(expand_tilde("~"), home);
    assert_eq!(expand_tilde("/abs/key"), PathBuf::from("/abs/key"));
}

#[test]
fn prompt_classification() {
    use super::{classify_prompt, PromptKind::*};
    // Contraseña.
    assert_eq!(classify_prompt("Password: ", false), Password);
    assert_eq!(classify_prompt("(test@host) Password:", false), Password);
    assert_eq!(classify_prompt("Contraseña: ", false), Password);
    assert_eq!(classify_prompt("Password for test@example.com: ", false), Password);
    // Sin pistas: eco apagado → contraseña.
    assert_eq!(classify_prompt("Secret: ", false), Password);
    // Código de segundo factor.
    assert_eq!(classify_prompt("Verification code: ", false), Code);
    assert_eq!(classify_prompt("Código de verificación: ", false), Code);
    assert_eq!(classify_prompt("One-time password (OATH) for `test':", false), Code);
    assert_eq!(classify_prompt("Enter your OTP: ", false), Code);
    assert_eq!(classify_prompt("Token: ", true), Code);
    assert_eq!(classify_prompt("Enter PASSCODE: ", false), Code);
    assert_eq!(classify_prompt("Passcode or option (1-3): ", true), Code);
    assert_eq!(classify_prompt("Authenticator app code:", true), Code);
    // Sin pistas con eco → hay que preguntar al usuario.
    assert_eq!(classify_prompt("Choose an option: ", true), Code);
}

#[test]
fn needs_otp_prompt_text() {
    assert_eq!(super::prompt_text("  Verification code: "), "Verification code:");
    assert_eq!(super::prompt_text(""), "Código de verificación");
}

// ───────── Probar conexión (editor de servidor) ─────────

fn local_profile(port: u16) -> crate::types::ServerProfile {
    let mut p = test_profile();
    p.host = "127.0.0.1".into();
    p.port = port;
    p
}

/// Puerto local que acepta la conexión TCP pero nunca habla SSH (como un servidor colgado).
async fn silent_listener() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = l.accept().await {
            held.push(s);
        }
    });
    port
}

#[tokio::test]
async fn test_connection_port_closed() {
    // Puerto libre: se abre y se cierra para que nadie escuche en él.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let r = test_connection(&local_profile(port), pw("x"), HostKeyPolicy::AcceptAny, TEST_TIMEOUT, &cancel).await;
    match r {
        Err(AppError::Network(m)) => assert!(m.contains("rechazó"), "{m}"),
        other => panic!("se esperaba Network, llegó {other:?}"),
    }
}

#[tokio::test]
async fn test_connection_times_out() {
    let port = silent_listener().await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let t0 = std::time::Instant::now();
    let r = test_connection(
        &local_profile(port),
        pw("x"),
        HostKeyPolicy::AcceptAny,
        Duration::from_millis(300),
        &cancel,
    )
    .await;
    assert!(t0.elapsed() < Duration::from_secs(3));
    match r {
        Err(AppError::Network(m)) => assert!(m.contains("no respondió"), "{m}"),
        other => panic!("se esperaba Network por tiempo, llegó {other:?}"),
    }
}

#[tokio::test]
async fn test_connection_can_be_canceled() {
    let port = silent_listener().await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let c = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        c.cancel();
    });
    let t0 = std::time::Instant::now();
    let r = test_connection(&local_profile(port), pw("x"), HostKeyPolicy::AcceptAny, TEST_TIMEOUT, &cancel).await;
    assert!(matches!(r, Err(AppError::Canceled)), "{r:?}");
    assert!(t0.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn test_connection_requires_host_and_user() {
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut p = local_profile(22);
    p.host = "  ".into();
    let r = test_connection(&p, pw("x"), HostKeyPolicy::AcceptAny, TEST_TIMEOUT, &cancel).await;
    assert!(matches!(r, Err(AppError::Invalid(_))), "{r:?}");
    let mut p = local_profile(22);
    p.username = String::new();
    let r = test_connection(&p, pw("x"), HostKeyPolicy::AcceptAny, TEST_TIMEOUT, &cancel).await;
    assert!(matches!(r, Err(AppError::Invalid(_))), "{r:?}");
}

#[test]
fn connection_test_serializes_for_the_ui() {
    let t = ConnectionTest {
        skipped: Some(AuthSkipped::Passphrase),
        elapsed_ms: 12,
    };
    assert_eq!(
        serde_json::to_value(&t).unwrap(),
        serde_json::json!({ "skipped": "passphrase", "elapsedMs": 12 })
    );
}

#[tokio::test]
#[ignore]
async fn test_connection_against_test_server() {
    let tmp = TmpDir::new();
    let cancel = tokio_util::sync::CancellationToken::new();
    // Huella desconocida: no se acepta sola.
    let policy = HostKeyPolicy::KnownHosts(tmp.kh());
    let r = test_connection(&test_profile(), pw(TEST_PASSWORD), policy, TEST_TIMEOUT, &cancel).await;
    assert!(matches!(r, Err(AppError::HostKeyUnknown(_))), "{r:?}");
    let kh = trusted_kh(&tmp).await;
    let policy = || HostKeyPolicy::KnownHosts(kh.clone());
    // Todo correcto.
    let r = test_connection(&test_profile(), pw(TEST_PASSWORD), policy(), TEST_TIMEOUT, &cancel).await;
    assert_eq!(r.unwrap().skipped, None);
    // Contraseña incorrecta.
    let r = test_connection(&test_profile(), pw("mala"), policy(), TEST_TIMEOUT, &cancel).await;
    assert!(matches!(r, Err(AppError::AuthFailed(_))), "{r:?}");
    // Sin contraseña: solo red y huella.
    let r = test_connection(&test_profile(), Credentials::default(), policy(), TEST_TIMEOUT, &cancel).await;
    assert_eq!(r.unwrap().skipped, Some(AuthSkipped::Password));
}
