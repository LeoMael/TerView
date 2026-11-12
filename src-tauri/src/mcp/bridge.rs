//! Puente stdio → HTTP local (`terview-mcp`).
//!
//! Muchos clientes MCP (Claude Desktop, Claude Code con `--transport stdio`) arrancan el servidor
//! como un programa y le hablan por stdin/stdout. Este puente no sabe nada de herramientas: reenvía
//! cada mensaje JSON-RPC a la app abierta (`http://127.0.0.1:<puerto>/mcp` con el token) y escribe
//! las respuestas. Así hay UNA sola implementación de permisos, aprobación y registro: la de la app.
//!
//! - Token: variable `TERVIEW_MCP_TOKEN` (la configuración que copia TerView ya la lleva).
//! - Puerto: `TERVIEW_MCP_PORT`, o el de `<config>/terview/mcp.json`, o 47821.
//! - Si la app está cerrada: responde `initialize` él mismo y ofrece una sola herramienta que
//!   explica «Abre TerView para usar tus servidores». Cuando la app aparece, avisa al cliente con
//!   `notifications/tools/list_changed` para que vuelva a pedir la lista.
//!
//! Este archivo se compila dos veces: dentro de la app (para las pruebas) y en el binario
//! `src/bin/terview-mcp.rs` (con `#[path]`). Por eso solo usa crates externos, nada de `crate::`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

pub const CLOSED_MSG: &str = "Abre TerView para usar tus servidores.";
pub const DEFAULT_PORT: u16 = 47821;
const PLACEHOLDER_TOOL: &str = "terview_abrir";
/// Versión de protocolo si el cliente no dice ninguna.
const FALLBACK_PROTOCOL: &str = "2025-06-18";

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub port: u16,
    pub token: Option<String>,
    pub version: String,
    /// Cada cuánto se mira si la app ya está abierta (tras responder «cerrada»).
    pub poll: Duration,
}

impl BridgeConfig {
    /// Lee el entorno y `mcp.json`.
    pub fn from_env(version: &str) -> Self {
        let token = std::env::var("TERVIEW_MCP_TOKEN").ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let port = std::env::var("TERVIEW_MCP_PORT")
            .ok()
            .and_then(|p| p.trim().parse::<u16>().ok())
            .or_else(port_from_config)
            .unwrap_or(DEFAULT_PORT);
        BridgeConfig { port, token, version: version.to_string(), poll: Duration::from_secs(2) }
    }
}

fn port_from_config() -> Option<u16> {
    let path = dirs::config_dir()?.join("terview").join("mcp.json");
    let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    v.get("port")?.as_u64().and_then(|p| u16::try_from(p).ok())
}

/// Estado compartido entre los mensajes.
#[derive(Default)]
struct Shared {
    /// Versión acordada en `initialize` (se manda en cada petición).
    protocol: Option<String>,
    /// Nombre del cliente (va en el User-Agent: queda en el registro de TerView).
    client: Option<String>,
    /// Ya se está vigilando a que abra la app.
    watching: bool,
}

/// Qué pasó al reenviar.
enum Sent {
    /// Mensajes JSON-RPC de respuesta (ya en una línea cada uno).
    Messages(Vec<String>),
    /// La app no está abierta (no hay nadie en el puerto).
    Closed,
    /// La app respondió con un error HTTP (token incorrecto…).
    HttpError(String),
}

fn error_msg(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn result_msg(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

/// Ejecuta el puente hasta que se cierre la entrada.
pub async fn run<R, W>(cfg: BridgeConfig, input: R, output: W)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut output = output;
        while let Some(line) = rx.recv().await {
            if output.write_all(line.as_bytes()).await.is_err()
                || output.write_all(b"\n").await.is_err()
                || output.flush().await.is_err()
            {
                break;
            }
        }
    });
    let cfg = Arc::new(cfg);
    let shared = Arc::new(Mutex::new(Shared::default()));
    let inflight: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>> = Arc::default();
    let mut lines = input.lines();
    let mut tasks = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = tx.send(error_msg(&Value::Null, -32700, &format!("JSON no válido: {e}")));
                continue;
            }
        };
        // Cancelación: se corta la petición en curso (la app detiene lo que hacía).
        if msg.get("method").and_then(Value::as_str) == Some("notifications/cancelled")
            && let Some(id) = msg.pointer("/params/requestId")
            && let Some(h) = inflight.lock().unwrap_or_else(|p| p.into_inner()).remove(&id.to_string())
        {
            h.abort();
        }
        let key = msg.get("id").filter(|_| msg.get("method").is_some()).map(Value::to_string);
        let (cfg, shared, tx2, inflight2) = (cfg.clone(), shared.clone(), tx.clone(), inflight.clone());
        let key2 = key.clone();
        let handle = tasks.spawn(async move {
            handle_message(&cfg, &shared, &tx2, msg, line).await;
            if let Some(k) = key2 {
                inflight2.lock().unwrap_or_else(|p| p.into_inner()).remove(&k);
            }
        });
        if let Some(k) = key {
            inflight.lock().unwrap_or_else(|p| p.into_inner()).insert(k, handle);
        }
        // Libera las tareas ya terminadas.
        while tasks.try_join_next().is_some() {}
    }
    // Entrada cerrada: se espera a lo que estaba en marcha y se termina.
    while tasks.join_next().await.is_some() {}
    drop(tx);
    let _ = writer.await;
}

async fn handle_message(cfg: &Arc<BridgeConfig>, shared: &Arc<Mutex<Shared>>, tx: &mpsc::UnboundedSender<String>, msg: Value, raw: String) {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let id = msg.get("id").cloned();
    let is_request = id.is_some() && !method.is_empty();
    if method == "initialize"
        && let Some(name) = msg.pointer("/params/clientInfo/name").and_then(Value::as_str)
    {
        shared.lock().unwrap_or_else(|p| p.into_inner()).client = Some(name.chars().take(60).collect());
    }
    // La herramienta de aviso solo existe en el puente.
    if method == "tools/call" && msg.pointer("/params/name").and_then(Value::as_str) == Some(PLACEHOLDER_TOOL) {
        if let Some(id) = &id {
            let open = app_is_open(cfg.port).await;
            let text = if open {
                "TerView ya está abierto: vuelve a pedir la lista de herramientas (tools/list)."
            } else {
                CLOSED_MSG
            };
            let _ = tx.send(result_msg(id, json!({ "content": [{ "type": "text", "text": text }], "isError": !open })));
        }
        return;
    }
    let Some(token) = cfg.token.as_deref() else {
        if let Some(id) = id.filter(|_| is_request) {
            let _ = tx.send(error_msg(
                &id,
                -32000,
                "Falta la variable TERVIEW_MCP_TOKEN: copia la configuración desde TerView → Ajustes → Asistentes de IA (MCP).",
            ));
        }
        return;
    };
    let (protocol, client) = {
        let s = shared.lock().unwrap_or_else(|p| p.into_inner());
        (s.protocol.clone(), s.client.clone())
    };
    let sent = post(cfg, token, protocol.as_deref(), client.as_deref(), raw).await;
    match sent {
        Sent::Messages(list) => {
            for line in list {
                if method == "initialize"
                    && let Ok(v) = serde_json::from_str::<Value>(&line)
                    && let Some(pv) = v.pointer("/result/protocolVersion").and_then(Value::as_str)
                {
                    shared.lock().unwrap_or_else(|p| p.into_inner()).protocol = Some(pv.to_string());
                }
                let _ = tx.send(line);
            }
        }
        Sent::HttpError(m) => {
            if let Some(id) = id.filter(|_| is_request) {
                let _ = tx.send(error_msg(&id, -32000, &m));
            }
        }
        Sent::Closed => {
            let Some(id) = id.filter(|_| is_request) else { return };
            match method.as_str() {
                "initialize" => {
                    let pv = msg
                        .pointer("/params/protocolVersion")
                        .and_then(Value::as_str)
                        .unwrap_or(FALLBACK_PROTOCOL)
                        .to_string();
                    let _ = tx.send(result_msg(
                        &id,
                        json!({
                            "protocolVersion": pv,
                            "capabilities": { "tools": { "listChanged": true } },
                            "serverInfo": { "name": "terview", "version": cfg.version },
                            "instructions": format!("TerView está cerrado. {CLOSED_MSG} Las herramientas aparecerán solas cuando se abra."),
                        }),
                    ));
                }
                "ping" => {
                    let _ = tx.send(result_msg(&id, json!({})));
                }
                "tools/list" => {
                    let _ = tx.send(result_msg(
                        &id,
                        json!({ "tools": [{
                            "name": PLACEHOLDER_TOOL,
                            "description": format!("TerView está cerrado. {CLOSED_MSG} Llama a esta herramienta para comprobarlo de nuevo."),
                            "inputSchema": { "type": "object", "properties": {} },
                        }] }),
                    ));
                    watch_for_app(cfg.clone(), shared.clone(), tx.clone());
                }
                _ => {
                    let _ = tx.send(error_msg(&id, -32000, CLOSED_MSG));
                }
            }
        }
    }
}

/// Cuando la app se abra, avisa al cliente de que cambió la lista de herramientas.
fn watch_for_app(cfg: Arc<BridgeConfig>, shared: Arc<Mutex<Shared>>, tx: mpsc::UnboundedSender<String>) {
    {
        let mut s = shared.lock().unwrap_or_else(|p| p.into_inner());
        if s.watching {
            return;
        }
        s.watching = true;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(cfg.poll).await;
            if tx.is_closed() {
                break;
            }
            if app_is_open(cfg.port).await {
                let _ = tx.send(json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }).to_string());
                break;
            }
        }
        shared.lock().unwrap_or_else(|p| p.into_inner()).watching = false;
    });
}

async fn app_is_open(port: u16) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(("127.0.0.1", port))).await,
        Ok(Ok(_))
    )
}

/// Envía un mensaje a la app y devuelve lo que contestó.
async fn post(cfg: &BridgeConfig, token: &str, protocol: Option<&str>, client: Option<&str>, body: String) -> Sent {
    let stream = match TcpStream::connect(("127.0.0.1", cfg.port)).await {
        Ok(s) => s,
        Err(_) => return Sent::Closed,
    };
    let (mut sender, conn) = match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await {
        Ok(v) => v,
        Err(_) => return Sent::Closed,
    };
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let ua = match client {
        Some(c) => format!("terview-mcp/{} ({c})", cfg.version),
        None => format!("terview-mcp/{}", cfg.version),
    };
    let mut req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/mcp")
        .header(http::header::HOST, format!("127.0.0.1:{}", cfg.port))
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(http::header::ACCEPT, "application/json, text/event-stream")
        .header(http::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(http::header::USER_AGENT, ua);
    if let Some(pv) = protocol {
        req = req.header("MCP-Protocol-Version", pv);
    }
    let req = match req.body(Full::new(Bytes::from(body))) {
        Ok(r) => r,
        Err(e) => return Sent::HttpError(format!("petición no válida: {e}")),
    };
    let resp = match sender.send_request(req).await {
        Ok(r) => r,
        Err(_) => return Sent::Closed,
    };
    let status = resp.status();
    let is_sse = resp
        .headers()
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    let mut body = resp.into_body();
    if status == http::StatusCode::ACCEPTED {
        return Sent::Messages(Vec::new());
    }
    if !status.is_success() {
        let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
        let msg = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| format!("TerView respondió {status}"));
        return Sent::HttpError(msg);
    }
    let mut out = Vec::new();
    if is_sse {
        let mut sse = SseParser::default();
        while let Some(frame) = body.frame().await {
            let Ok(frame) = frame else { break };
            if let Some(data) = frame.data_ref() {
                out.extend(sse.push(data));
            }
        }
        out.extend(sse.finish());
    } else {
        let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
        if let Some(line) = one_line(&bytes) {
            out.push(line);
        }
    }
    Sent::Messages(out)
}

/// JSON en una sola línea (los mensajes por stdio van uno por línea).
fn one_line(bytes: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    Some(v.to_string())
}

/// Lector de eventos SSE: junta las líneas `data:` de cada evento.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    /// Añade bytes y devuelve los mensajes completos.
    pub fn push(&mut self, data: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            let text = String::from_utf8_lossy(&self.buf).replace("\r\n", "\n");
            let Some(end) = text.find("\n\n") else { break };
            let event = text[..end].to_string();
            let rest = text[end + 2..].as_bytes().to_vec();
            self.buf = rest;
            if let Some(m) = Self::event_data(&event) {
                out.push(m);
            }
        }
        out
    }

    /// Último evento sin línea en blanco al final.
    pub fn finish(&mut self) -> Vec<String> {
        let text = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).replace("\r\n", "\n");
        Self::event_data(text.trim_end()).into_iter().collect()
    }

    fn event_data(event: &str) -> Option<String> {
        let data: Vec<&str> = event
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| d.strip_prefix(' ').unwrap_or(d))
            .collect();
        if data.is_empty() {
            return None;
        }
        one_line(data.join("\n").as_bytes())
    }
}
