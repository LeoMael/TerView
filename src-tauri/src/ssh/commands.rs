//! Comandos Tauri de SSH. DUEÑO: agente SSH.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::ssh::connect::{self, Credentials, WRONG_PASSPHRASE_MSG, WRONG_PASSWORD_MSG};
use crate::ssh::handler::HostKeyPolicy;
use crate::ssh::reconnect::{self, ReconnectEnv, ReconnectSettings, Supervised, Timing};
use crate::ssh::{known_hosts, SessionStore, SshSession};
use crate::storage::{secrets, ProfileStore, SettingsStore};
use crate::types::{
    AuthMethod, SessionClosed, SessionInfo, SessionReconnecting, EV_SESSION_CLOSED,
    EV_SESSION_RECONNECTED, EV_SESSION_RECONNECTING,
};

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

async fn keyring_get(profile_id: &str) -> Option<String> {
    let id = profile_id.to_string();
    match tokio::task::spawn_blocking(move || secrets::get_secret(&id)).await {
        Ok(Ok(v)) => non_empty(v),
        Ok(Err(e)) => {
            log::warn!("llavero: no se pudo leer el secreto de {profile_id}: {e}");
            None
        }
        Err(e) => {
            log::warn!("llavero: tarea fallida: {e}");
            None
        }
    }
}

async fn keyring_set(profile_id: &str, secret: String) {
    let id = profile_id.to_string();
    match tokio::task::spawn_blocking(move || secrets::set_secret(&id, &secret)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::warn!("llavero: no se pudo guardar el secreto de {profile_id}: {e}"),
        Err(e) => log::warn!("llavero: tarea fallida: {e}"),
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
            } else if let Some(p) = keyring_get(&profile.id).await {
                from_keyring = true;
                creds.password = Some(p);
            }
        }
        AuthMethod::Key => {
            if let Some(p) = passphrase {
                user_secret = Some(p.clone());
                creds.passphrase = Some(p);
            } else if let Some(p) = keyring_get(&profile.id).await {
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

    if save_secret == Some(true)
        && let Some(secret) = user_secret
    {
        keyring_set(&profile.id, secret).await;
    }

    let session = Arc::new(session);
    let info = session.info.clone();
    sessions.insert(session.clone()).await;
    // El código OTP es de un solo uso: no sirve para reconectar.
    creds.otp = None;
    let sup = Supervised {
        profile,
        creds,
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
