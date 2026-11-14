//! Errores comunes de la app.
//!
//! Todos los comandos devuelven `AppResult<T>`. Al llegar a la interfaz, el error
//! se convierte en `{ kind, message, hostKey }` (ver `src/api/types.ts` → `ApiErrorPayload`).

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::types::HostKeyInfo;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("No se encontró: {0}")]
    NotFound(String),
    #[error("La sesión no existe o ya se cerró")]
    SessionNotFound(String),
    #[error("No se pudo conectar: {0}")]
    Network(String),
    #[error("Autenticación fallida: {0}")]
    AuthFailed(String),
    #[error("Se necesita la contraseña")]
    NeedsPassword,
    #[error("La llave privada está protegida con frase")]
    NeedsPassphrase,
    /// Segundo factor (código OTP/2FA). El texto es la pregunta del servidor.
    #[error("{0}")]
    NeedsOtp(String),
    #[error("Servidor desconocido: confirma su huella antes de conectar")]
    HostKeyUnknown(HostKeyInfo),
    #[error("¡La huella del servidor cambió! Podría ser un ataque.")]
    HostKeyChanged(HostKeyInfo),
    #[error("Error SSH: {0}")]
    Ssh(String),
    #[error("Error SFTP: {0}")]
    Sftp(String),
    #[error("Error de archivos: {0}")]
    Io(String),
    #[error("El archivo es demasiado grande para el editor ({0} bytes)")]
    FileTooLarge(u64),
    #[error("Llavero del sistema: {0}")]
    Keyring(String),
    #[error("{0}")]
    Invalid(String),
    #[error("Cancelado")]
    Canceled,
    /// La bóveda de contraseñas está bloqueada: hay que escribir el PIN.
    #[error("SSHorus está bloqueado: escribe tu PIN para usar las contraseñas guardadas")]
    Locked,
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "NotFound",
            AppError::SessionNotFound(_) => "SessionNotFound",
            AppError::Network(_) => "Network",
            AppError::AuthFailed(_) => "AuthFailed",
            AppError::NeedsPassword => "NeedsPassword",
            AppError::NeedsPassphrase => "NeedsPassphrase",
            AppError::NeedsOtp(_) => "NeedsOtp",
            AppError::HostKeyUnknown(_) => "HostKeyUnknown",
            AppError::HostKeyChanged(_) => "HostKeyChanged",
            AppError::Ssh(_) => "Ssh",
            AppError::Sftp(_) => "Sftp",
            AppError::Io(_) => "Io",
            AppError::FileTooLarge(_) => "FileTooLarge",
            AppError::Keyring(_) => "Keyring",
            AppError::Invalid(_) => "Invalid",
            AppError::Canceled => "Canceled",
            AppError::Locked => "Locked",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let host_key = match self {
            AppError::HostKeyUnknown(h) | AppError::HostKeyChanged(h) => Some(h),
            _ => None,
        };
        let mut st = s.serialize_struct("AppError", 3)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("hostKey", &host_key)?;
        st.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        AppError::Sftp(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Invalid(e.to_string())
    }
}
