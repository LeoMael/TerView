//! Pruebas de punta a punta contra el servidor SSH de pruebas (contenedor `terview-sshd`,
//! 127.0.0.1:2222). El servidor MCP real (HTTP + rmcp) corre con un motor que usa una conexión
//! SSH de verdad; los clientes son el cliente oficial de `rmcp`, JSON-RPC a mano (como curl) y el
//! puente stdio. Ejecutar con:
//! `cargo test --lib mcp::e2e -- --ignored --test-threads=1`

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::approval::{ApprovalRequest, Decision};
use super::audit::{AuditLog, AuditStatus};
use super::backend::Backend;
use super::config::{McpConfig, McpConfigStore};
use super::core::McpCore;
use super::policy::Access;
use super::{bridge, http};
use crate::error::AppResult;
use crate::sftp::{FilePart, SftpStore};
use crate::snippets::{exec, ExecRegistry};
use crate::ssh::connect::testutil::{connect_test_server, test_profile};
use crate::ssh::SessionStore;
use crate::types::{ExecResult, FileEntry, ProfilesData, SessionInfo, Snippet, TransferJob};
use crate::vulnscan::model::Report;
use crate::vulnscan::scan::ScanOptions;
use crate::vulnscan::VulnScanSettings;

const TOKEN: &str = "tv_e2e";

/// Motor con una conexión SSH real al servidor de pruebas.
struct Real {
    sessions: SessionStore,
    sftp: SftpStore,
    registry: ExecRegistry,
    data: ProfilesData,
    asked: Mutex<Vec<ApprovalRequest>>,
    /// Último informe de vulnerabilidades (en memoria: las pruebas no tocan el historial real).
    vuln_saved: Mutex<Option<Report>>,
}

impl Backend for Real {
    fn vault_locked(&self) -> bool {
        false
    }
    fn profiles(&self) -> ProfilesData {
        self.data.clone()
    }
    async fn sessions(&self) -> Vec<SessionInfo> {
        self.sessions.list().await
    }
    async fn exec(&self, sid: &str, command: &str, stdin: Option<&[u8]>, timeout: u32, exec_id: &str) -> AppResult<ExecResult> {
        let ticket = self.registry.register(exec_id)?;
        let s = self.sessions.get(sid).await?;
        exec::run_cancellable(&s, command, stdin, timeout, &ticket.token).await
    }
    fn cancel_exec(&self, exec_id: &str) -> bool {
        self.registry.cancel(exec_id)
    }
    async fn list_dir(&self, sid: &str, path: &str) -> AppResult<Vec<FileEntry>> {
        let s = self.sessions.get(sid).await?;
        self.sftp.list_dir(&s, path).await
    }
    async fn stat(&self, sid: &str, path: &str) -> AppResult<FileEntry> {
        let s = self.sessions.get(sid).await?;
        self.sftp.stat(&s, path).await
    }
    async fn read_part(&self, sid: &str, path: &str, offset: u64, max: u64) -> AppResult<FilePart> {
        let s = self.sessions.get(sid).await?;
        self.sftp.read_part(&s, path, offset, max).await
    }
    async fn write_text(&self, sid: &str, path: &str, content: &str) -> AppResult<FileEntry> {
        let s = self.sessions.get(sid).await?;
        self.sftp.write_text(&s, path, content).await
    }
    async fn upload(&self, _: &str, _: Vec<String>, _: String) -> AppResult<String> {
        Err(crate::error::AppError::Invalid("no en esta prueba".into()))
    }
    async fn download(&self, _: &str, _: Vec<String>, _: String) -> AppResult<String> {
        Err(crate::error::AppError::Invalid("no en esta prueba".into()))
    }
    fn transfers(&self) -> Vec<TransferJob> {
        Vec::new()
    }
    fn snippets(&self) -> Vec<Snippet> {
        Vec::new()
    }
    fn vuln_settings(&self) -> VulnScanSettings {
        VulnScanSettings::default()
    }
    async fn vuln_latest(&self, _: &str) -> AppResult<Option<Report>> {
        Ok(self.vuln_saved.lock().unwrap().clone())
    }
    async fn audit_latest(&self, _: &str) -> AppResult<Option<crate::audit::model::AuditReport>> {
        Ok(None)
    }
    async fn vuln_scan(&self, sid: &str, mut opts: ScanOptions, exec_id: &str, cancel: &CancellationToken) -> AppResult<Report> {
        let ticket = self.registry.register(exec_id)?;
        let s = self.sessions.get(sid).await?;
        let keep = opts.save;
        opts.save = false;
        let r = super::backend::scan_with_stop(&s, &opts, cancel, &ticket.token).await?;
        if keep {
            *self.vuln_saved.lock().unwrap() = Some(r.clone());
        }
        Ok(r)
    }
    async fn ui_request(&self, _: &str, _: Value, _: Duration) -> AppResult<Value> {
        Ok(json!([]))
    }
    async fn ask_approval(&self, req: ApprovalRequest) -> Decision {
        // Aprobador simulado: permite una vez lo que no es peligroso.
        let d = if req.danger.is_empty() { Decision::Once } else { Decision::Deny };
        self.asked.lock().unwrap().push(req);
        d
    }
    fn approval_done(&self, _: &str) {}
}

struct Gate;
impl http::Gate for Gate {
    fn locked(&self) -> bool {
        false
    }
    fn token(&self) -> Option<Zeroizing<String>> {
        Some(Zeroizing::new(TOKEN.into()))
    }
}

struct Env {
    core: Arc<McpCore<Real>>,
    port: u16,
    ct: CancellationToken,
    base: String,
}

async fn start() -> Env {
    let session = connect_test_server().await;
    let sessions = SessionStore::default();
    sessions.insert(session).await;
    let profile = test_profile();
    let mut cfg = McpConfig { enabled: true, ..Default::default() };
    cfg.access.insert(profile.id.clone(), Access::Full);
    let real = Real {
        sessions,
        sftp: SftpStore::default(),
        registry: ExecRegistry::default(),
        data: ProfilesData { servers: vec![profile], projects: vec![] },
        asked: Mutex::new(Vec::new()),
        vuln_saved: Mutex::new(None),
    };
    let core = Arc::new(McpCore::new(real, McpConfigStore::in_memory(cfg), AuditLog::at(None)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let ct = CancellationToken::new();
    tokio::spawn(http::serve(listener, core.clone(), Arc::new(Gate), ct.clone()));
    let base = format!("/config/tmp-mcp-{}", uuid::Uuid::new_v4().simple());
    Env { core, port, ct, base }
}

impl Env {
    async fn cleanup(self) {
        let sid = self.core.backend.sessions.list().await[0].id.clone();
        let s = self.core.backend.sessions.get(&sid).await.unwrap();
        let _ = exec::run(&s, &format!("rm -rf {}", self.base), 10).await;
        self.ct.cancel();
    }
}

fn text_of(r: &rmcp::model::CallToolResult) -> String {
    serde_json::to_value(&r.content).unwrap()[0]["text"].as_str().unwrap_or("").to_string()
}

/// Cliente oficial de `rmcp`: initialize, tools/list y tools/call (list_servers, run_command,
/// archivos) contra SSH real.
#[tokio::test]
#[ignore]
async fn rmcp_client_end_to_end() {
    let env = start().await;
    let url = format!("http://127.0.0.1:{}/mcp", env.port);
    let transport = StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(url).auth_header(TOKEN));
    let client = ClientConfig::default().serve(transport).await.expect("initialize");
    let info = client.peer_info().expect("info del servidor");
    assert_eq!(info.server_info.as_ref().map(|s| s.name.as_str()), Some("sshorus"));

    let tools = client.list_all_tools().await.unwrap();
    assert!(tools.len() >= 19, "{}", tools.len());
    let run = tools.iter().find(|t| t.name == "run_command").unwrap();
    assert_eq!(run.annotations.as_ref().and_then(|a| a.read_only_hint), Some(false));

    let call = |name: &'static str, args: Value| {
        let args = args.as_object().cloned().unwrap_or_default();
        CallToolRequestParams::new(name).with_arguments(args)
    };
    let r = client.call_tool(call("list_servers", json!({}))).await.unwrap();
    let text = text_of(&r);
    assert!(text.contains("Servidor de pruebas") && text.contains("\"connected\": true"), "{text}");

    let r = client
        .call_tool(call("run_command", json!({ "server": "Servidor de pruebas", "command": "echo hola-mcp && id -un" })))
        .await
        .unwrap();
    let text = text_of(&r);
    assert_ne!(r.is_error, Some(true), "{text}");
    assert!(text.contains("Código de salida: 0") && text.contains("hola-mcp") && text.contains("test"), "{text}");

    // Tiempo límite: se corta y se dice.
    let r = client
        .call_tool(call("run_command", json!({ "server": "test-profile", "command": "sleep 20", "timeout_secs": 1 })))
        .await
        .unwrap();
    assert!(text_of(&r).contains("SE CORTÓ POR TIEMPO"), "{}", text_of(&r));

    // Peligroso: el aprobador simulado lo deniega.
    let r = client
        .call_tool(call("run_command", json!({ "server": "test-profile", "command": format!("rm -rf {}", env.base) })))
        .await
        .unwrap();
    assert_eq!(r.is_error, Some(true));
    assert!(text_of(&r).contains("denegó"));

    // Archivos: escribir (con permiso), leer, listar.
    let path = format!("{}/nota.txt", env.base);
    let r = client
        .call_tool(call("run_command", json!({ "server": "test-profile", "command": format!("mkdir -p {}", env.base) })))
        .await
        .unwrap();
    assert_ne!(r.is_error, Some(true));
    let r = client
        .call_tool(call("write_file", json!({ "server": "test-profile", "path": path, "content": "línea 1\nlínea 2\n" })))
        .await
        .unwrap();
    assert_ne!(r.is_error, Some(true), "{}", text_of(&r));
    let r = client.call_tool(call("read_file", json!({ "server": "test-profile", "path": path }))).await.unwrap();
    assert!(text_of(&r).contains("línea 2"), "{}", text_of(&r));
    let r = client.call_tool(call("list_dir", json!({ "server": "test-profile", "path": env.base }))).await.unwrap();
    assert!(text_of(&r).contains("nota.txt"));

    let asked = env.core.backend.asked.lock().unwrap().clone();
    assert!(asked.iter().any(|a| a.tool == "write_file" && a.diff.as_deref().unwrap_or("").contains("+línea 2")));
    let log = env.core.audit.list();
    assert!(log.iter().any(|e| e.tool == "run_command" && e.status == AuditStatus::Ok && e.approved_by.as_deref() == Some("tú: una vez")));
    assert!(log.iter().any(|e| e.tool == "run_command" && e.status == AuditStatus::Denied));

    let _ = client.cancel().await;
    env.cleanup().await;
}

/// JSON-RPC a mano por HTTP (lo mismo que haría `curl`).
#[tokio::test]
#[ignore]
async fn raw_jsonrpc_end_to_end() {
    let env = start().await;
    let http = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/mcp", env.port);
    let post = |body: Value| {
        http.post(&url)
            .header("Authorization", format!("Bearer {TOKEN}"))
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18")
            .json(&body)
            .send()
    };
    let v: Value = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "curl", "version": "1" } } }))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(v["result"]["serverInfo"]["name"], "sshorus");
    let r = post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.unwrap();
    assert_eq!(r.status().as_u16(), 202);
    let v: Value = post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.unwrap().json().await.unwrap();
    assert!(v["result"]["tools"].as_array().unwrap().len() >= 19);
    let v: Value = post(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": "list_servers", "arguments": {} } }))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(v["result"]["content"][0]["text"].as_str().unwrap().contains("test-profile"));
    let v: Value = post(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
        "name": "run_command", "arguments": { "server": "test-profile", "command": "printf 'a%.0s' 1 2 3" } } }))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let text = v["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("aaa"), "{text}");
    env.cleanup().await;
}

/// El puente stdio contra el servidor real.
#[tokio::test]
#[ignore]
async fn stdio_bridge_end_to_end() {
    let env = start().await;
    let (mut w, bridge_in) = tokio::io::duplex(1 << 20);
    let (bridge_out, client_out) = tokio::io::duplex(1 << 20);
    let cfg = bridge::BridgeConfig {
        port: env.port,
        token: Some(TOKEN.into()),
        version: "e2e".into(),
        poll: Duration::from_millis(100),
    };
    tokio::spawn(bridge::run(cfg, BufReader::new(bridge_in), bridge_out));
    let mut lines = BufReader::new(client_out).lines();
    let done = Arc::new(AtomicBool::new(false));
    for (id, msg) in [
        (Some(1), json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "puente-e2e", "version": "1" } } })),
        (None, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
        (Some(2), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })),
        (Some(3), json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "run_command", "arguments": { "server": "test-profile", "command": "echo desde-el-puente" } } })),
    ] {
        w.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
        let Some(id) = id else { continue };
        let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line()).await.unwrap().unwrap().unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["id"], id, "{v}");
        if id == 3 {
            let text = v["result"]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains("desde-el-puente"), "{text}");
            done.store(true, Ordering::SeqCst);
        }
    }
    assert!(done.load(Ordering::SeqCst));
    let log = env.core.audit.list();
    assert!(log[0].client.as_deref().unwrap_or("").contains("puente-e2e"));
    env.cleanup().await;
}

/// Vulnerabilidades por MCP contra el servidor de pruebas (Alpine, sin sudo; consulta OSV.dev, necesita
/// red): sin informe → análisis con permiso → resumen → último informe.
#[tokio::test]
#[ignore]
async fn vuln_tools_end_to_end() {
    let env = start().await;
    let url = format!("http://127.0.0.1:{}/mcp", env.port);
    let transport = StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(url).auth_header(TOKEN));
    let client = ClientConfig::default().serve(transport).await.expect("initialize");
    let call = |name: &'static str, args: Value| {
        let args = args.as_object().cloned().unwrap_or_default();
        CallToolRequestParams::new(name).with_arguments(args)
    };

    let r = client.call_tool(call("get_vuln_report", json!({ "server": "test-profile" }))).await.unwrap();
    assert_ne!(r.is_error, Some(true));
    assert!(text_of(&r).contains("no tiene ningún análisis"), "{}", text_of(&r));

    let r = client
        .call_tool(call("scan_vulnerabilities", json!({ "server": "test-profile", "limit": 5 })))
        .await
        .unwrap();
    let text = text_of(&r);
    assert_ne!(r.is_error, Some(true), "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert!(v["os"].as_str().unwrap_or("").to_lowercase().contains("alpine"), "{text}");
    assert_eq!(v["withSudo"], false);
    assert!(v["summary"]["total"].is_u64());
    assert!(v["topFindings"].as_array().unwrap().len() <= 5);
    assert!(v["sources"].as_array().unwrap().iter().any(|s| s["name"] == "OSV.dev" && s["used"] == true), "{text}");
    eprintln!("scan_vulnerabilities: {}", v["summary"]["text"]);

    let asked = env.core.backend.asked.lock().unwrap().clone();
    assert!(asked.iter().any(|a| a.tool == "scan_vulnerabilities" && a.can_remember));

    let r = client.call_tool(call("get_vuln_report", json!({ "server": "test-profile" }))).await.unwrap();
    let v2: Value = serde_json::from_str(&text_of(&r)).unwrap();
    assert_eq!(v2["reportId"], v["reportId"]);

    let _ = client.cancel().await;
    env.cleanup().await;
}

/// Envoltorio de sudo (`sudo.rs`) por un canal exec real. El servidor de pruebas es Alpine (el script lo
/// ejecuta busybox sh; /dev/shm es noexec, así que se usa /tmp) y su usuario `test` no tiene sudo: el
/// camino bueno se prueba con el sudo simulado de `tests.rs` delante en PATH, y el sudo real, con los
/// rechazos (contraseña incorrecta y «no tiene permiso»).
#[tokio::test]
#[ignore]
async fn sudo_wrapper_on_real_server() {
    use super::sudo::{failure, wrap, SudoFailure};
    use super::tests::{FAKE_SUDO, SUDO_PW};
    use crate::ssh::connect::testutil::TEST_PASSWORD;

    let s = connect_test_server().await;
    let base = format!("/config/tmp-mcp-sudo-{}", uuid::Uuid::new_v4().simple());
    let setup = format!("mkdir -p {base}/bin {base}/work && cat > {base}/bin/sudo && chmod 755 {base}/bin/sudo");
    let r = exec::run_with_stdin(&s, &setup, FAKE_SUDO.as_bytes(), 10).await.unwrap();
    assert_eq!(r.exit_code, Some(0), "{}", r.stderr);
    let r = exec::run_with_stdin(&s, &format!("cat > {base}/pw"), SUDO_PW.as_bytes(), 10).await.unwrap();
    assert_eq!(r.exit_code, Some(0), "{}", r.stderr);

    // Camino bueno (sudo simulado): tubería, sudo dentro de sh y varios sudo en la misma línea.
    let cmd = format!(
        "echo hola | sudo tee {base}/work/x >/dev/null && sudo sh -c 'cat {base}/work/x' && sudo whoami && sudo sh -c 'sleep 2'"
    );
    let w = wrap(&cmd, SUDO_PW).unwrap();
    let full = format!("PATH={base}/bin:$PATH TV_FAKE_DIR={base} {}", w.command);
    let run = exec::run_with_stdin(&s, &full, &w.stdin, 30);
    // Mientras corre, la contraseña no está en la línea de comandos de ningún proceso.
    let ps = async {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        exec::run(&s, "ps -o args 2>/dev/null || ps -ef", 10).await.unwrap()
    };
    let (r, ps) = tokio::join!(run, ps);
    let r = r.unwrap();
    assert_eq!(r.exit_code, Some(0), "{}", r.stderr);
    assert_eq!(r.stdout, "hola\nroot\n");
    assert!(ps.stdout.contains("sleep 2"), "{}", ps.stdout);
    assert!(!ps.stdout.contains("s3cr3t"), "{}", ps.stdout);
    assert!(!r.stdout.contains("s3cr3t") && !r.stderr.contains("s3cr3t"));
    let r = exec::run(&s, &format!("cat {base}/log; ls -a /tmp /dev/shm"), 10).await.unwrap();
    assert_eq!(r.stdout.matches("ok S").count(), 1, "{}", r.stdout);
    assert_eq!(r.stdout.matches("ok A").count(), 4, "{}", r.stdout);
    assert!(!r.stdout.contains("bad"), "{}", r.stdout);
    assert!(!r.stdout.contains(".sshorus-sudo."), "quedaron archivos temporales:\n{}", r.stdout);

    // Varios sudo a la vez (tubería).
    let w = wrap("sudo whoami | sudo cat | sudo cat | sudo cat", SUDO_PW).unwrap();
    let full = format!("PATH={base}/bin:$PATH TV_FAKE_DIR={base} {}", w.command);
    let r = exec::run_with_stdin(&s, &full, &w.stdin, 30).await.unwrap();
    assert_eq!((r.exit_code, r.stdout.as_str()), (Some(0), "root\n"), "{}", r.stderr);

    // Tiempo límite: se detiene en el servidor y la carpeta temporal se borra igual.
    let w = wrap("sudo sh -c 'sleep 30'", SUDO_PW).unwrap();
    let full = format!("PATH={base}/bin:$PATH TV_FAKE_DIR={base} {}", w.command);
    let r = exec::run_with_stdin(&s, &full, &w.stdin, 2).await.unwrap();
    assert!(r.timed_out, "{r:?}");
    let r = exec::run(&s, "sleep 1; ls -a /tmp /dev/shm; ps -o args 2>/dev/null || ps -ef", 10).await.unwrap();
    assert!(!r.stdout.contains(".sshorus-sudo."), "quedaron archivos temporales:\n{}", r.stdout);
    assert!(!r.stdout.contains("sleep 30"), "{}", r.stdout);

    // Contraseña incorrecta (sudo simulado): rechazo rápido, con un solo intento y sin ejecutar nada.
    let w = wrap("sudo whoami; echo no-debe-llegar", "incorrecta").unwrap();
    let full = format!("PATH={base}/bin:$PATH TV_FAKE_DIR={base} {}", w.command);
    let started = std::time::Instant::now();
    let r = exec::run_with_stdin(&s, &full, &w.stdin, 30).await.unwrap();
    assert_eq!(failure(r.exit_code, &r.stderr), Some(SudoFailure::BadPassword), "{r:?}");
    assert!(!r.stdout.contains("no-debe-llegar"));
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    let r = exec::run(&s, &format!("cat {base}/log"), 10).await.unwrap();
    assert_eq!(r.stdout.matches("bad S").count(), 1, "{}", r.stdout);

    // sudo real: `test` no está en sudoers → «no tiene permiso», con cualquier contraseña.
    for pw in [TEST_PASSWORD, "incorrecta"] {
        let w = wrap("sudo whoami", pw).unwrap();
        let r = exec::run_with_stdin(&s, &w.command, &w.stdin, 30).await.unwrap();
        assert_eq!(failure(r.exit_code, &r.stderr), Some(SudoFailure::Denied), "{r:?}");
        assert!(!r.stderr.contains(pw));
    }

    let _ = exec::run(&s, &format!("rm -rf {base}"), 10).await;
}
