//! Tests de la reconexión contra el servidor de pruebas (127.0.0.1:2222).
//! Ejecutar: `cargo test --lib ssh::reconnect -- --ignored --test-threads=1`
//!
//! Para tirar la conexión sin molestar a otras sesiones del servidor, se mata solo el proceso
//! `sshd-session` de NUESTRA conexión (`kill -9 $PPID` desde un canal exec).
//! El test que detiene/reinicia el contenedor solo corre con `TERVIEW_PODMAN_TESTS=1`
//! (corta a cualquier otro que esté usando el servidor) y siempre lo vuelve a arrancar.

use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::ssh::connect::testutil::{test_creds, test_profile};

#[derive(Debug, Clone)]
enum Ev {
    Reconnecting(SessionReconnecting),
    Reconnected(SessionInfo),
    Closed(SessionClosed),
    Dropped,
    ReleasedAll,
    Resumed,
}

struct TestEnv {
    store: SessionStore,
    settings: Mutex<ReconnectSettings>,
    events: Mutex<Vec<Ev>>,
    /// Cuántas lecturas del secreto guardado responden «bloqueado» antes de dar `secret`.
    locked_reads: AtomicU32,
    secret: Mutex<Option<String>>,
}

impl TestEnv {
    fn new(auto_reconnect: bool, attempts: u8) -> Arc<Self> {
        Arc::new(Self {
            store: SessionStore::default(),
            settings: Mutex::new(ReconnectSettings {
                auto_reconnect,
                attempts,
                keepalive_secs: 5,
            }),
            events: Mutex::new(Vec::new()),
            locked_reads: AtomicU32::new(0),
            secret: Mutex::new(None),
        })
    }
    fn push(&self, e: Ev) {
        self.events.lock().unwrap().push(e);
    }
    fn events(&self) -> Vec<Ev> {
        self.events.lock().unwrap().clone()
    }
    fn reconnecting(&self) -> Vec<SessionReconnecting> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Ev::Reconnecting(r) => Some(r),
                _ => None,
            })
            .collect()
    }
    fn reconnected(&self) -> Vec<SessionInfo> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Ev::Reconnected(i) => Some(i),
                _ => None,
            })
            .collect()
    }
    fn closed(&self) -> Vec<SessionClosed> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Ev::Closed(c) => Some(c),
                _ => None,
            })
            .collect()
    }
}

impl ReconnectEnv for TestEnv {
    fn sessions(&self) -> &SessionStore {
        &self.store
    }
    fn settings(&self) -> ReconnectSettings {
        *self.settings.lock().unwrap()
    }
    fn emit_reconnecting(&self, ev: SessionReconnecting) {
        self.push(Ev::Reconnecting(ev));
    }
    fn emit_reconnected(&self, info: SessionInfo) {
        self.push(Ev::Reconnected(info));
    }
    fn emit_closed(&self, ev: SessionClosed) {
        self.push(Ev::Closed(ev));
    }
    fn release_dropped(&self, _: &str) {
        self.push(Ev::Dropped);
    }
    fn release_all(&self, _: &str) {
        self.push(Ev::ReleasedAll);
    }
    fn resume(&self, _: &str) {
        self.push(Ev::Resumed);
    }
    fn stored_secret(&self, _: &str) -> BoxFuture<'static, Result<Option<String>, AppError>> {
        let locked = self
            .locked_reads
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok();
        let r = if locked {
            Err(AppError::Locked)
        } else {
            Ok(self.secret.lock().unwrap().clone())
        };
        Box::pin(async move { r })
    }
}

async fn exec(session: &SshSession, cmd: &str) -> (String, Option<u32>) {
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

fn fast_timing(backoff_ms: u64) -> Timing {
    Timing {
        watch_interval: Duration::from_millis(200),
        backoff: vec![Duration::from_millis(backoff_ms)],
    }
}

/// Conecta al servidor de pruebas, registra la sesión y lanza el vigilante.
/// `reconnect_port`: puerto al que irán los reintentos (1 = nada escucha → fallan).
async fn start(
    env: &Arc<TestEnv>,
    timing: Timing,
    reconnect_port: Option<u16>,
    policy: HostKeyPolicy,
) -> (Arc<SshSession>, tokio::task::JoinHandle<()>) {
    let (session, shared) = connect::connect_full(
        &test_profile(),
        test_creds(),
        HostKeyPolicy::AcceptAny,
        connect::keepalive_interval(5),
    )
    .await
    .expect("conecta");
    let session = Arc::new(session);
    env.store.insert(session.clone()).await;
    let mut profile = test_profile();
    if let Some(p) = reconnect_port {
        profile.port = p;
    }
    let sup = Supervised {
        profile,
        creds: test_creds(),
        stored_secret: false,
        policy,
        session: session.clone(),
        shared,
    };
    let task = tokio::spawn(supervise(env.clone(), sup, timing));
    (session, task)
}

/// Tira SOLO esta conexión: mata su proceso sshd-session en el servidor.
async fn kill_connection(s: &SshSession) {
    let ch = s.open_channel().await.expect("canal");
    ch.exec(false, "kill -9 $PPID").await.expect("exec");
    for _ in 0..100 {
        if s.is_closed() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("la conexión no se cayó tras matar sshd-session");
}

async fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = tokio::time::Instant::now() + Duration::from_secs(secs);
    while tokio::time::Instant::now() < end {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("tiempo agotado esperando: {what}");
}

async fn finish(env: &Arc<TestEnv>, id: &str, task: tokio::task::JoinHandle<()>) {
    if let Some(s) = env.store.remove(id).await {
        disconnect_session(&s).await;
    }
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("el vigilante debe terminar al quitar la sesión")
        .expect("tarea");
}

#[test]
fn backoff_schedule() {
    let t = Timing::default();
    let secs: Vec<u64> = (1..=7).map(|a| t.backoff(a).as_secs()).collect();
    assert_eq!(secs, vec![1, 2, 5, 10, 30, 30, 30]);
}

#[test]
fn settings_are_clamped() {
    let s = crate::types::Settings {
        reconnect_attempts: 0,
        ..Default::default()
    };
    assert_eq!(ReconnectSettings::from(&s).attempts, 1);
    let s = crate::types::Settings {
        reconnect_attempts: 99,
        ..Default::default()
    };
    assert_eq!(ReconnectSettings::from(&s).attempts, 20);
    assert_eq!(connect::keepalive_interval(1), Duration::from_secs(5));
    assert_eq!(connect::keepalive_interval(30), Duration::from_secs(30));
    assert_eq!(connect::keepalive_interval(999), Duration::from_secs(120));
}

#[tokio::test]
#[ignore]
async fn reconnects_with_same_id() {
    let env = TestEnv::new(true, 5);
    let (old, task) = start(&env, fast_timing(300), None, HostKeyPolicy::AcceptAny).await;
    let id = old.info.id.clone();

    // Mientras reconecta, `get` falla rápido.
    assert!(env.store.set_reconnecting(&id, true).await);
    assert!(matches!(env.store.get(&id).await, Err(AppError::SessionNotFound(_))));
    assert!(env.store.list().await.is_empty());
    assert!(env.store.set_reconnecting(&id, false).await);
    assert!(env.store.get(&id).await.is_ok());

    kill_connection(&old).await;
    wait_until("reconexión", 30, || !env.reconnected().is_empty()).await;

    let info = &env.reconnected()[0];
    assert_eq!(info.id, id, "mismo sessionId");
    let r = env.reconnecting();
    assert_eq!(r.len(), 1, "{r:?}");
    assert_eq!((r[0].attempt, r[0].max_attempts), (1, 5));
    assert!(!r[0].reason.is_empty());
    let kinds: Vec<&'static str> = env
        .events()
        .iter()
        .map(|e| match e {
            Ev::Dropped => "dropped",
            Ev::Reconnecting(_) => "reconnecting",
            Ev::Resumed => "resumed",
            Ev::Reconnected(_) => "reconnected",
            Ev::Closed(_) => "closed",
            Ev::ReleasedAll => "released",
        })
        .collect();
    assert_eq!(kinds, ["dropped", "reconnecting", "resumed", "reconnected"]);

    let new = env.store.get(&id).await.expect("sesión reemplazada");
    assert!(!Arc::ptr_eq(&new, &old));
    assert_eq!(new.info.id, id);
    let (out, _) = exec(&new, "echo de-vuelta").await;
    assert_eq!(out.trim(), "de-vuelta");

    // Sigue vigilando la conexión nueva: una segunda caída también se recupera.
    kill_connection(&new).await;
    wait_until("segunda reconexión", 30, || env.reconnected().len() == 2).await;
    assert!(env.closed().is_empty());

    finish(&env, &id, task).await;
}

#[tokio::test]
#[ignore]
async fn gives_up_after_n_attempts() {
    let env = TestEnv::new(true, 3);
    // Los reintentos van a un puerto donde nada escucha.
    let (s, task) = start(&env, fast_timing(200), Some(1), HostKeyPolicy::AcceptAny).await;
    let id = s.info.id.clone();
    kill_connection(&s).await;
    wait_until("abandono", 30, || !env.closed().is_empty()).await;
    tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();

    let attempts: Vec<u8> = env.reconnecting().iter().map(|r| r.attempt).collect();
    assert_eq!(attempts, [1, 2, 3]);
    assert!(env.reconnecting()[1].reason.starts_with("Intento 1 fallido"), "{:?}", env.reconnecting());
    let c = &env.closed()[0];
    assert_eq!(c.session_id, id);
    assert!(c.reason.starts_with("No se pudo reconectar tras 3 intentos:"), "{}", c.reason);
    assert!(matches!(env.events().last(), Some(Ev::Closed(_))));
    assert!(env.events().iter().any(|e| matches!(e, Ev::ReleasedAll)));
    assert!(env.reconnected().is_empty());
    assert!(env.store.remove(&id).await.is_none());
}

#[tokio::test]
#[ignore]
async fn disconnect_cancels_reconnect_silently() {
    let env = TestEnv::new(true, 5);
    let (s, task) = start(&env, fast_timing(2000), Some(1), HostKeyPolicy::AcceptAny).await;
    let id = s.info.id.clone();
    kill_connection(&s).await;
    wait_until("primer intento", 10, || !env.reconnecting().is_empty()).await;

    // Lo que hace `ssh_disconnect`.
    let n = env.events().len();
    assert!(env.store.remove(&id).await.is_some());
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("el bucle debe cancelarse en seguida")
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(env.events().len(), n, "sin eventos tras desconectar: {:?}", env.events());
}

#[tokio::test]
#[ignore]
async fn auto_reconnect_off_closes() {
    let env = TestEnv::new(false, 5);
    let (s, task) = start(&env, fast_timing(200), None, HostKeyPolicy::AcceptAny).await;
    kill_connection(&s).await;
    wait_until("cierre", 10, || !env.closed().is_empty()).await;
    tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    assert!(env.reconnecting().is_empty());
    assert!(!env.closed()[0].reason.starts_with("No se pudo reconectar"));
}

#[tokio::test]
#[ignore]
async fn changed_host_key_stops_retrying() {
    let dir = std::env::temp_dir().join(format!("terview-reconnect-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let kh = dir.join("known_hosts");
    // Llave que NO es la del servidor.
    std::fs::write(
        &kh,
        "[127.0.0.1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n",
    )
    .unwrap();
    let env = TestEnv::new(true, 5);
    let (s, task) = start(&env, fast_timing(200), None, HostKeyPolicy::KnownHosts(kh)).await;
    kill_connection(&s).await;
    wait_until("abandono", 15, || !env.closed().is_empty()).await;
    tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(env.reconnecting().len(), 1, "no reintenta tras un error de huella");
    let reason = &env.closed()[0].reason;
    assert!(reason.starts_with("No se pudo reconectar:"), "{reason}");
    assert!(reason.contains("huella") || reason.contains("known_hosts"), "{reason}");
}

// ───────────── Con el contenedor (solo con TERVIEW_PODMAN_TESTS=1) ─────────────

fn podman(args: &[&str]) -> bool {
    Command::new("podman")
        .args(args)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Vuelve a arrancar el contenedor al salir, pase lo que pase.
struct StartOnDrop;
impl Drop for StartOnDrop {
    fn drop(&mut self) {
        let _ = podman(&["start", "terview-sshd"]);
    }
}

async fn wait_server_up() {
    for _ in 0..60 {
        if connect::connect_policy(&test_profile(), test_creds(), HostKeyPolicy::AcceptAny)
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("el servidor de pruebas no volvió");
}

#[tokio::test]
#[ignore]
async fn container_restart_and_stop() {
    if std::env::var("TERVIEW_PODMAN_TESTS").ok().as_deref() != Some("1") {
        eprintln!("omitido: define TERVIEW_PODMAN_TESTS=1 (reinicia el contenedor de pruebas)");
        return;
    }
    let _guard = StartOnDrop;

    // Reinicio del contenedor → reconecta con el mismo id.
    let env = TestEnv::new(true, 20);
    let (s, task) = start(&env, fast_timing(1000), None, HostKeyPolicy::AcceptAny).await;
    let id = s.info.id.clone();
    assert!(podman(&["restart", "-t", "1", "terview-sshd"]));
    wait_until("reconexión tras reinicio", 60, || !env.reconnected().is_empty()).await;
    assert_eq!(env.reconnected()[0].id, id);
    assert!(env.closed().is_empty());
    finish(&env, &id, task).await;

    // Contenedor detenido → abandona tras N intentos.
    let env = TestEnv::new(true, 3);
    let (s, task) = start(&env, fast_timing(300), None, HostKeyPolicy::AcceptAny).await;
    let id = s.info.id.clone();
    assert!(podman(&["stop", "-t", "1", "terview-sshd"]));
    wait_until("abandono con el contenedor parado", 60, || !env.closed().is_empty()).await;
    tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    assert!(podman(&["start", "terview-sshd"]));
    let c = &env.closed()[0];
    assert_eq!(c.session_id, id);
    assert!(c.reason.starts_with("No se pudo reconectar tras 3 intentos:"), "{}", c.reason);
    assert_eq!(env.reconnecting().len(), 3);
    wait_server_up().await;
}

// ───────── Contraseña guardada en la bóveda (sin servidor) ─────────

/// Sin secreto en la bóveda: se usan las credenciales tal cual, sin preguntar nada.
#[tokio::test]
async fn creds_without_stored_secret_are_used_as_is() {
    let env = TestEnv::new(true, 3);
    let base = test_creds();
    let cancel = CancellationToken::new();
    let c = creds_for_attempt(&*env, &test_profile(), &base, false, "s1", 1, 3, &cancel)
        .await
        .ok()
        .expect("credenciales");
    assert_eq!(c.password, base.password);
    assert!(env.reconnecting().is_empty());
}

/// Bloqueado: espera (avisando una vez con `waiting_unlock`) y al desbloquear usa el secreto.
#[tokio::test]
async fn creds_wait_for_unlock_then_use_stored_secret() {
    let env = TestEnv::new(true, 3);
    env.locked_reads.store(2, Ordering::SeqCst);
    *env.secret.lock().unwrap() = Some("guardada".into());
    let mut profile = test_profile();
    profile.auth = AuthMethod::Password;
    let base = Credentials::default();
    let cancel = CancellationToken::new();
    let c = creds_for_attempt(&*env, &profile, &base, true, "s1", 2, 3, &cancel)
        .await
        .ok()
        .expect("credenciales");
    assert_eq!(c.password.as_deref(), Some("guardada"));
    let evs = env.reconnecting();
    assert_eq!(evs.len(), 2, "un aviso al esperar y otro al desbloquear");
    assert!(evs[0].waiting_unlock);
    assert_eq!(evs[0].attempt, 2);
    assert!(!evs[1].waiting_unlock);
}

/// Si cancelan mientras espera el desbloqueo, se deja de esperar.
#[tokio::test]
async fn creds_wait_for_unlock_can_be_cancelled() {
    let env = TestEnv::new(true, 3);
    env.locked_reads.store(u32::MAX, Ordering::SeqCst);
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        c2.cancel();
    });
    let r = creds_for_attempt(&*env, &test_profile(), &Credentials::default(), true, "s1", 1, 3, &cancel).await;
    assert!(matches!(r, Err(Outcome::Cancelled)));
}
