//! Comandos Tauri de SSH. DUEÑO: agente SSH.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::ssh::connect::{
    self, ConnectionTest, Credentials, WRONG_PASSPHRASE_MSG, WRONG_PASSWORD_MSG,
};
use crate::ssh::handler::HostKeyPolicy;
use crate::ssh::reconnect::{self, ReconnectEnv, ReconnectSettings, Supervised, Timing};
use crate::ssh::{known_hosts, SessionStore, SshSession};
use crate::storage::vault::Vault;
use crate::storage::{secrets, ProfileStore, SettingsStore};
use crate::types::{
    AuthMethod, ServerProfile, SessionClosed, SessionInfo, SessionReconnecting, EV_SESSION_CLOSED,
    EV_SESSION_RECONNECTED, EV_SESSION_RECONNECTING,
};

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

/// Secreto guardado (bóveda o llavero). Si SSHorus está bloqueado devuelve `Locked` (la interfaz
/// pide el PIN); otros fallos del llavero solo se registran y se pide la contraseña.
async fn keyring_get(profile_id: &str) -> AppResult<Option<String>> {
    let id = profile_id.to_string();
    match tokio::task::spawn_blocking(move || secrets::get_secret(&id)).await {
        Ok(Ok(v)) => Ok(non_empty(v)),
        Ok(Err(AppError::Locked)) => Err(AppError::Locked),
        Ok(Err(e)) => {
            log::warn!("llavero: no se pudo leer el secreto de {profile_id}: {e}");
            Ok(None)
        }
        Err(e) => {
            log::warn!("llavero: tarea fallida: {e}");
            Ok(None)
        }
    }
}

/// Guarda el secreto. Devuelve si quedó guardado.
async fn keyring_set(profile_id: &str, secret: String) -> bool {
    let id = profile_id.to_string();
    match tokio::task::spawn_blocking(move || secrets::set_secret(&id, &secret)).await {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            log::warn!("llavero: no se pudo guardar el secreto de {profile_id}: {e}");
            false
        }
        Err(e) => {
            log::warn!("llavero: tarea fallida: {e}");
            false
        }
    }
}

/// Conecta usando un perfil guardado.
/// - `password` / `passphrase`: si la interfaz los pidió al usuario; si son None se buscan en el llavero.
/// - `save_secret`: si true y la conexión funcionó, guarda el secreto en el llavero.
/// Errores esperados por la interfaz: NeedsPassword, NeedsPassphrase, AuthFailed,
/// HostKeyUnknown (mostrar diálogo y luego `ssh_trust_host` + reintentar), HostKeyChanged, Network.
///
/// Si el secreto venía del llavero y resultó incorrecto, se devuelve NeedsPassword /
/// NeedsPassphrase (no AuthFailed) para que la interfaz lo pida de nuevo.
///
/// 2FA: si el servidor pide un código (keyboard-interactive) y `otp` es None → `NeedsOtp(pregunta)`;
/// la interfaz pide el código y repite la llamada con `otp` (y la misma contraseña).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // firma fija del comando (la interfaz la llama así)
pub async fn ssh_connect(
    app: AppHandle,
    sessions: State<'_, SessionStore>,
    profiles: State<'_, ProfileStore>,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    // Código 2FA/OTP para keyboard-interactive.
    otp: Option<String>,
    save_secret: Option<bool>,
) -> AppResult<SessionInfo> {
    let profile = profiles.get_server(&profile_id)?;
    let password = non_empty(password);
    let passphrase = non_empty(passphrase);

    // Secreto relevante según el método: el que dio el usuario o, si no, el del llavero.
    let mut creds = Credentials {
        otp: non_empty(otp),
        ..Default::default()
    };
    let mut user_secret: Option<String> = None;
    let mut from_keyring = false;
    match profile.auth {
        AuthMethod::Password => {
            if let Some(p) = password {
                user_secret = Some(p.clone());
                creds.password = Some(p);
            } else if let Some(p) = keyring_get(&profile.id).await? {
                from_keyring = true;
                creds.password = Some(p);
            }
        }
        AuthMethod::Key => {
            if let Some(p) = passphrase {
                user_secret = Some(p.clone());
                creds.passphrase = Some(p);
            } else if let Some(p) = keyring_get(&profile.id).await? {
                from_keyring = true;
                creds.passphrase = Some(p);
            }
            // Contraseña opcional como segundo factor (llave + contraseña).
            creds.password = password;
        }
        AuthMethod::Agent => creds.password = password,
    }

    let settings = app
        .try_state::<SettingsStore>()
        .map(|s| s.get())
        .unwrap_or_default();
    let keepalive = connect::keepalive_interval(settings.keepalive_secs);
    let policy = HostKeyPolicy::KnownHosts(known_hosts::default_path()?);
    let connected =
        connect::connect_full(&profile, creds.clone(), policy.clone(), keepalive).await;
    let (session, shared) = match connected {
        Ok(v) => v,
        Err(AppError::AuthFailed(msg)) if from_keyring && msg == WRONG_PASSWORD_MSG => {
            log::info!("la contraseña guardada de {} ya no es válida", profile.id);
            return Err(AppError::NeedsPassword);
        }
        Err(AppError::AuthFailed(msg)) if from_keyring && msg == WRONG_PASSPHRASE_MSG => {
            log::info!("la frase guardada de {} ya no es válida", profile.id);
            return Err(AppError::NeedsPassphrase);
        }
        Err(e) => return Err(e),
    };

    let mut saved = false;
    if save_secret == Some(true)
        && let Some(secret) = user_secret
    {
        saved = keyring_set(&profile.id, secret).await;
    }
    // Con la bóveda activa, el secreto guardado no se queda en memoria con la sesión: al
    // reconectar se vuelve a leer (y si SSHorus está bloqueado, se espera al desbloqueo).
    let stored_secret = (from_keyring || saved) && Vault::global().is_enabled();
    // Para sudo «La de la conexión»: la contraseña escrita al conectar (sin guardarla en la bóveda) queda
    // en memoria mientras viva la sesión (ver `login_secret`).
    let login_password = match (&profile.auth, &creds.password) {
        (AuthMethod::Password, Some(p)) if !stored_secret => Some(zeroize::Zeroizing::new(p.clone())),
        _ => None,
    };
    if stored_secret {
        match profile.auth {
            AuthMethod::Password => creds.password = None,
            AuthMethod::Key => creds.passphrase = None,
            AuthMethod::Agent => {}
        }
    }

    let session = Arc::new(session);
    let info = session.info.clone();
    sessions.insert(session.clone()).await;
    if let Some(p) = login_password {
        super::login_secret::remember(&info.id, &p);
    }
    // El código OTP es de un solo uso: no sirve para reconectar.
    creds.otp = None;
    let sup = Supervised {
        profile,
        creds,
        stored_secret,
        policy,
        session,
        shared,
    };
    tauri::async_runtime::spawn(reconnect::supervise(
        Arc::new(TauriEnv { app }),
        sup,
        Timing::default(),
    ));
    log::info!(
        "conectado a {}@{}:{} (sesión {})",
        info.username,
        info.host,
        info.port,
        info.id
    );
    Ok(info)
}

/// Puente entre el vigilante de reconexión y la app Tauri.
struct TauriEnv {
    app: AppHandle,
}

impl ReconnectEnv for TauriEnv {
    fn sessions(&self) -> &SessionStore {
        self.app.state::<SessionStore>().inner()
    }

    fn settings(&self) -> ReconnectSettings {
        let s = self
            .app
            .try_state::<SettingsStore>()
            .map(|s| s.get())
            .unwrap_or_default();
        ReconnectSettings::from(&s)
    }

    fn emit_reconnecting(&self, ev: SessionReconnecting) {
        let _ = self.app.emit(EV_SESSION_RECONNECTING, ev);
    }

    fn emit_reconnected(&self, info: SessionInfo) {
        let _ = self.app.emit(EV_SESSION_RECONNECTED, info);
    }

    fn emit_closed(&self, ev: SessionClosed) {
        let _ = self.app.emit(EV_SESSION_CLOSED, ev);
    }

    fn release_dropped(&self, session_id: &str) {
        if let Some(t) = self.app.try_state::<crate::terminal::TerminalStore>() {
            t.close_session(session_id);
        }
        if let Some(s) = self.app.try_state::<crate::sftp::SftpStore>() {
            s.forget(session_id);
        }
    }

    fn release_all(&self, session_id: &str) {
        release_session_resources(&self.app, session_id);
    }

    fn resume(&self, session_id: &str) {
        if let Some(x) = self.app.try_state::<crate::transfer::TransferManager>() {
            x.resume_session(session_id);
        }
    }

    fn stored_secret(&self, profile_id: &str) -> futures::future::BoxFuture<'static, AppResult<Option<String>>> {
        let id = profile_id.to_string();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || secrets::get_secret(&id))
                .await
                .map_err(|e| AppError::Io(format!("tarea interrumpida: {e}")))?
                .map(non_empty)
        })
    }
}

/// Pruebas de conexión en curso (id de la prueba → token para cancelarla).
static TESTS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, CancellationToken>>> =
    std::sync::LazyLock::new(Default::default);

/// Quita la prueba del registro al terminar (también si la tarea se interrumpe).
struct TestGuard(String);
impl Drop for TestGuard {
    fn drop(&mut self) {
        if let Ok(mut t) = TESTS.lock() {
            t.remove(&self.0);
        }
    }
}

/// «Probar conexión» del editor de servidor: conecta y autentica con los datos del formulario
/// (aún sin guardar) y desconecta enseguida. No abre pestaña ni deja la sesión abierta.
/// - `password` / `passphrase`: lo escrito en el formulario. Solo viven en memoria durante la
///   prueba: no se guardan ni se registran.
/// - `use_saved_secret`: si no se escribió nada, usar el secreto ya guardado del servidor
///   (`profile.id`), p. ej. al editar uno existente sin cambiar la contraseña.
/// - Huella desconocida o cambiada: `HostKeyUnknown` / `HostKeyChanged`, como `ssh_connect`
///   (la interfaz pregunta, llama a `ssh_trust_host` y repite la prueba).
/// - Tiempo límite: 10 s. `ssh_cancel_test(test_id)` la cancela (`Canceled`).
#[tauri::command]
pub async fn ssh_test_connection(
    test_id: String,
    profile: ServerProfile,
    password: Option<String>,
    passphrase: Option<String>,
    use_saved_secret: Option<bool>,
) -> AppResult<ConnectionTest> {
    let token = CancellationToken::new();
    if let Ok(mut t) = TESTS.lock()
        && let Some(old) = t.insert(test_id.clone(), token.clone())
    {
        old.cancel();
    }
    let _guard = TestGuard(test_id);

    let mut creds = Credentials {
        password: non_empty(password),
        passphrase: non_empty(passphrase),
        otp: None,
    };
    let saved_wanted = use_saved_secret == Some(true) && !profile.id.is_empty();
    match profile.auth {
        AuthMethod::Password if creds.password.is_none() && saved_wanted => {
            creds.password = keyring_get(&profile.id).await?;
        }
        AuthMethod::Key if creds.passphrase.is_none() && saved_wanted => {
            creds.passphrase = keyring_get(&profile.id).await?;
        }
        _ => {}
    }
    // La contraseña solo se usa con el método «Contraseña» (sin segundo factor en la prueba).
    if profile.auth != AuthMethod::Password {
        creds.password = None;
    }

    let policy = HostKeyPolicy::KnownHosts(known_hosts::default_path()?);
    let r = connect::test_connection(&profile, creds, policy, connect::TEST_TIMEOUT, &token).await;
    match &r {
        Ok(t) => log::info!(
            "prueba de conexión a {}@{}:{}: correcta ({} ms)",
            profile.username.trim(),
            profile.host.trim(),
            profile.port,
            t.elapsed_ms
        ),
        Err(e) => log::info!(
            "prueba de conexión a {}@{}:{}: {}",
            profile.username.trim(),
            profile.host.trim(),
            profile.port,
            e.kind()
        ),
    }
    r
}

/// Cancela una prueba de conexión en curso (si ya terminó, no hace nada).
#[tauri::command]
pub async fn ssh_cancel_test(test_id: String) -> AppResult<()> {
    if let Some(t) = TESTS.lock().ok().and_then(|mut t| t.remove(&test_id)) {
        t.cancel();
    }
    Ok(())
}

/// Guarda la huella aceptada por el usuario en ~/.ssh/known_hosts.
/// Reemplaza cualquier entrada anterior de ese host:puerto (caso "huella cambiada").
#[tauri::command]
pub async fn ssh_trust_host(host: String, port: u16, key_openssh: String) -> AppResult<()> {
    let path = known_hosts::default_path()?;
    let port = if port == 0 { 22 } else { port };
    tokio::task::spawn_blocking(move || known_hosts::trust(&path, &host, port, &key_openssh))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    sessions: State<'_, SessionStore>,
    session_id: String,
) -> AppResult<()> {
    let Some(session) = sessions.remove(&session_id).await else {
        // Ya estaba cerrada: no es un error para la interfaz.
        return Ok(());
    };
    release_session_resources(&app, &session_id);
    disconnect_session(&session).await;
    let _ = app.emit(
        EV_SESSION_CLOSED,
        SessionClosed {
            session_id,
            reason: "Desconectado".to_string(),
        },
    );
    Ok(())
}

/// Libera terminales, canales SFTP del explorador y de transferencias de una sesión cerrada.
fn release_session_resources(app: &AppHandle, session_id: &str) {
    if let Some(t) = app.try_state::<crate::terminal::TerminalStore>() {
        t.close_session(session_id);
    }
    if let Some(s) = app.try_state::<crate::sftp::SftpStore>() {
        s.forget(session_id);
    }
    if let Some(x) = app.try_state::<crate::transfer::TransferManager>() {
        x.forget_session(session_id);
    }
}

/// Cierra la conexión de forma ordenada (sin esperar más de 3 s).
pub async fn disconnect_session(session: &SshSession) {
    if session.is_closed() {
        return;
    }
    let fut = session
        .handle
        .disconnect(russh::Disconnect::ByApplication, "Desconectado", "es");
    match tokio::time::timeout(Duration::from_secs(3), fut).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::debug!("disconnect: {e}"),
        Err(_) => log::debug!("disconnect: tiempo agotado"),
    }
}

#[tauri::command]
pub async fn ssh_list_sessions(sessions: State<'_, SessionStore>) -> AppResult<Vec<SessionInfo>> {
    Ok(sessions.list().await)
}
