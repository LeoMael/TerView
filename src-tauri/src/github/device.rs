//! OAuth "device flow" (preparado, desactivado).
//!
//! Necesita una OAuth App registrada en GitHub con el device flow activado. Mientras `CLIENT_ID`
//! esté vacío, la interfaz no muestra esta opción y se usa el token personal pegado a mano.
//! Para activarlo basta con poner aquí el client_id (no es secreto) y recompilar.

use serde::{Deserialize, Serialize};

use super::http;
use crate::error::{AppError, AppResult};

/// client_id de la OAuth App de TerView. Vacío = device flow desactivado.
pub const CLIENT_ID: &str = "";

/// Permisos que pide el device flow (equivalentes a los del token clásico recomendado).
pub const SCOPES: &str = "repo read:public_key write:public_key gist";

pub fn available() -> bool {
    !CLIENT_ID.is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    #[serde(alias = "device_code")]
    pub device_code: String,
    #[serde(alias = "user_code")]
    pub user_code: String,
    #[serde(alias = "verification_uri")]
    pub verification_uri: String,
    #[serde(alias = "expires_in")]
    pub expires_in: u64,
    #[serde(default = "five")]
    pub interval: u64,
}

fn five() -> u64 {
    5
}

/// Resultado de un sondeo.
pub enum Poll {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Token(String),
}

fn require() -> AppResult<()> {
    if available() {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "El inicio de sesión con código no está disponible en esta versión".into(),
        ))
    }
}

pub async fn start() -> AppResult<DeviceCode> {
    require()?;
    let r = http::post_form(
        "https://github.com/login/device/code",
        &[("client_id", CLIENT_ID), ("scope", SCOPES)],
    )
    .await?;
    r.json()
}

pub async fn poll(device_code: &str) -> AppResult<Poll> {
    require()?;
    let r = http::post_form(
        "https://github.com/login/oauth/access_token",
        &[
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )
    .await?;
    let v: serde_json::Value = r.json()?;
    if let Some(t) = v.get("access_token").and_then(|t| t.as_str()) {
        return Ok(Poll::Token(t.to_string()));
    }
    Ok(
        match v.get("error").and_then(|e| e.as_str()).unwrap_or_default() {
            "authorization_pending" => Poll::Pending,
            "slow_down" => Poll::SlowDown,
            "expired_token" => Poll::Expired,
            "access_denied" => Poll::Denied,
            other => {
                return Err(AppError::Invalid(format!(
                    "GitHub rechazó el inicio de sesión ({other})"
                )));
            }
        },
    )
}
