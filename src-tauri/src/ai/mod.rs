//! Asistente de IA opcional (v0.5.0): un endpoint compatible con OpenAI (`/chat/completions`) que
//! solo EXPLICA un informe ya hecho. Nunca decide qué es vulnerable ni ejecuta nada.
//!
//! - URL base y modelo en `settings.json` (campo `ai`); el token en la bóveda o el llavero con el id
//!   `ai-token` (`storage::secrets`). Con la bóveda bloqueada no hay IA (`AppError::Locked`).
//! - El HTTP sale de aquí (reqwest + rustls), nunca de la interfaz. HTTPS obligatorio salvo a
//!   `localhost`/`127.0.0.1`/`::1` (modelos locales como Ollama). Sin redirecciones.
//! - El token solo se envía a la URL base guardada en Ajustes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::storage::{secrets, SettingsStore};

/// Id del token en la bóveda o el llavero.
pub const AI_TOKEN_USER: &str = "ai-token";
const CHAT_TIMEOUT: Duration = Duration::from_secs(60);
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BODY: usize = 4 * 1024 * 1024;
/// Límite de lo que se envía (el diálogo ya lo recorta a 60 hallazgos).
const MAX_PROMPT: usize = 200 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub enabled: bool,
    /// p. ej. `https://api.openai.com/v1` o `http://localhost:11434/v1`.
    pub base_url: String,
    pub model: String,
}

impl AiSettings {
    pub fn sanitized(mut self) -> Self {
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        self.model = self.model.trim().to_string();
        self
    }
}

/// Comprueba la URL base: http(s), HTTPS salvo en local, sin usuario/contraseña ni consulta.
pub fn check_base_url(base: &str) -> AppResult<Url> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Invalid("Falta la URL del servicio de IA (Ajustes → Asistente de IA)".into()));
    }
    let url = Url::parse(base).map_err(|_| AppError::Invalid(format!("URL no válida: {base}")))?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1");
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        "http" => return Err(AppError::Invalid("Usa https:// (http solo se permite para localhost)".into())),
        _ => return Err(AppError::Invalid("La URL debe empezar por https://".into())),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Invalid("No pongas usuario ni contraseña en la URL: usa el token".into()));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AppError::Invalid("La URL base no debe llevar «?» ni «#»".into()));
    }
    Ok(url)
}

fn endpoint(base: &Url, path: &str) -> AppResult<Url> {
    let s = format!("{}/{}", base.as_str().trim_end_matches('/'), path);
    Url::parse(&s).map_err(|_| AppError::Invalid("URL no válida".into()))
}

fn client() -> AppResult<&'static Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = Client::builder()
        .user_agent("TerView")
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Network(format!("no se pudo preparar la conexión: {e}")))?;
    Ok(CLIENT.get_or_init(|| c))
}

async fn token() -> AppResult<Option<String>> {
    tokio::task::spawn_blocking(|| secrets::get_secret(AI_TOKEN_USER))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

fn http_error(status: reqwest::StatusCode, body: &[u8]) -> AppError {
    let msg = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_default();
    let msg: String = msg.chars().take(300).collect();
    match status.as_u16() {
        401 | 403 => AppError::AuthFailed(format!("el servicio de IA rechazó el token. {msg}").trim().to_string()),
        404 => AppError::NotFound(format!("el modelo o la ruta en el servicio de IA. {msg}").trim().to_string()),
        429 => AppError::Network(format!("el servicio de IA pide esperar (demasiadas peticiones). {msg}").trim().to_string()),
        s => AppError::Network(format!("el servicio de IA respondió {s}. {msg}").trim().to_string()),
    }
}

async fn send(req: reqwest::RequestBuilder) -> AppResult<Vec<u8>> {
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            AppError::Network("el servicio de IA no respondió a tiempo".into())
        } else {
            AppError::Network(format!("no se pudo hablar con el servicio de IA: {}", e.without_url()))
        }
    })?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(AppError::Network("el servicio de IA intentó redirigir: revisa la URL base".into()));
    }
    let body = resp.bytes().await.map_err(|e| AppError::Network(e.without_url().to_string()))?;
    if body.len() > MAX_BODY {
        return Err(AppError::Network("respuesta de la IA demasiado grande".into()));
    }
    if !status.is_success() {
        return Err(http_error(status, &body));
    }
    Ok(body.to_vec())
}

fn with_auth(req: reqwest::RequestBuilder, token: Option<&str>) -> AppResult<reqwest::RequestBuilder> {
    Ok(match token.filter(|t| !t.is_empty()) {
        Some(t) => {
            let mut v = reqwest::header::HeaderValue::from_str(&format!("Bearer {t}"))
                .map_err(|_| AppError::Invalid("El token tiene caracteres no válidos".into()))?;
            v.set_sensitive(true);
            req.header(reqwest::header::AUTHORIZATION, v)
        }
        None => req,
    })
}

// ───────────── Comandos ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub has_token: bool,
    /// La bóveda está bloqueada: no se puede leer el token.
    pub locked: bool,
}

#[tauri::command]
pub async fn ai_status() -> AppResult<AiStatus> {
    match token().await {
        Ok(t) => Ok(AiStatus { has_token: t.is_some_and(|t| !t.is_empty()), locked: false }),
        Err(AppError::Locked) => Ok(AiStatus { has_token: false, locked: true }),
        Err(e) => Err(e),
    }
}

/// Guarda el token (None o vacío lo borra). Va a la bóveda si existe; si no, al llavero.
#[tauri::command]
pub async fn ai_set_token(token: Option<String>) -> AppResult<()> {
    tokio::task::spawn_blocking(move || match token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(t) => secrets::set_secret(AI_TOKEN_USER, &t),
        None => secrets::delete_secret(AI_TOKEN_USER),
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

#[derive(Deserialize)]
struct ModelsResp {
    #[serde(default)]
    data: Vec<ModelItem>,
}

#[derive(Deserialize)]
struct ModelItem {
    id: String,
}

/// «Probar»: `GET <base>/models` con los ajustes guardados. Devuelve los modelos disponibles.
#[tauri::command]
pub async fn ai_test(settings: State<'_, SettingsStore>) -> AppResult<Vec<String>> {
    let s = settings.get().ai.sanitized();
    let base = check_base_url(&s.base_url)?;
    let tok = token().await?;
    let req = client()?.get(endpoint(&base, "models")?).timeout(MODELS_TIMEOUT);
    let body = send(with_auth(req, tok.as_deref())?).await?;
    let r: ModelsResp = serde_json::from_slice(&body).map_err(|_| AppError::Invalid("El servicio no devolvió una lista de modelos".into()))?;
    let mut ids: Vec<String> = r.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    ids.truncate(200);
    Ok(ids)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ChatReq<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    temperature: f32,
}

#[derive(Deserialize)]
struct ChatResp {
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMsg,
}

#[derive(Deserialize)]
struct ChoiceMsg {
    #[serde(default)]
    content: Option<String>,
}

fn running() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static R: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAnswer {
    pub model: String,
    pub text: String,
}

/// Envía `messages` (lo que el usuario vio y confirmó) a `<base>/chat/completions` con los ajustes
/// guardados. Se cancela con `ai_cancel(request_id)`.
#[tauri::command]
pub async fn ai_chat(settings: State<'_, SettingsStore>, messages: Vec<ChatMessage>, request_id: String) -> AppResult<ChatAnswer> {
    let s = settings.get().ai.sanitized();
    if !s.enabled {
        return Err(AppError::Invalid("El asistente de IA está desactivado (Ajustes → Asistente de IA)".into()));
    }
    if s.model.is_empty() {
        return Err(AppError::Invalid("Falta el modelo (Ajustes → Asistente de IA)".into()));
    }
    let size: usize = messages.iter().map(|m| m.content.len()).sum();
    if size > MAX_PROMPT || messages.is_empty() {
        return Err(AppError::Invalid("El texto a enviar está vacío o es demasiado largo".into()));
    }
    if messages.iter().any(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant")) {
        return Err(AppError::Invalid("Mensaje no válido".into()));
    }
    let base = check_base_url(&s.base_url)?;
    let tok = token().await?;
    let cancel = CancellationToken::new();
    if let Ok(mut m) = running().lock() {
        m.insert(request_id.clone(), cancel.clone());
    }
    let body = ChatReq { model: &s.model, messages: &messages, temperature: 0.2 };
    let req = client()?.post(endpoint(&base, "chat/completions")?).timeout(CHAT_TIMEOUT).json(&body);
    let req = with_auth(req, tok.as_deref())?;
    let result = tokio::select! {
        () = cancel.cancelled() => Err(AppError::Canceled),
        r = send(req) => r,
    };
    if let Ok(mut m) = running().lock() {
        m.remove(&request_id);
    }
    let bytes = result?;
    let r: ChatResp = serde_json::from_slice(&bytes).map_err(|_| AppError::Invalid("Respuesta de la IA inesperada".into()))?;
    let text = r.choices.into_iter().next().and_then(|c| c.message.content).unwrap_or_default();
    if text.trim().is_empty() {
        return Err(AppError::Invalid("La IA no devolvió texto".into()));
    }
    Ok(ChatAnswer { model: s.model, text })
}

#[tauri::command]
pub async fn ai_cancel(request_id: String) -> AppResult<bool> {
    let m = running().lock().map_err(|_| AppError::Invalid("registro bloqueado".into()))?;
    Ok(match m.get(&request_id) {
        Some(t) => {
            t.cancel();
            true
        }
        None => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_rules() {
        assert!(check_base_url("https://api.openai.com/v1").is_ok());
        assert!(check_base_url("http://localhost:11434/v1").is_ok());
        assert!(check_base_url("http://127.0.0.1:8080/v1/").is_ok());
        assert!(check_base_url("http://example.com/v1").is_err());
        assert!(check_base_url("ftp://example.com").is_err());
        assert!(check_base_url("https://user:pw@example.com/v1").is_err());
        assert!(check_base_url("https://example.com/v1?x=1").is_err());
        assert!(check_base_url("").is_err());
        let u = check_base_url("https://api.openai.com/v1/").unwrap();
        assert_eq!(endpoint(&u, "chat/completions").unwrap().as_str(), "https://api.openai.com/v1/chat/completions");
    }

    #[test]
    fn settings_default_off() {
        let s = AiSettings::default();
        assert!(!s.enabled);
        let s = AiSettings { enabled: true, base_url: " https://x.y/v1/ ".into(), model: " m ".into() }.sanitized();
        assert_eq!(s.base_url, "https://x.y/v1");
        assert_eq!(s.model, "m");
    }
}
