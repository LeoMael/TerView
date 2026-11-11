//! Vigilante de la conexión + reconexión automática. DUEÑO: agente SSH.
//!
//! Independiente de Tauri: todo lo que toca la app (almacén de sesiones, eventos,
//! liberar recursos, ajustes) pasa por `ReconnectEnv`, así se prueba directamente
//! contra el servidor de pruebas.
//!
//! Ciclo de una sesión:
//! 1. Cada `watch_interval` se mira si la conexión sigue viva (la señal de vida de russh
//!    la cierra si el servidor deja de responder).
//! 2. Si se cayó y la reconexión automática está activa: se marca "reconectando"
//!    (`SessionStore::get` responde `SessionNotFound`), se liberan terminales y canales SFTP,
//!    y se reintenta con espera creciente. Antes de cada espera: `SessionReconnecting`.
//! 3. Éxito → misma `sessionId` con la conexión nueva, se reanudan transferencias y se emite
//!    `SessionInfo`. Fracaso definitivo → se quita la sesión y se emite `SessionClosed`.
//! 4. `SessionStore::remove` (p. ej. `ssh_disconnect`) cancela todo sin emitir nada más.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::ssh::connect::{self, Credentials};
use crate::ssh::handler::{HostKeyPolicy, SharedState};
use crate::ssh::{disconnect_session, SessionStore, SshSession};
use crate::types::{ServerProfile, SessionClosed, SessionInfo, SessionReconnecting, Settings};

/// Lo que el vigilante necesita de la aplicación.
pub trait ReconnectEnv: Send + Sync + 'static {
    fn sessions(&self) -> &SessionStore;
    /// Ajustes vigentes (se leen en cada caída).
    fn settings(&self) -> ReconnectSettings;
    fn emit_reconnecting(&self, ev: SessionReconnecting);
    fn emit_reconnected(&self, info: SessionInfo);
    fn emit_closed(&self, ev: SessionClosed);
    /// La conexión se cayó: soltar terminales y canales SFTP (están muertos).
    fn release_dropped(&self, session_id: &str);
    /// Pérdida definitiva: soltar todo, incluidas las transferencias.
    fn release_all(&self, session_id: &str);
    /// Reconectada: reanudar las transferencias que fallaron por la caída.
    fn resume(&self, session_id: &str);
}

#[derive(Debug, Clone, Copy)]
pub struct ReconnectSettings {
    pub auto_reconnect: bool,
    /// 1..=20
    pub attempts: u8,
    /// Intervalo de la señal de vida para las conexiones nuevas (s).
    pub keepalive_secs: u16,
}

impl From<&Settings> for ReconnectSettings {
    fn from(s: &Settings) -> Self {
        Self {
            auto_reconnect: s.auto_reconnect,
            attempts: s.reconnect_attempts.clamp(1, 20),
            keepalive_secs: s.keepalive_secs,
        }
    }
}

/// Tiempos del vigilante (los tests usan unos más cortos).
#[derive(Debug, Clone)]
pub struct Timing {
    pub watch_interval: Duration,
    /// Espera antes de cada intento; el último valor se repite.
    pub backoff: Vec<Duration>,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            watch_interval: Duration::from_millis(1500),
            backoff: [1, 2, 5, 10, 30].map(Duration::from_secs).to_vec(),
        }
    }
}

impl Timing {
    /// Espera antes del intento `attempt` (1-based).
    pub fn backoff(&self, attempt: u8) -> Duration {
        let i = usize::from(attempt.max(1) - 1);
        self.backoff
            .get(i)
            .or_else(|| self.backoff.last())
            .copied()
            .unwrap_or(Duration::from_secs(1))
    }
}

/// Una sesión vigilada y lo necesario para rehacerla.
pub struct Supervised {
    pub profile: ServerProfile,
    /// Credenciales que funcionaron (solo en memoria, mientras viva la sesión). Sin OTP.
    pub creds: Credentials,
    pub policy: HostKeyPolicy,
    pub session: Arc<SshSession>,
    pub shared: Arc<Mutex<SharedState>>,
}

enum Outcome {
    Reconnected(Arc<SshSession>, Arc<Mutex<SharedState>>),
    GaveUp(String),
    Cancelled,
}

fn disconnect_reason(shared: &Mutex<SharedState>) -> String {
    shared
        .lock()
        .ok()
        .and_then(|s| s.disconnect_reason.clone())
        .unwrap_or_else(|| "Se perdió la conexión con el servidor".to_string())
}

/// Errores con los que no tiene sentido seguir reintentando (requieren al usuario).
fn fatal_reason(e: &AppError) -> Option<String> {
    let msg = match e {
        AppError::HostKeyChanged(_) => {
            "¡la huella del servidor cambió! Vuelve a conectar para revisarla".to_string()
        }
        AppError::HostKeyUnknown(_) => {
            "el servidor ya no figura en known_hosts; vuelve a conectar para confirmar su huella"
                .to_string()
        }
        AppError::NeedsOtp(_) => {
            "el servidor pide un código de verificación; vuelve a conectar".to_string()
        }
        AppError::NeedsPassword => "se necesita la contraseña; vuelve a conectar".to_string(),
        AppError::NeedsPassphrase => {
            "se necesita la frase de la llave; vuelve a conectar".to_string()
        }
        AppError::AuthFailed(_) | AppError::Invalid(_) | AppError::Io(_) => e.to_string(),
        _ => return None,
    };
    Some(msg)
}

/// Vigila la sesión hasta que se quite del almacén o se pierda definitivamente.
/// La sesión ya debe estar en `env.sessions()`.
pub async fn supervise<E: ReconnectEnv>(env: Arc<E>, mut sup: Supervised, timing: Timing) {
    let id = sup.session.info.id.clone();
    let Some(cancel) = env.sessions().cancel_token(&id).await else {
        return;
    };
    loop {
        // 1. Esperar a que se caiga (o a que la quiten).
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(timing.watch_interval) => {}
            }
            if sup.session.is_closed() {
                break;
            }
        }
        if cancel.is_cancelled() {
            return;
        }
        let reason = disconnect_reason(&sup.shared);
        let settings = env.settings();
        log::info!("sesión {id}: {reason}");

        if !settings.auto_reconnect {
            close(&*env, &id, reason).await;
            return;
        }
        if !env.sessions().set_reconnecting(&id, true).await {
            return;
        }
        env.release_dropped(&id);

        match reconnect_loop(&*env, &sup, &settings, &timing, &cancel, reason).await {
            Outcome::Reconnected(session, shared) => {
                if !env.sessions().replace(&id, session.clone()).await {
                    // La quitaron justo ahora: no avisar de nada.
                    disconnect_session(&session).await;
                    return;
                }
                sup.session = session;
                sup.shared = shared;
                env.resume(&id);
                if cancel.is_cancelled() {
                    return;
                }
                log::info!("sesión {id} reconectada");
                env.emit_reconnected(sup.session.info.clone());
            }
            Outcome::GaveUp(msg) => {
                close(&*env, &id, msg).await;
                return;
            }
            Outcome::Cancelled => return,
        }
    }
}

/// Pérdida definitiva: quita la sesión, libera recursos y avisa (si nadie la quitó antes).
async fn close<E: ReconnectEnv>(env: &E, id: &str, reason: String) {
    if env.sessions().remove(id).await.is_some() {
        env.release_all(id);
        log::info!("sesión {id} cerrada: {reason}");
        env.emit_closed(SessionClosed {
            session_id: id.to_string(),
            reason,
        });
    }
}

async fn reconnect_loop<E: ReconnectEnv>(
    env: &E,
    sup: &Supervised,
    settings: &ReconnectSettings,
    timing: &Timing,
    cancel: &CancellationToken,
    first_reason: String,
) -> Outcome {
    let id = &sup.session.info.id;
    let max = settings.attempts.clamp(1, 20);
    let keepalive = connect::keepalive_interval(settings.keepalive_secs);
    let mut reason = first_reason;
    let mut last_error = String::new();

    for attempt in 1..=max {
        let wait = timing.backoff(attempt);
        if cancel.is_cancelled() {
            return Outcome::Cancelled;
        }
        env.emit_reconnecting(SessionReconnecting {
            session_id: id.clone(),
            attempt,
            max_attempts: max,
            next_retry_secs: wait.as_secs_f64().ceil() as u32,
            reason: reason.clone(),
        });
        tokio::select! {
            _ = cancel.cancelled() => return Outcome::Cancelled,
            _ = tokio::time::sleep(wait) => {}
        }
        let fut = connect::connect_full(&sup.profile, sup.creds.clone(), sup.policy.clone(), keepalive);
        let res = tokio::select! {
            _ = cancel.cancelled() => return Outcome::Cancelled,
            r = fut => r,
        };
        match res {
            Ok((mut session, shared)) => {
                session.info.id = id.clone();
                return Outcome::Reconnected(Arc::new(session), shared);
            }
            Err(e) => {
                log::info!("sesión {id}: intento de reconexión {attempt}/{max} fallido: {e}");
                if let Some(msg) = fatal_reason(&e) {
                    return Outcome::GaveUp(format!("No se pudo reconectar: {msg}"));
                }
                last_error = e.to_string();
                reason = format!("Intento {attempt} fallido: {e}");
            }
        }
    }
    Outcome::GaveUp(format!(
        "No se pudo reconectar tras {max} intentos: {last_error}"
    ))
}

#[cfg(test)]
#[path = "reconnect_tests.rs"]
mod tests;
