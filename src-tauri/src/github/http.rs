//! Cliente HTTPS para GitHub (reqwest + rustls, sin OpenSSL).
//!
//! - Solo habla con hosts de GitHub conocidos (ver `ALLOWED_HOSTS`): no es un proxy genérico.
//! - Cabeceras fijas: `User-Agent: SSHorus`, `X-GitHub-Api-Version`, `Accept`.
//! - El token va en `Authorization` marcado como sensible y nunca se registra ni aparece en errores.
//! - Errores traducidos al español (401, 403 con límite de peticiones, 404, 422, 5xx, red).

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{self, HeaderMap, HeaderValue};
use reqwest::{Client, Method, StatusCode};
use serde::de::DeserializeOwned;

use crate::error::{AppError, AppResult};

pub const API: &str = "https://api.github.com";
pub const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "SSHorus";
const TIMEOUT: Duration = Duration::from_secs(25);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Límite de tamaño de cualquier respuesta (las de la API son pequeñas).
pub const MAX_BODY: usize = 8 * 1024 * 1024;

/// Hosts a los que el motor puede conectarse. Todo lo demás se rechaza.
const ALLOWED_HOSTS: &[&str] = &[
    "api.github.com",
    "github.com",
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "avatars.githubusercontent.com",
];

/// Hosts a los que se envía el token (los de contenido de GitHub, para repos/gists privados).
const TOKEN_HOSTS: &[&str] = &[
    "api.github.com",
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
];

fn client() -> AppResult<&'static Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            // Solo seguimos redirecciones dentro de GitHub (reqwest quita `Authorization` al cambiar de host).
            let ok = attempt.url().host_str().is_some_and(is_allowed_host);
            if attempt.previous().len() >= 5 || !ok {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| AppError::Network(format!("no se pudo preparar la conexión segura: {e}")))?;
    Ok(CLIENT.get_or_init(|| c))
}

pub fn is_allowed_host(host: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|h| h.eq_ignore_ascii_case(host))
}

/// Respuesta ya leída (cuerpo completo, con límite de tamaño).
#[derive(Debug)]
pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json<T: DeserializeOwned>(&self) -> AppResult<T> {
        serde_json::from_slice(&self.body)
            .map_err(|e| AppError::Invalid(format!("respuesta de GitHub inesperada: {e}")))
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// Petición a la API (`path` empieza por "/"). Devuelve error traducido si el estado no es 2xx.
pub async fn api(
    token: Option<&str>,
    method: Method,
    path: &str,
    body: Option<&serde_json::Value>,
) -> AppResult<Resp> {
    if !path.starts_with('/') {
        return Err(AppError::Invalid(
            "ruta de la API de GitHub inválida".into(),
        ));
    }
    let url = format!("{API}{path}");
    send(token, method, &url, body, MAX_BODY).await
}

/// GET a una URL completa de GitHub (contenido raw, avatares). Debe ser https y de un host permitido.
pub async fn get_url(token: Option<&str>, url: &str, max: usize) -> AppResult<Resp> {
    send(token, Method::GET, url, None, max).await
}

async fn send(
    token: Option<&str>,
    method: Method,
    url: &str,
    body: Option<&serde_json::Value>,
    max: usize,
) -> AppResult<Resp> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| AppError::Invalid("dirección no válida".into()))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if parsed.scheme() != "https" || !is_allowed_host(&host) {
        return Err(AppError::Invalid(
            "solo se admiten direcciones https de GitHub (github.com, gist o raw.githubusercontent.com)".into(),
        ));
    }

    let mut req = client()?
        .request(method, parsed)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION);
    if let Some(t) = token.filter(|_| TOKEN_HOSTS.contains(&host.as_str())) {
        let mut v = HeaderValue::from_str(&format!("Bearer {t}"))
            .map_err(|_| AppError::Invalid("el token contiene caracteres no válidos".into()))?;
        v.set_sensitive(true);
        req = req.header(header::AUTHORIZATION, v);
    }
    if let Some(b) = body {
        req = req
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(b)?);
    }

    let mut resp = req.send().await.map_err(net_err)?;
    let status = resp.status();
    let headers = resp.headers().clone();
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err(AppError::Invalid(
            "la respuesta de GitHub es demasiado grande".into(),
        ));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net_err)? {
        if buf.len() + chunk.len() > max {
            return Err(AppError::Invalid(
                "la respuesta de GitHub es demasiado grande".into(),
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    let r = Resp {
        status,
        headers,
        body: buf,
    };
    if !status.is_success() {
        return Err(status_error(&r));
    }
    Ok(r)
}

fn net_err(e: reqwest::Error) -> AppError {
    // `without_url`: nunca mostramos la URL (puede llevar rutas raw de gists privados).
    let e = e.without_url();
    if e.is_timeout() {
        AppError::Network(
            "GitHub no respondió a tiempo. Revisa tu conexión e inténtalo de nuevo.".into(),
        )
    } else if e.is_connect() {
        AppError::Network("no se pudo conectar con GitHub. Revisa tu conexión a internet.".into())
    } else {
        AppError::Network(format!("error al hablar con GitHub: {e}"))
    }
}

/// Mensaje de error de GitHub (`{"message": "...", "errors": [{"message": "..."}]}`).
fn gh_message(body: &[u8]) -> String {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else {
        return String::new();
    };
    let mut msg = v
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    if let Some(errs) = v.get("errors").and_then(|e| e.as_array()) {
        let details: Vec<String> = errs
            .iter()
            .filter_map(|e| {
                e.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
                    .or_else(|| e.get("code").and_then(|c| c.as_str()).map(str::to_string))
            })
            .collect();
        if !details.is_empty() {
            if !msg.is_empty() {
                msg.push_str(": ");
            }
            msg.push_str(&details.join("; "));
        }
    }
    msg
}

/// Hora local (HH:MM) de un instante Unix.
fn local_hhmm(unix: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_opt(unix, 0).single() {
        Some(t) => t.format("%H:%M").to_string(),
        None => "?".into(),
    }
}

/// Traduce una respuesta no-2xx a un `AppError` en español.
pub fn status_error(r: &Resp) -> AppError {
    let msg = gh_message(&r.body);
    let detail = if msg.is_empty() {
        String::new()
    } else {
        format!(" ({msg})")
    };
    let code = r.status.as_u16();
    let remaining = r
        .header("x-ratelimit-remaining")
        .and_then(|v| v.trim().parse::<u64>().ok());
    let reset = r
        .header("x-ratelimit-reset")
        .and_then(|v| v.trim().parse::<i64>().ok());
    let retry_after = r
        .header("retry-after")
        .and_then(|v| v.trim().parse::<u64>().ok());
    let lower = msg.to_ascii_lowercase();

    match code {
        401 => AppError::AuthFailed(
            "Token no válido o caducado. Vuelve a conectar tu cuenta de GitHub.".into(),
        ),
        403 | 429 if remaining == Some(0) => {
            let when = reset
                .map(|t| format!(" Se reinicia a las {}.", local_hhmm(t)))
                .unwrap_or_default();
            AppError::Network(format!(
                "Se alcanzó el límite de peticiones de GitHub.{when}"
            ))
        }
        403 | 429 if retry_after.is_some() || lower.contains("rate limit") => {
            let wait = retry_after
                .map(|s| format!(" Espera {s} s e inténtalo de nuevo."))
                .unwrap_or_default();
            AppError::Network(format!(
                "GitHub limitó las peticiones por exceso de uso.{wait}"
            ))
        }
        403 => AppError::AuthFailed(format!(
            "GitHub denegó el acceso: al token le faltan permisos para esta acción{detail}"
        )),
        404 => AppError::NotFound(
            "el recurso no existe en GitHub o tu token no tiene acceso a él".into(),
        ),
        409 => AppError::Invalid(format!("GitHub indicó un conflicto{detail}")),
        422 => AppError::Invalid(format!("GitHub rechazó los datos{detail}")),
        500..=599 => AppError::Network(format!(
            "GitHub no está respondiendo bien (error {code}). Inténtalo más tarde."
        )),
        _ => AppError::Invalid(format!("GitHub respondió con el error {code}{detail}")),
    }
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| {
        let mut o = String::new();
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                o.push(b as char);
            } else {
                o.push_str(&format!("%{b:02X}"));
            }
        }
        o
    };
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// POST de formulario a github.com (device flow de OAuth). Respuesta en JSON.
pub async fn post_form(url: &str, pairs: &[(&str, &str)]) -> AppResult<Resp> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| AppError::Invalid("dirección no válida".into()))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err(AppError::Invalid(
            "dirección de inicio de sesión no válida".into(),
        ));
    }
    let resp = client()?
        .post(parsed)
        .header(header::ACCEPT, "application/json")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form_encode(pairs))
        .send()
        .await
        .map_err(net_err)?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp.bytes().await.map_err(net_err)?.to_vec();
    let r = Resp {
        status,
        headers,
        body,
    };
    if !status.is_success() {
        return Err(status_error(&r));
    }
    Ok(r)
}

/// Lee una respuesta JSON de la API (atajo).
pub async fn api_json<T: DeserializeOwned>(token: Option<&str>, path: &str) -> AppResult<T> {
    api(token, Method::GET, path, None).await?.json()
}
