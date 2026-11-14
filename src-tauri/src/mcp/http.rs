//! Transporte HTTP «streamable» local: solo `127.0.0.1`, ruta `/mcp`, con token.
//!
//! Antes de llegar al SDK, cada petición pasa por aquí:
//! 1. Con cabecera `Origin` (una página web) → 403. Ningún cliente MCP de escritorio la manda.
//! 2. Si SSHorus está bloqueado → error JSON-RPC «SSHorus está bloqueado: desbloquéalo para
//!    continuar» (sin bóveda abierta tampoco se puede leer el token para comprobarlo).
//! 3. `Authorization: Bearer <token>` debe coincidir (comparación en tiempo constante) → si no, 401.
//!
//! El SDK (`rmcp`) va sin sesiones y responde en JSON: cada petición es independiente, así el
//! puente stdio solo tiene que reenviar mensajes.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_service::Service;
use zeroize::Zeroizing;

use super::backend::Backend;
use super::core::{McpCore, LOCKED_MSG};
use super::server::SshorusMcp;

pub const MCP_PATH: &str = "/mcp";
/// Tamaño máximo de una petición (el contenido de `write_file` va dentro).
const MAX_BODY: usize = 4 * 1024 * 1024;

type Body = BoxBody<Bytes, Infallible>;

/// Lo que el transporte necesita saber del estado de SSHorus.
pub trait Gate: Send + Sync + 'static {
    /// SSHorus está bloqueado.
    fn locked(&self) -> bool;
    /// Token esperado (None = no hay token configurado o no se pudo leer).
    fn token(&self) -> Option<Zeroizing<String>>;
}

/// Compara sin cortar en la primera diferencia (no da pistas por el tiempo).
pub fn same_token(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= usize::from(x ^ y);
    }
    diff == 0
}

fn text_response(status: StatusCode, msg: &str) -> Response<Body> {
    let body = json!({ "error": msg }).to_string();
    let mut r = Response::new(Full::new(Bytes::from(body)).boxed());
    *r.status_mut() = status;
    r.headers_mut()
        .insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static("application/json"));
    r
}

/// Respuesta JSON-RPC de error para cada petición del cuerpo (o 202 si solo hay notificaciones).
fn jsonrpc_error_response(body: &[u8], message: &str) -> Response<Body> {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let one = |m: &Value| -> Option<Value> {
        let id = m.get("id")?;
        m.get("method")?;
        Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } }))
    };
    let out: Vec<Value> = match &parsed {
        Value::Array(items) => items.iter().filter_map(one).collect(),
        Value::Null => vec![json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": message } })],
        m => one(m).into_iter().collect(),
    };
    if out.is_empty() {
        let mut r = Response::new(Full::new(Bytes::new()).boxed());
        *r.status_mut() = StatusCode::ACCEPTED;
        return r;
    }
    let body = if parsed.is_array() { Value::Array(out).to_string() } else { out[0].to_string() };
    let mut r = Response::new(Full::new(Bytes::from(body)).boxed());
    r.headers_mut()
        .insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static("application/json"));
    r
}

fn bearer(req: &Request<Incoming>) -> Option<&str> {
    let v = req.headers().get(http::header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = v.trim().split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(token.trim())
}

/// Servicio del SDK, sin sesiones y con respuestas JSON.
pub fn mcp_service<B: Backend>(
    core: Arc<McpCore<B>>,
    ct: CancellationToken,
) -> StreamableHttpService<SshorusMcp<B>, NeverSessionManager> {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .with_max_request_body_bytes(MAX_BODY)
        .with_cancellation_token(ct);
    StreamableHttpService::new(
        move || Ok(SshorusMcp::new(core.clone())),
        Arc::new(NeverSessionManager::default()),
        config,
    )
}

async fn handle<B: Backend>(
    req: Request<Incoming>,
    svc: StreamableHttpService<SshorusMcp<B>, NeverSessionManager>,
    gate: Arc<dyn Gate>,
) -> Result<Response<Body>, Infallible> {
    if req.uri().path() != MCP_PATH {
        return Ok(text_response(StatusCode::NOT_FOUND, "Ruta desconocida: usa /mcp"));
    }
    if req.headers().contains_key(http::header::ORIGIN) {
        return Ok(text_response(StatusCode::FORBIDDEN, "SSHorus no acepta peticiones de páginas web"));
    }
    if gate.locked() {
        if req.method() != http::Method::POST {
            return Ok(text_response(StatusCode::SERVICE_UNAVAILABLE, LOCKED_MSG));
        }
        let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
            Ok(b) => b.to_bytes(),
            Err(_) => return Ok(text_response(StatusCode::PAYLOAD_TOO_LARGE, "Petición demasiado grande")),
        };
        return Ok(jsonrpc_error_response(&body, LOCKED_MSG));
    }
    // Leer el token puede tocar el llavero del sistema (bloqueante): fuera del hilo async.
    let g = gate.clone();
    let expected = tokio::task::spawn_blocking(move || g.token()).await.ok().flatten();
    let Some(expected) = expected else {
        return Ok(text_response(
            StatusCode::UNAUTHORIZED,
            "SSHorus aún no tiene token para asistentes: genera uno en Ajustes → Asistentes de IA (MCP)",
        ));
    };
    match bearer(&req) {
        Some(t) if same_token(t, &expected) => {}
        _ => {
            return Ok(text_response(
                StatusCode::UNAUTHORIZED,
                "Token incorrecto o ausente: copia la configuración de SSHorus → Ajustes → Asistentes de IA (MCP)",
            ))
        }
    }
    let mut svc = svc;
    svc.call(req).await
}

/// Atiende conexiones hasta que `ct` se cancele.
pub async fn serve<B: Backend>(listener: TcpListener, core: Arc<McpCore<B>>, gate: Arc<dyn Gate>, ct: CancellationToken) {
    let svc = mcp_service(core, ct.child_token());
    loop {
        let (stream, peer) = tokio::select! {
            () = ct.cancelled() => break,
            r = listener.accept() => match r {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("MCP: no se pudo aceptar una conexión: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    continue;
                }
            },
        };
        if !is_loopback(&peer) {
            continue;
        }
        let svc = svc.clone();
        let gate = gate.clone();
        let ct = ct.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| handle(req, svc.clone(), gate.clone()));
            let conn = http1::Builder::new().serve_connection(TokioIo::new(stream), service);
            tokio::pin!(conn);
            let mut closing = false;
            loop {
                tokio::select! {
                    r = conn.as_mut() => {
                        if let Err(e) = r {
                            log::debug!("MCP: conexión terminada: {e}");
                        }
                        break;
                    }
                    () = ct.cancelled(), if !closing => {
                        closing = true;
                        conn.as_mut().graceful_shutdown();
                    }
                }
            }
        });
    }
}

fn is_loopback(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}
