//! Manejador de eventos del cliente SSH (verificación de huella del servidor).
//! DUEÑO: agente SSH.
//!
//! `check_server_key` no puede devolver un error propio a `connect`, así que el
//! resultado de la verificación se deja en `verdict` (compartido con `Arc<Mutex>`)
//! y `connect` lo consulta cuando la negociación falla.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use russh::client::{self, DisconnectReason};
use russh::keys::{HashAlg, PublicKeyOrCertificate};

use crate::ssh::known_hosts::{self, HostKeyStatus};
use crate::types::HostKeyInfo;

/// Cómo decidir si se confía en la llave del servidor.
#[derive(Debug, Clone)]
pub enum HostKeyPolicy {
    /// Comprobar contra un archivo known_hosts (normalmente `~/.ssh/known_hosts`).
    KnownHosts(PathBuf),
    /// Aceptar cualquier llave (SOLO para tests).
    #[allow(dead_code)]
    AcceptAny,
}

/// Resultado de la verificación de la huella.
#[derive(Debug, Clone)]
pub enum HostKeyVerdict {
    Trusted,
    Unknown(HostKeyInfo),
    Changed(HostKeyInfo),
    /// No se pudo leer/interpretar known_hosts.
    Error(String),
}

/// Estado compartido entre el manejador (que vive dentro de la tarea de russh) y el resto.
#[derive(Debug, Default)]
pub struct SharedState {
    pub verdict: Option<HostKeyVerdict>,
    /// Motivo de cierre (en español) si el servidor nos desconectó o hubo un error.
    pub disconnect_reason: Option<String>,
    /// Banner de autenticación enviado por el servidor (si lo hubo).
    pub banner: Option<String>,
}

pub struct ClientHandler {
    pub host: String,
    pub port: u16,
    pub policy: HostKeyPolicy,
    pub shared: Arc<Mutex<SharedState>>,
}

impl ClientHandler {
    pub fn new(host: &str, port: u16, policy: HostKeyPolicy) -> Self {
        Self {
            host: host.to_string(),
            port,
            policy,
            shared: Arc::new(Mutex::new(SharedState::default())),
        }
    }

    fn set_verdict(&self, v: HostKeyVerdict) {
        if let Ok(mut s) = self.shared.lock() {
            s.verdict = Some(v);
        }
    }

    fn set_reason(&self, reason: String) {
        if let Ok(mut s) = self.shared.lock()
            && s.disconnect_reason.is_none()
        {
            s.disconnect_reason = Some(reason);
        }
    }
}

/// Construye la info que verá el usuario (algoritmo, SHA256, línea OpenSSH).
pub fn host_key_info(host: &str, port: u16, key: &russh::keys::PublicKey) -> HostKeyInfo {
    HostKeyInfo {
        host: host.to_string(),
        port,
        algorithm: key.algorithm().as_str().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        key_openssh: key.to_openssh().unwrap_or_default(),
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            // No soportamos autoridades de certificación de host: verificamos la llave
            // pública del certificado igual que una llave normal.
            PublicKeyOrCertificate::Certificate(cert) => {
                russh::keys::PublicKey::from(cert.public_key().clone())
            }
        };
        let path = match &self.policy {
            HostKeyPolicy::AcceptAny => {
                self.set_verdict(HostKeyVerdict::Trusted);
                return Ok(true);
            }
            HostKeyPolicy::KnownHosts(p) => p.clone(),
        };
        let info = host_key_info(&self.host, self.port, &key);
        let (host, port) = (self.host.clone(), self.port);
        let status = tokio::task::spawn_blocking(move || {
            known_hosts::check(&path, &host, port, &key)
        })
        .await
        .map_err(|e| known_hosts::KnownHostsError(e.to_string()))
        .and_then(|r| r);
        let (verdict, ok) = match status {
            Ok(HostKeyStatus::Match) => (HostKeyVerdict::Trusted, true),
            Ok(HostKeyStatus::Unknown) => (HostKeyVerdict::Unknown(info), false),
            Ok(HostKeyStatus::Changed) => (HostKeyVerdict::Changed(info), false),
            Err(e) => (HostKeyVerdict::Error(e.0), false),
        };
        self.set_verdict(verdict);
        Ok(ok)
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Ok(mut s) = self.shared.lock() {
            s.banner = Some(banner.to_string());
        }
        Ok(())
    }

    /// Túneles remotos (-R): el canal `forwarded-tcpip` se entrega al módulo de túneles.
    #[allow(clippy::too_many_arguments)]
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        crate::tunnels::on_forwarded_tcpip(&self.host, self.port, channel, connected_port, reply);
        Ok(())
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        match reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                let msg = info.message.trim();
                self.set_reason(if msg.is_empty() {
                    "El servidor cerró la conexión".to_string()
                } else {
                    format!("El servidor cerró la conexión: {msg}")
                });
                Ok(())
            }
            DisconnectReason::Error(e) => {
                self.set_reason(describe_disconnect_error(&e));
                Err(e)
            }
        }
    }
}

/// Traduce un error de russh que tumbó la conexión a un motivo legible.
pub fn describe_disconnect_error(e: &russh::Error) -> String {
    match e {
        russh::Error::KeepaliveTimeout => {
            "Se perdió la conexión: el servidor dejó de responder".to_string()
        }
        russh::Error::InactivityTimeout => "Conexión cerrada por inactividad".to_string(),
        russh::Error::IO(io) => format!("Se perdió la conexión de red ({io})"),
        russh::Error::Disconnect => "El servidor cerró la conexión".to_string(),
        other => format!("Se perdió la conexión: {other}"),
    }
}
