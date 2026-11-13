//! Conexiones SSH.
//!
//! Base compartida (NO cambiar firmas sin coordinar): `SshSession`, `SessionStore`.
//! Los módulos terminal / sftp / transfer usan `SessionStore::get` y
//! `SshSession::open_channel` / `SshSession::open_sftp`.

pub mod commands;
pub mod connect;
pub mod handler;
pub mod known_hosts;
pub mod login_secret;
pub mod reconnect;

pub use commands::*;

use std::collections::HashMap;
use std::sync::Arc;

use russh::client::{Handle, Msg};
use russh::Channel;
use russh_sftp::client::SftpSession;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::types::SessionInfo;

/// Una conexión SSH autenticada. Se comparte con `Arc`; dentro se abren canales.
pub struct SshSession {
    pub info: SessionInfo,
    pub handle: Handle<handler::ClientHandler>,
}

impl SshSession {
    /// Abre un canal nuevo (para shell/PTY, exec o subsistema).
    pub async fn open_channel(&self) -> AppResult<Channel<Msg>> {
        if self.handle.is_closed() {
            return Err(AppError::SessionNotFound(self.info.id.clone()));
        }
        Ok(self.handle.channel_open_session().await?)
    }

    /// Abre un canal SFTP nuevo e independiente.
    pub async fn open_sftp(&self) -> AppResult<SftpSession> {
        let channel = self.open_channel().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(SftpSession::new(channel.into_stream()).await?)
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
}

/// Entrada del almacén: la conexión actual de un sessionId.
struct Slot {
    session: Arc<SshSession>,
    /// Se cancela al quitar la sesión (`remove`): detiene el vigilante y la reconexión.
    cancel: CancellationToken,
    /// La conexión se cayó y se está reintentando: `get` responde `SessionNotFound`.
    reconnecting: bool,
}

/// Sesiones activas: sessionId → conexión.
#[derive(Default)]
pub struct SessionStore {
    sessions: RwLock<HashMap<String, Slot>>,
}

impl SessionStore {
    pub async fn get(&self, id: &str) -> AppResult<Arc<SshSession>> {
        let map = self.sessions.read().await;
        match map.get(id) {
            Some(s) if !s.reconnecting && !s.session.is_closed() => Ok(s.session.clone()),
            _ => Err(AppError::SessionNotFound(id.to_string())),
        }
    }

    pub async fn insert(&self, session: Arc<SshSession>) {
        let slot = Slot {
            session: session.clone(),
            cancel: CancellationToken::new(),
            reconnecting: false,
        };
        if let Some(old) = self.sessions.write().await.insert(session.info.id.clone(), slot) {
            old.cancel.cancel();
        }
    }

    /// Quita la sesión y cancela su vigilante / reconexión en curso.
    pub async fn remove(&self, id: &str) -> Option<Arc<SshSession>> {
        let slot = self.sessions.write().await.remove(id)?;
        slot.cancel.cancel();
        login_secret::forget(id);
        Some(slot.session)
    }

    /// Señal que se dispara cuando la sesión se quita del almacén.
    pub async fn cancel_token(&self, id: &str) -> Option<CancellationToken> {
        self.sessions.read().await.get(id).map(|s| s.cancel.clone())
    }

    /// Marca (o desmarca) la sesión como "reconectando". false si ya no existe.
    pub async fn set_reconnecting(&self, id: &str, reconnecting: bool) -> bool {
        match self.sessions.write().await.get_mut(id) {
            Some(s) if !s.cancel.is_cancelled() => {
                s.reconnecting = reconnecting;
                true
            }
            _ => false,
        }
    }

    /// Reemplaza la conexión de un sessionId que sigue registrado (reconexión).
    /// Conserva su señal de cancelación. false si la sesión ya se quitó.
    pub async fn replace(&self, id: &str, session: Arc<SshSession>) -> bool {
        match self.sessions.write().await.get_mut(id) {
            Some(s) if !s.cancel.is_cancelled() => {
                s.session = session;
                s.reconnecting = false;
                true
            }
            _ => false,
        }
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .read()
            .await
            .values()
            .filter(|s| !s.reconnecting && !s.session.is_closed())
            .map(|s| s.session.info.clone())
            .collect()
    }
}
