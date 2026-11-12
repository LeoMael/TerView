//! Tests de túneles. Los `#[ignore]` usan el servidor de pruebas (127.0.0.1:2222) y necesitan
//! `AllowTcpForwarding yes` en su sshd_config.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::manager::{Sessions, TunnelManager};
use super::store::{DefStore, normalize};
use super::types::{TunnelDef, TunnelKind, TunnelState};
use crate::ssh::connect::testutil::{connect_test_server, test_profile};
use crate::ssh::{SessionStore, SshSession, disconnect_session};

fn temp_file() -> std::path::PathBuf {
    std::env::temp_dir()
        .join(format!("terview-tunnels-{}", uuid::Uuid::new_v4()))
        .join("tunnels.json")
}

fn def(kind: TunnelKind, bind_port: u16, dest_host: &str, dest_port: u16) -> TunnelDef {
    TunnelDef {
        id: String::new(),
        profile_id: test_profile().id,
        name: String::new(),
        kind,
        bind_host: "127.0.0.1".into(),
        bind_port,
        dest_host: dest_host.into(),
        dest_port,
        auto_start: false,
    }
}

struct Ctx {
    manager: TunnelManager,
    store: Arc<SessionStore>,
    env: Sessions,
    session: Arc<SshSession>,
}

async fn setup() -> Ctx {
    let store = Arc::new(SessionStore::default());
    let session = connect_test_server().await;
    store.insert(session.clone()).await;
    Ctx {
        manager: TunnelManager::with_store(DefStore::load_from(temp_file())),
        env: Sessions::Direct(store.clone()),
        store,
        session,
    }
}

/// Lee hasta encontrar `needle` (o fallar a los 5 s).
async fn read_until(s: &mut TcpStream, needle: &str) -> String {
    let mut buf = Vec::new();
    let res = tokio::time::timeout(Duration::from_secs(5), async {
        let mut chunk = [0u8; 1024];
        loop {
            let n = s.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if String::from_utf8_lossy(&buf).contains(needle) {
                break;
            }
        }
    })
    .await;
    assert!(res.is_ok(), "tiempo agotado esperando «{needle}»");
    String::from_utf8_lossy(&buf).into_owned()
}

/// Ejecuta un comando en el servidor y devuelve su salida estándar.
async fn exec(session: &SshSession, cmd: &str) -> String {
    let mut ch = session.open_channel().await.expect("canal");
    ch.exec(true, cmd.as_bytes()).await.expect("exec");
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = ch.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => out.extend_from_slice(&data),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;
    String::from_utf8_lossy(&out).into_owned()
}

#[test]
fn normalize_rellena_y_valida() {
    let t = normalize(def(TunnelKind::Local, 5432, "", 5432)).expect("válido");
    assert_eq!(t.dest_host, "127.0.0.1");
    assert_eq!(t.name, "Local 5432");
    assert!(normalize(def(TunnelKind::Local, 5432, "db", 0)).is_err());
    let mut s = def(TunnelKind::Socks, 1080, "x", 9);
    s.bind_host = String::new();
    let s = normalize(s).expect("válido");
    assert_eq!((s.bind_host.as_str(), s.dest_port), ("127.0.0.1", 0));
    let mut bad = def(TunnelKind::Remote, 80, "127.0.0.1", 80);
    bad.bind_host = "mal host".into();
    assert!(normalize(bad).is_err());
}

#[test]
fn guardar_y_releer() {
    let path = temp_file();
    let store = DefStore::load_from(&path);
    let saved = store
        .save(def(TunnelKind::Local, 5432, "db", 5432))
        .expect("guardar");
    assert!(!saved.id.is_empty());
    let again = DefStore::load_from(&path);
    assert_eq!(again.list(&saved.profile_id), vec![saved.clone()]);
    again.delete(&saved.id).expect("borrar");
    assert!(
        DefStore::load_from(&path)
            .list(&saved.profile_id)
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(path.parent().expect("carpeta"));
}

#[tokio::test]
#[ignore]
async fn local_lee_banner_ssh() {
    let c = setup().await;
    let d = c
        .manager
        .defs
        .save(def(TunnelKind::Local, 0, "127.0.0.1", 2222))
        .expect("guardar");
    let sid = c.session.info.id.clone();
    let st = c.manager.start(&c.env, &sid, &d.id).await.expect("activar");
    assert_eq!(st.state, TunnelState::Active);
    let port = st.bound_port.expect("puerto");

    let mut s = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("conectar al túnel");
    let banner = read_until(&mut s, "SSH-2.0").await;
    assert!(banner.starts_with("SSH-2.0"), "banner: {banner}");
    drop(s);

    // Puerto ocupado → error claro.
    let mut busy = d.clone();
    busy.id = String::new();
    busy.bind_port = port;
    let busy = c.manager.defs.save(busy).expect("guardar");
    let err = c
        .manager
        .start(&c.env, &sid, &busy.id)
        .await
        .expect_err("debe fallar");
    assert_eq!(
        err.to_string(),
        format!("El puerto {port} ya está en uso en tu PC")
    );

    tokio::time::sleep(Duration::from_millis(200)).await;
    let st = c
        .manager
        .statuses(&sid)
        .into_iter()
        .find(|s| s.tunnel_id == d.id)
        .expect("estado");
    assert!(st.bytes_down >= 7 && st.total_connections == 1, "{st:?}");

    c.manager.stop(&c.env, &sid, &d.id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        TcpStream::connect(("127.0.0.1", port)).await.is_err(),
        "el puerto debe cerrarse"
    );

    // Al quitar la sesión, el vigilante para lo que quede.
    c.store.remove(&sid).await;
    c.manager.tick(&c.env).await;
    assert!(c.manager.statuses(&sid).is_empty());
    disconnect_session(&c.session).await;
}

async fn socks_connect(port: u16, addr: &[u8], dport: u16) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("conectar al SOCKS");
    s.write_all(&[5, 1, 0]).await.expect("saludo");
    let mut r = [0u8; 2];
    s.read_exact(&mut r).await.expect("respuesta saludo");
    assert_eq!(r, [5, 0]);
    let mut req = vec![5, 1, 0];
    req.extend_from_slice(addr);
    req.extend_from_slice(&dport.to_be_bytes());
    s.write_all(&req).await.expect("petición");
    let mut rep = [0u8; 10];
    s.read_exact(&mut rep).await.expect("respuesta petición");
    assert_eq!(rep[1], 0, "SOCKS REP={}", rep[1]);
    s
}

#[tokio::test]
#[ignore]
async fn socks_dominio_e_ipv4() {
    let c = setup().await;
    let d = c
        .manager
        .defs
        .save(def(TunnelKind::Socks, 0, "", 0))
        .expect("guardar");
    let sid = c.session.info.id.clone();
    let st = c.manager.start(&c.env, &sid, &d.id).await.expect("activar");
    let port = st.bound_port.expect("puerto");

    let mut domain = vec![3, 9];
    domain.extend_from_slice(b"localhost");
    let mut s = socks_connect(port, &domain, 2222).await;
    assert!(read_until(&mut s, "SSH-2.0").await.starts_with("SSH-2.0"));

    let mut s = socks_connect(port, &[1, 127, 0, 0, 1], 2222).await;
    assert!(read_until(&mut s, "SSH-2.0").await.starts_with("SSH-2.0"));

    // Destino cerrado → REP de error, no se cuelga.
    let mut s = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("conectar");
    s.write_all(&[5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 1])
        .await
        .expect("petición");
    let mut rep = [0u8; 12];
    s.read_exact(&mut rep).await.expect("respuesta");
    assert_ne!(rep[3], 0, "debe fallar hacia el puerto 1");

    c.manager.stop(&c.env, &sid, &d.id).await;
    disconnect_session(&c.session).await;
}

#[tokio::test]
#[ignore]
async fn remoto_y_reconexion() {
    let c = setup().await;
    // Servicio "en tu PC" que saluda y cierra.
    let local = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("escucha local");
    let lport = local.local_addr().expect("addr").port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = local.accept().await {
            let _ = s.write_all(b"hola-terview\n").await;
        }
    });
    let mut d = def(TunnelKind::Remote, 0, "127.0.0.1", lport);
    d.bind_host = "127.0.0.1".into();
    let d = c.manager.defs.save(d).expect("guardar");
    let sid = c.session.info.id.clone();
    let st = c.manager.start(&c.env, &sid, &d.id).await.expect("activar");
    assert_eq!(st.state, TunnelState::Active);
    let rport = st.bound_port.expect("puerto remoto");
    assert_ne!(rport, 0);

    let cmd = format!("sleep 2 | nc 127.0.0.1 {rport}");
    let out = exec(&c.session, &cmd).await;
    assert!(out.contains("hola-terview"), "salida: {out:?}");

    // Reconexión simulada: se cae la conexión y el mismo sessionId pasa a una nueva.
    disconnect_session(&c.session).await;
    c.store.set_reconnecting(&sid, true).await;
    c.manager.tick(&c.env).await;
    let st = c.manager.statuses(&sid).pop().expect("estado");
    assert_eq!(st.state, TunnelState::Waiting);

    let mut fresh = connect_test_server().await;
    if let Some(s) = Arc::get_mut(&mut fresh) {
        s.info.id = sid.clone();
    }
    assert!(c.store.replace(&sid, fresh.clone()).await);
    let mut active = false;
    for _ in 0..15 {
        c.manager.tick(&c.env).await;
        let st = c.manager.statuses(&sid).pop().expect("estado");
        if st.state == TunnelState::Active {
            assert_eq!(st.bound_port, Some(rport), "debe reabrir el mismo puerto");
            active = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(active, "el túnel remoto no se reabrió tras reconectar");
    let out = exec(&fresh, &cmd).await;
    assert!(
        out.contains("hola-terview"),
        "salida tras reconectar: {out:?}"
    );

    c.manager.stop(&c.env, &sid, &d.id).await;
    let out = exec(
        &fresh,
        &format!("nc -z -w 2 127.0.0.1 {rport} && echo abierto || echo cerrado"),
    )
    .await;
    assert!(
        out.contains("cerrado"),
        "el puerto remoto debe cerrarse: {out:?}"
    );
    disconnect_session(&fresh).await;
}

#[tokio::test]
#[ignore]
async fn arranque_automatico() {
    let c = setup().await;
    let mut d = def(TunnelKind::Local, 0, "127.0.0.1", 2222);
    d.auto_start = true;
    let d = c.manager.defs.save(d).expect("guardar");
    let sid = c.session.info.id.clone();
    c.manager.tick(&c.env).await;
    let st = c
        .manager
        .statuses(&sid)
        .pop()
        .expect("debe haber arrancado");
    assert_eq!(
        (st.tunnel_id.as_str(), st.state),
        (d.id.as_str(), TunnelState::Active)
    );
    c.manager.stop(&c.env, &sid, &d.id).await;
    // Ya vista: no se vuelve a arrancar sola.
    c.manager.tick(&c.env).await;
    assert!(c.manager.statuses(&sid).is_empty());
    disconnect_session(&c.session).await;
}
