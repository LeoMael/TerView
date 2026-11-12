//! Pruebas de la lógica del MCP con un motor simulado (sin Tauri ni red SSH):
//! permisos, aprobación, bloqueo, token, comandos peligrosos, límites de salida, registro,
//! transporte HTTP y puente stdio.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::approval::{ApprovalRequest, Decision};
use super::audit::{AuditLog, AuditStatus};
use super::backend::Backend;
use super::config::{McpConfig, McpConfigStore};
use super::core::{CatalogEntry, McpCore, ToolOutput, DISABLED_MSG, LOCKED_MSG};
use super::policy::{self, Access, Action, Verdict};
use super::{bridge, diff, http, template};
use crate::error::{AppError, AppResult};
use crate::sftp::FilePart;
use crate::types::{
    AuthMethod, ExecResult, FileEntry, FileKind, ProfilesData, Project, ServerProfile, SessionInfo, Snippet,
    TransferJob,
};

// ───────────────────────── Motor simulado ─────────────────────────

#[derive(Clone, Copy)]
enum Answer {
    Give(Decision),
    /// Nadie responde (para el tiempo límite).
    Never,
}

struct Mock {
    locked: AtomicBool,
    /// Se bloquea TerView justo al preguntar (bloqueo mientras se espera la respuesta).
    lock_on_ask: AtomicBool,
    data: ProfilesData,
    sessions: Vec<SessionInfo>,
    answer: Mutex<Answer>,
    asked: Mutex<Vec<ApprovalRequest>>,
    ran: Mutex<Vec<String>>,
    stdout: Mutex<String>,
    files: Mutex<HashMap<String, String>>,
    ui_calls: Mutex<Vec<String>>,
}

fn server(id: &str, name: &str) -> ServerProfile {
    ServerProfile {
        id: id.into(),
        name: name.into(),
        host: format!("{name}.ejemplo"),
        port: 22,
        username: "deploy".into(),
        auth: AuthMethod::Password,
        key_path: None,
        default_path: None,
        color: None,
        tmux: None,
        sudo_mode: Default::default(),
    }
}

fn session(id: &str, profile: &str) -> SessionInfo {
    SessionInfo {
        id: id.into(),
        profile_id: profile.into(),
        name: profile.into(),
        host: "h".into(),
        port: 22,
        username: "deploy".into(),
        connected_at: 1,
    }
}

impl Mock {
    fn new() -> Self {
        Mock {
            locked: AtomicBool::new(false),
            lock_on_ask: AtomicBool::new(false),
            data: ProfilesData {
                servers: vec![server("s-full", "web-prod"), server("s-read", "db-server"), server("s-none", "vps-personal")],
                projects: vec![Project {
                    id: "p1".into(),
                    name: "Cliente X".into(),
                    server_ids: vec!["s-full".into(), "s-none".into()],
                    bookmarks: vec![],
                    color: None,
                }],
            },
            sessions: vec![session("ss-full", "s-full"), session("ss-read", "s-read"), session("ss-none", "s-none")],
            answer: Mutex::new(Answer::Give(Decision::Once)),
            asked: Mutex::new(Vec::new()),
            ran: Mutex::new(Vec::new()),
            stdout: Mutex::new("hola\n".into()),
            files: Mutex::new(HashMap::new()),
            ui_calls: Mutex::new(Vec::new()),
        }
    }
}

fn entry(path: &str, size: u64) -> FileEntry {
    FileEntry {
        name: path.rsplit('/').next().unwrap_or("").into(),
        path: path.into(),
        kind: FileKind::File,
        is_dir_link: false,
        size,
        modified: None,
        permissions: Some(0o644),
        permissions_str: "-rw-r--r--".into(),
        uid: None,
        gid: None,
    }
}

impl Backend for Mock {
    fn vault_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }
    fn profiles(&self) -> ProfilesData {
        self.data.clone()
    }
    async fn sessions(&self) -> Vec<SessionInfo> {
        self.sessions.clone()
    }
    async fn exec(&self, _sid: &str, command: &str, _t: u32, _id: &str) -> AppResult<ExecResult> {
        self.ran.lock().unwrap().push(command.to_string());
        Ok(ExecResult {
            stdout: self.stdout.lock().unwrap().clone(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 5,
            truncated: false,
            timed_out: false,
        })
    }
    fn cancel_exec(&self, _id: &str) -> bool {
        false
    }
    async fn list_dir(&self, _sid: &str, path: &str) -> AppResult<Vec<FileEntry>> {
        Ok(vec![entry(&format!("{path}/a.txt"), 3)])
    }
    async fn stat(&self, _sid: &str, path: &str) -> AppResult<FileEntry> {
        Ok(entry(path, 3))
    }
    async fn read_part(&self, _sid: &str, path: &str, offset: u64, max: u64) -> AppResult<FilePart> {
        let files = self.files.lock().unwrap();
        let text = files.get(path).ok_or_else(|| AppError::NotFound(path.into()))?;
        let bytes = text.as_bytes();
        let start = (offset as usize).min(bytes.len());
        let end = (start + max as usize).min(bytes.len());
        Ok(FilePart { path: path.into(), size: bytes.len() as u64, offset, data: bytes[start..end].to_vec() })
    }
    async fn write_text(&self, _sid: &str, path: &str, content: &str) -> AppResult<FileEntry> {
        self.files.lock().unwrap().insert(path.into(), content.into());
        Ok(entry(path, content.len() as u64))
    }
    async fn upload(&self, _sid: &str, _l: Vec<String>, _r: String) -> AppResult<String> {
        Ok("lote-1".into())
    }
    async fn download(&self, _sid: &str, _r: Vec<String>, _l: String) -> AppResult<String> {
        Ok("lote-2".into())
    }
    fn transfers(&self) -> Vec<TransferJob> {
        Vec::new()
    }
    fn snippets(&self) -> Vec<Snippet> {
        Vec::new()
    }
    async fn ui_request(&self, kind: &str, _payload: Value, _t: Duration) -> AppResult<Value> {
        self.ui_calls.lock().unwrap().push(kind.to_string());
        match kind {
            "connect" => Ok(json!({ "sessionId": "nueva" })),
            "ports" => Ok(json!({ "tool": "ss", "ports": [{ "port": 22 }] })),
            _ => Err(AppError::Invalid("no disponible".into())),
        }
    }
    async fn ask_approval(&self, req: ApprovalRequest) -> Decision {
        self.asked.lock().unwrap().push(req);
        if self.lock_on_ask.load(Ordering::SeqCst) {
            self.locked.store(true, Ordering::SeqCst);
        }
        let answer = *self.answer.lock().unwrap();
        match answer {
            Answer::Give(d) => d,
            Answer::Never => std::future::pending().await,
        }
    }
    fn approval_done(&self, _id: &str) {}
}

fn config() -> McpConfig {
    let mut c = McpConfig { enabled: true, ..Default::default() };
    c.access.insert("s-full".into(), Access::Full);
    c.access.insert("s-read".into(), Access::Read);
    c
}

fn core_with(mock: Mock, cfg: McpConfig) -> McpCore<Mock> {
    let core = McpCore::new(mock, McpConfigStore::in_memory(cfg), AuditLog::at(None));
    core.set_catalog(vec![
        CatalogEntry {
            id: "podman.ps".into(),
            category: "Podman".into(),
            name: "Contenedores".into(),
            description: None,
            command: "podman ps -a".into(),
            dangerous: false,
            sudo: false,
            read_only: true,
            interactive: false,
            scope: None,
        },
        CatalogEntry {
            id: "podman.logs".into(),
            category: "Podman".into(),
            name: "Logs".into(),
            description: None,
            command: "podman logs --tail {{lineas:100}} {{contenedor}}".into(),
            dangerous: false,
            sudo: false,
            read_only: true,
            interactive: false,
            scope: None,
        },
        CatalogEntry {
            id: "podman.restart".into(),
            category: "Podman".into(),
            name: "Reiniciar".into(),
            description: None,
            command: "podman restart {{contenedor}}".into(),
            dangerous: false,
            sudo: false,
            read_only: false,
            interactive: false,
            scope: None,
        },
        CatalogEntry {
            id: "podman.prune".into(),
            category: "Podman".into(),
            name: "Limpiar".into(),
            description: None,
            command: "podman system prune -f".into(),
            dangerous: true,
            sudo: false,
            read_only: false,
            interactive: false,
            scope: None,
        },
    ]);
    core
}

fn core() -> McpCore<Mock> {
    core_with(Mock::new(), config())
}

async fn call(core: &McpCore<Mock>, tool: &str, args: Value) -> ToolOutput {
    core.call(tool, args, Some("prueba".into()), CancellationToken::new()).await
}

fn asked(core: &McpCore<Mock>) -> usize {
    core.backend.asked.lock().unwrap().len()
}

fn ran(core: &McpCore<Mock>) -> Vec<String> {
    core.backend.ran.lock().unwrap().clone()
}

fn set_answer(core: &McpCore<Mock>, a: Answer) {
    *core.backend.answer.lock().unwrap() = a;
}

// ───────────────────────── Reglas ─────────────────────────

#[test]
fn policy_levels() {
    let empty = Default::default();
    let read = Action::read("list_dir");
    let change = Action::change("run_command\nls");
    let dl = Action::change_on_read("download");
    assert!(matches!(policy::decide("x", Access::None, &read, &empty), Verdict::Deny(_)));
    assert_eq!(policy::decide("x", Access::Read, &read, &empty), Verdict::Allow(policy::AUTO_READ));
    assert!(matches!(policy::decide("x", Access::Read, &change, &empty), Verdict::Deny(m) if m.contains("solo lectura")));
    assert_eq!(policy::decide("x", Access::Read, &dl, &empty), Verdict::Ask { can_remember: true });
    assert_eq!(policy::decide("x", Access::Full, &change, &empty), Verdict::Ask { can_remember: true });
    let mut remembered = std::collections::BTreeSet::new();
    remembered.insert("run_command\nls".to_string());
    assert_eq!(policy::decide("x", Access::Full, &change, &remembered), Verdict::Allow(policy::REMEMBERED));
    // Peligroso: aunque esté recordado, se pregunta y no se puede recordar.
    let mut rm = Action::change("run_command\nrm -rf /tmp/x").with_danger(policy::danger_reasons("rm -rf /tmp/x"));
    remembered.insert(rm.key.clone());
    assert_eq!(policy::decide("x", Access::Full, &rm, &remembered), Verdict::Ask { can_remember: false });
    rm.danger.clear();
    assert_eq!(policy::decide("x", Access::Full, &rm, &remembered), Verdict::Allow(policy::REMEMBERED));
}

#[test]
fn dangerous_commands() {
    for c in [
        "rm -rf /var/www",
        "cd /x && rm -fr build",
        "podman system prune -af",
        "docker image prune",
        "sudo systemctl restart nginx",
        "reboot",
        "shutdown -h now",
        "doas apk add x",
        "su - root",
        "echo hola | sudo tee /etc/x",
        "mkfs.ext4 /dev/sdb1",
        "dd if=/dev/zero of=/dev/sda",
        "psql -c 'DROP TABLE users'",
        "git push --force",
    ] {
        assert!(!policy::danger_reasons(c).is_empty(), "debería ser peligroso: {c}");
    }
    for c in ["ls -la", "df -h", "podman ps -a", "cat /etc/os-release", "systemctl status nginx", "grep -r sudoers /tmp"] {
        assert!(policy::danger_reasons(c).is_empty(), "no debería ser peligroso: {c} → {:?}", policy::danger_reasons(c));
    }
    assert_eq!(policy::danger_reasons("rm -rf x"), vec!["borrado recursivo (rm -rf)".to_string()]);
    assert!(policy::looks_interactive("top"));
    assert!(policy::looks_interactive("tail -f /var/log/syslog"));
    assert!(!policy::looks_interactive("tail -n 50 /var/log/syslog"));
}

// ───────────────────────── Bloqueo, apagado y acceso ─────────────────────────

#[tokio::test]
async fn locked_rejects_everything() {
    let c = core();
    c.backend.locked.store(true, Ordering::SeqCst);
    for (tool, args) in [
        ("list_servers", json!({})),
        ("list_sessions", json!({})),
        ("run_command", json!({ "server": "web-prod", "command": "ls" })),
        ("read_file", json!({ "server": "web-prod", "path": "/etc/hosts" })),
    ] {
        let out = call(&c, tool, args).await;
        assert!(out.is_error, "{tool}");
        assert_eq!(out.text, LOCKED_MSG);
    }
    assert!(ran(&c).is_empty());
    assert_eq!(asked(&c), 0);
    let log = c.audit.list();
    assert_eq!(log.len(), 4);
    assert!(log.iter().all(|e| e.status == AuditStatus::Locked));
}

#[tokio::test]
async fn locked_while_waiting_for_approval() {
    // El usuario aprueba, pero TerView se bloqueó mientras esperaba: no se ejecuta.
    let c = core();
    c.backend.lock_on_ask.store(true, Ordering::SeqCst);
    set_answer(&c, Answer::Give(Decision::Once));
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "touch x" })).await;
    assert_eq!(asked(&c), 1);
    assert!(out.is_error);
    assert_eq!(out.text, LOCKED_MSG);
    assert!(ran(&c).is_empty());
}

#[tokio::test]
async fn disabled_rejects_everything() {
    let c = core_with(Mock::new(), McpConfig { enabled: false, ..config() });
    let out = call(&c, "list_servers", json!({})).await;
    assert!(out.is_error);
    assert_eq!(out.text, DISABLED_MSG);
}

#[tokio::test]
async fn no_access_server_is_hidden_and_denied() {
    let c = core();
    let out = call(&c, "list_servers", json!({})).await;
    assert!(!out.is_error);
    assert!(out.text.contains("web-prod") && out.text.contains("db-server"));
    assert!(!out.text.contains("vps-personal"), "{}", out.text);
    let projects = call(&c, "list_projects", json!({})).await.text;
    assert!(projects.contains("web-prod") && !projects.contains("vps-personal"));
    let sessions = call(&c, "list_sessions", json!({})).await.text;
    assert!(!sessions.contains("ss-none"));

    for (tool, args) in [
        ("run_command", json!({ "server": "vps-personal", "command": "ls" })),
        ("list_dir", json!({ "server": "vps-personal", "path": "/" })),
        ("read_file", json!({ "server": "s-none", "path": "/etc/hosts" })),
        ("connect", json!({ "server": "vps-personal" })),
    ] {
        let out = call(&c, tool, args).await;
        assert!(out.is_error, "{tool}");
        assert!(out.text.contains("no tiene acceso"), "{tool}: {}", out.text);
    }
    assert!(ran(&c).is_empty());
    assert_eq!(asked(&c), 0);
    assert!(c.audit.list().iter().filter(|e| e.server_id.as_deref() == Some("s-none")).all(|e| e.status == AuditStatus::Denied));
}

#[tokio::test]
async fn read_only_server() {
    let c = core();
    // Lecturas: pasan sin preguntar.
    let out = call(&c, "list_dir", json!({ "server": "db-server", "path": "/etc" })).await;
    assert!(!out.is_error, "{}", out.text);
    let out = call(&c, "run_catalog_command", json!({ "server": "db-server", "id": "podman.ps" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(ran(&c), vec!["podman ps -a".to_string()]);
    let out = call(&c, "list_ports", json!({ "server": "db-server" })).await;
    assert!(!out.is_error && out.text.contains("\"port\": 22"), "{}", out.text);
    assert_eq!(asked(&c), 0);
    // Cambios: rechazados sin preguntar.
    for (tool, args) in [
        ("run_command", json!({ "server": "db-server", "command": "ls" })),
        ("run_catalog_command", json!({ "server": "db-server", "id": "podman.restart", "vars": { "contenedor": "web" } })),
        ("write_file", json!({ "server": "db-server", "path": "/tmp/a", "content": "x" })),
    ] {
        let out = call(&c, tool, args).await;
        assert!(out.is_error && out.text.contains("solo lectura"), "{tool}: {}", out.text);
    }
    assert_eq!(asked(&c), 0);
    assert_eq!(ran(&c).len(), 1);
}

// ───────────────────────── Aprobación ─────────────────────────

#[tokio::test]
async fn approval_once_deny_and_always() {
    let c = core();
    // Una vez.
    set_answer(&c, Answer::Give(Decision::Once));
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "podman restart web" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("Código de salida: 0"));
    {
        let reqs = c.backend.asked.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].command, "podman restart web");
        assert_eq!(reqs[0].server_name, "web-prod");
        assert!(reqs[0].can_remember);
    }
    // Denegar.
    set_answer(&c, Answer::Give(Decision::Deny));
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "touch /tmp/x" })).await;
    assert!(out.is_error && out.text.contains("denegó"), "{}", out.text);
    assert_eq!(ran(&c).len(), 1);
    // Siempre: la segunda vez ya no pregunta.
    set_answer(&c, Answer::Give(Decision::Always));
    call(&c, "run_command", json!({ "server": "web-prod", "command": "uptime" })).await;
    let before = asked(&c);
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "uptime" })).await;
    assert!(!out.is_error);
    assert_eq!(asked(&c), before, "no debió preguntar otra vez");
    assert!(c.config.get().remembered_of("s-full").contains("run_command\nuptime"));
    // Otro comando distinto sí pregunta.
    call(&c, "run_command", json!({ "server": "web-prod", "command": "uptime -p" })).await;
    assert_eq!(asked(&c), before + 1);

    let log = c.audit.list();
    let first = log.iter().rev().find(|e| e.detail == "podman restart web").unwrap();
    assert_eq!(first.approved_by.as_deref(), Some("tú: una vez"));
    assert_eq!(first.status, AuditStatus::Ok);
    let denied = log.iter().find(|e| e.detail == "touch /tmp/x").unwrap();
    assert_eq!(denied.status, AuditStatus::Denied);
    assert_eq!(denied.approved_by.as_deref(), Some("tú: denegado"));
    let remembered = log.iter().find(|e| e.detail == "uptime").unwrap();
    assert_eq!(remembered.approved_by.as_deref(), Some(policy::REMEMBERED));
}

#[tokio::test]
async fn dangerous_always_asks() {
    let c = core();
    set_answer(&c, Answer::Give(Decision::Always));
    for _ in 0..2 {
        let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo reboot" })).await;
        assert!(!out.is_error);
    }
    assert_eq!(asked(&c), 2, "lo peligroso pregunta siempre");
    let reqs = c.backend.asked.lock().unwrap().clone();
    assert!(!reqs[0].can_remember);
    assert!(reqs[0].danger.iter().any(|d| d.contains("sudo")));
    assert!(c.config.get().remembered_of("s-full").is_empty());
    // Del catálogo marcado como peligroso: también.
    let out = call(&c, "run_catalog_command", json!({ "server": "web-prod", "id": "podman.prune" })).await;
    assert!(!out.is_error);
    assert_eq!(asked(&c), 3);
    assert!(!c.backend.asked.lock().unwrap()[2].can_remember);
}

#[tokio::test(start_paused = true)]
async fn approval_times_out_and_denies() {
    let c = core_with(Mock::new(), McpConfig { approval_timeout_secs: 30, ..config() });
    set_answer(&c, Answer::Never);
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "touch /tmp/x" })).await;
    assert!(out.is_error);
    assert!(out.text.contains("Nadie respondió") && out.text.contains("30 s"), "{}", out.text);
    assert!(ran(&c).is_empty());
    let e = &c.audit.list()[0];
    assert_eq!(e.status, AuditStatus::Denied);
    assert_eq!(e.approved_by.as_deref(), Some("sin respuesta"));
}

#[tokio::test]
async fn catalog_vars_are_quoted_and_checked() {
    let c = core();
    let out = call(
        &c,
        "run_catalog_command",
        json!({ "server": "web-prod", "id": "podman.logs", "vars": { "contenedor": "web; rm -rf /" } }),
    )
    .await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(ran(&c), vec!["podman logs --tail 100 'web; rm -rf /'".to_string()]);
    // Lectura del catálogo: sin preguntar… salvo que el valor lo haga peligroso.
    assert_eq!(asked(&c), 1, "«rm -rf» en el comando final obliga a preguntar");
    let out = call(&c, "run_catalog_command", json!({ "server": "web-prod", "id": "podman.logs", "vars": { "contenedor": "--help" } })).await;
    assert!(out.is_error && out.text.contains("«-»"));
    let out = call(&c, "run_catalog_command", json!({ "server": "web-prod", "id": "podman.logs" })).await;
    assert!(out.is_error && out.text.contains("contenedor"), "{}", out.text);
}

#[tokio::test]
async fn interactive_commands_are_refused() {
    let c = core();
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "tail -f /var/log/syslog" })).await;
    assert!(out.is_error && out.text.contains("interactivo"));
    assert_eq!(asked(&c), 0);
}

#[tokio::test]
async fn write_file_shows_diff() {
    let c = core();
    c.backend.files.lock().unwrap().insert("/etc/app.conf".into(), "a\nb\nc\n".into());
    let out = call(&c, "write_file", json!({ "server": "web-prod", "path": "/etc/app.conf", "content": "a\nB\nc\n" })).await;
    assert!(!out.is_error, "{}", out.text);
    let req = c.backend.asked.lock().unwrap()[0].clone();
    let d = req.diff.unwrap();
    assert!(d.contains("-b") && d.contains("+B"), "{d}");
    assert_eq!(c.backend.files.lock().unwrap()["/etc/app.conf"], "a\nB\nc\n");
    // Archivo nuevo.
    call(&c, "write_file", json!({ "server": "web-prod", "path": "/tmp/nuevo", "content": "hola" })).await;
    let d = c.backend.asked.lock().unwrap()[1].diff.clone().unwrap();
    assert!(d.starts_with("(archivo nuevo)") && d.contains("+hola"), "{d}");
}

#[tokio::test]
async fn connect_opens_tab_with_permission() {
    let c = core();
    // Ya conectado: no pregunta.
    let out = call(&c, "connect", json!({ "server": "web-prod" })).await;
    assert!(out.text.contains("ss-full"));
    assert_eq!(asked(&c), 0);
    // Sin conexión: pregunta y pide a la interfaz que abra la pestaña.
    let mut m = Mock::new();
    m.sessions.clear();
    let c = core_with(m, config());
    let out = call(&c, "connect", json!({ "server": "db-server" })).await;
    assert!(!out.is_error && out.text.contains("nueva"), "{}", out.text);
    assert_eq!(asked(&c), 1);
    assert_eq!(c.backend.ui_calls.lock().unwrap().as_slice(), ["connect"]);
    // Sin conexión, el resto de herramientas lo dice claro.
    let out = call(&c, "list_dir", json!({ "server": "db-server", "path": "/" })).await;
    assert!(out.is_error && out.text.contains("connect"), "{}", out.text);
}

// ───────────────────────── Límites ─────────────────────────

#[tokio::test]
async fn output_is_limited() {
    let c = core();
    *c.backend.stdout.lock().unwrap() = format!("INICIO{}FINAL", "x".repeat(300 * 1024));
    set_answer(&c, Answer::Give(Decision::Once));
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "cat big", "max_output_kb": 4 })).await;
    assert!(!out.is_error);
    assert!(out.text.len() < 6 * 1024, "{}", out.text.len());
    assert!(out.text.contains("salida recortada"));
    assert!(out.text.contains("INICIO") && out.text.contains("FINAL") && out.text.contains("se omitieron"));
    // Por defecto: 64 KB.
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "cat big" })).await;
    assert!(out.text.len() < 66 * 1024 && out.text.len() > 60 * 1024);
}

#[test]
fn clip_middle_respects_chars() {
    let s = "ñ".repeat(1000);
    let out = super::core::clip_middle(&s, 101);
    assert!(out.contains("se omitieron"));
    assert!(out.starts_with('ñ') && out.ends_with('ñ'));
}

#[tokio::test]
async fn read_file_is_chunked() {
    let c = core();
    c.backend.files.lock().unwrap().insert("/var/log/app.log".into(), "0123456789".repeat(10));
    let out = call(&c, "read_file", json!({ "server": "db-server", "path": "/var/log/app.log", "max_bytes": 30 })).await;
    assert!(!out.is_error);
    assert!(out.text.contains("100 bytes en total") && out.text.contains("offset=30"), "{}", out.text);
    c.backend.files.lock().unwrap().insert("/bin/x".into(), "\0ELF".into());
    let out = call(&c, "read_file", json!({ "server": "db-server", "path": "/bin/x" })).await;
    assert!(out.text.contains("binario"));
}

// ───────────────────────── Registro ─────────────────────────

#[tokio::test]
async fn audit_file_and_rotation() {
    let dir = std::env::temp_dir().join(format!("terview-mcp-audit-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(super::audit::FILE_NAME);
    {
        let c = McpCore::new(Mock::new(), McpConfigStore::in_memory(config()), AuditLog::at(Some(path.clone())));
        call(&c, "list_servers", json!({})).await;
        call(&c, "run_command", json!({ "server": "vps-personal", "command": "ls" })).await;
    }
    let text = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["tool"], "list_servers");
    assert_eq!(lines[0]["status"], "ok");
    assert_eq!(lines[1]["status"], "denied");
    assert_eq!(lines[1]["serverName"], "vps-personal");
    assert_eq!(lines[1]["detail"], "ls");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Al volver a abrir, se cargan las últimas acciones.
    let log = AuditLog::at(Some(path.clone()));
    assert_eq!(log.list().len(), 2);
    // Rotación al pasar de 1 MiB.
    let big = "x".repeat(super::audit::ROTATE_BYTES as usize);
    std::fs::write(&path, big).unwrap();
    let c = McpCore::new(Mock::new(), McpConfigStore::in_memory(config()), AuditLog::at(Some(path.clone())));
    call(&c, "list_servers", json!({})).await;
    assert!(dir.join(super::audit::OLD_FILE_NAME).exists());
    assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

// ───────────────────────── Plantillas y diferencias ─────────────────────────

#[test]
fn template_rendering() {
    let mut v = BTreeMap::new();
    v.insert("c".to_string(), "mi web".to_string());
    assert_eq!(template::render("podman logs {{c}}", &v).unwrap(), "podman logs 'mi web'");
    assert_eq!(template::render("echo '{{c}}'", &v).unwrap(), "echo 'mi web'");
    v.insert("c".to_string(), "a\"$b".to_string());
    assert_eq!(template::render("echo \"{{c}}\"", &v).unwrap(), "echo \"a\\\"\\$b\"");
    // Plantillas Go no son variables.
    assert_eq!(template::render("podman ps --format '{{.Names}}'", &BTreeMap::new()).unwrap(), "podman ps --format '{{.Names}}'");
    assert_eq!(template::render("x {{n:5}}", &BTreeMap::new()).unwrap(), "x 5");
    assert!(template::render("x {{n}}", &BTreeMap::new()).is_err());
    let mut bad = BTreeMap::new();
    bad.insert("otra".to_string(), "1".to_string());
    assert!(template::render("x {{n:1}}", &bad).unwrap_err().contains("otra"));
    assert_eq!(template::parse_vars("{{a}} {{b:2}} {{a:1}}"), vec![("a".into(), Some("1".into())), ("b".into(), Some("2".into()))]);
}

#[test]
fn line_diff() {
    assert_eq!(diff::unified("a\n", "a\n"), "");
    let d = diff::unified("uno\ndos\ntres\n", "uno\nDOS\ntres\ncuatro\n");
    assert!(d.starts_with("@@ -1,3 +1,4 @@"), "{d}");
    assert!(d.contains("-dos\n+DOS") && d.contains("+cuatro"), "{d}");
}

// ───────────────────────── Transporte HTTP ─────────────────────────

struct TestGate {
    locked: AtomicBool,
    token: Option<String>,
}

impl http::Gate for TestGate {
    fn locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }
    fn token(&self) -> Option<Zeroizing<String>> {
        self.token.clone().map(Zeroizing::new)
    }
}

const TOKEN: &str = "tv_prueba";

/// Servidor HTTP con el motor simulado en un puerto libre.
async fn spawn_http(gate: Arc<TestGate>) -> (u16, Arc<McpCore<Mock>>, CancellationToken) {
    let core = Arc::new(core());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let ct = CancellationToken::new();
    tokio::spawn(http::serve(listener, core.clone(), gate, ct.clone()));
    (port, core, ct)
}

fn gate(locked: bool) -> Arc<TestGate> {
    Arc::new(TestGate { locked: AtomicBool::new(locked), token: Some(TOKEN.into()) })
}

const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"prueba","version":"1"}}}"#;

async fn post(port: u16, body: &str, token: Option<&str>, origin: bool) -> (u16, String) {
    let mut req = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/mcp"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body.to_string());
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    if origin {
        req = req.header("Origin", "https://malicioso.ejemplo");
    }
    let r = req.send().await.unwrap();
    let status = r.status().as_u16();
    (status, r.text().await.unwrap())
}

#[tokio::test]
async fn http_token_origin_and_lock() {
    let g = gate(false);
    let (port, _core, ct) = spawn_http(g.clone()).await;
    // Sin token o con uno incorrecto: 401.
    let (s, body) = post(port, INIT, None, false).await;
    assert_eq!(s, 401, "{body}");
    let (s, _) = post(port, INIT, Some("tv_otro"), false).await;
    assert_eq!(s, 401);
    let (s, _) = post(port, INIT, Some("tv_prueb"), false).await;
    assert_eq!(s, 401);
    // Páginas web (cabecera Origin): 403 aunque traigan el token.
    let (s, _) = post(port, INIT, Some(TOKEN), true).await;
    assert_eq!(s, 403);
    // Bien.
    let (s, body) = post(port, INIT, Some(TOKEN), false).await;
    assert_eq!(s, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["result"]["serverInfo"]["name"], "terview");
    // Bloqueado: error JSON-RPC claro, con el mismo id.
    g.locked.store(true, Ordering::SeqCst);
    let (s, body) = post(port, r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#, Some(TOKEN), false).await;
    assert_eq!(s, 200);
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["id"], 7);
    assert_eq!(v["error"]["message"], LOCKED_MSG);
    ct.cancel();
}

#[test]
fn same_token_compares_everything() {
    assert!(http::same_token("abc", "abc"));
    assert!(!http::same_token("abc", "abd"));
    assert!(!http::same_token("abc", "abcd"));
    assert!(!http::same_token("", "a"));
    let t = super::new_token().unwrap();
    assert!(t.starts_with("tv_") && t.len() == 67);
    assert_ne!(*t, *super::new_token().unwrap());
}

// ───────────────────────── Puente stdio ─────────────────────────

/// Lanza el puente con tuberías en memoria. Devuelve (escritor de stdin, lector de stdout).
fn spawn_bridge(port: u16, token: Option<&str>) -> (tokio::io::DuplexStream, tokio::io::Lines<BufReader<tokio::io::DuplexStream>>) {
    let (client_in, bridge_in) = tokio::io::duplex(1 << 20);
    let (bridge_out, client_out) = tokio::io::duplex(1 << 20);
    let cfg = bridge::BridgeConfig {
        port,
        token: token.map(str::to_string),
        version: "0.0.0".into(),
        poll: Duration::from_millis(50),
    };
    tokio::spawn(bridge::run(cfg, BufReader::new(bridge_in), bridge_out));
    (client_in, BufReader::new(client_out).lines())
}

async fn send(w: &mut tokio::io::DuplexStream, msg: &str) {
    w.write_all(msg.as_bytes()).await.unwrap();
    w.write_all(b"\n").await.unwrap();
}

async fn recv(r: &mut tokio::io::Lines<BufReader<tokio::io::DuplexStream>>) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(10), r.next_line()).await.unwrap().unwrap().unwrap();
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn bridge_forwards_to_app() {
    let (port, _core, ct) = spawn_http(gate(false)).await;
    let (mut w, mut r) = spawn_bridge(port, Some(TOKEN));
    send(&mut w, INIT).await;
    let v = recv(&mut r).await;
    assert_eq!(v["result"]["serverInfo"]["name"], "terview");
    send(&mut w, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
    send(&mut w, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
    let v = recv(&mut r).await;
    assert_eq!(v["id"], 2);
    let names: Vec<&str> = v["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in ["list_servers", "run_command", "read_file", "write_file", "list_ports", "list_containers"] {
        assert!(names.contains(&n), "falta {n}: {names:?}");
    }
    send(&mut w, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}"#).await;
    let v = recv(&mut r).await;
    assert_eq!(v["id"], 3);
    let text = v["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("web-prod"), "{text}");
    // El cliente queda en el registro (User-Agent del puente con el nombre del cliente).
    let log = _core.audit.list();
    assert!(log[0].client.as_deref().unwrap_or("").contains("prueba"), "{:?}", log[0].client);
    ct.cancel();
}

#[tokio::test]
async fn bridge_with_wrong_token() {
    let (port, _core, ct) = spawn_http(gate(false)).await;
    let (mut w, mut r) = spawn_bridge(port, Some("tv_mal"));
    send(&mut w, INIT).await;
    let v = recv(&mut r).await;
    assert!(v["error"]["message"].as_str().unwrap().contains("Token incorrecto"), "{v}");
    ct.cancel();
}

#[tokio::test]
async fn bridge_when_app_is_closed() {
    // Un puerto libre sin nadie escuchando.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (mut w, mut r) = spawn_bridge(port, Some(TOKEN));
    send(&mut w, INIT).await;
    let v = recv(&mut r).await;
    assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
    assert!(v["result"]["instructions"].as_str().unwrap().contains(bridge::CLOSED_MSG));
    send(&mut w, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
    let v = recv(&mut r).await;
    let tools = v["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert!(tools[0]["description"].as_str().unwrap().contains(bridge::CLOSED_MSG));
    send(&mut w, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"terview_abrir","arguments":{}}}"#).await;
    let v = recv(&mut r).await;
    assert_eq!(v["result"]["content"][0]["text"], bridge::CLOSED_MSG);
    send(&mut w, r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}"#).await;
    let v = recv(&mut r).await;
    assert_eq!(v["error"]["message"], bridge::CLOSED_MSG);
    // Se abre la app: el puente avisa de que cambió la lista de herramientas.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    let ct = CancellationToken::new();
    tokio::spawn(http::serve(listener, Arc::new(core()), gate(false), ct.clone()));
    let v = recv(&mut r).await;
    assert_eq!(v["method"], "notifications/tools/list_changed");
    send(&mut w, r#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#).await;
    let v = recv(&mut r).await;
    assert!(v["result"]["tools"].as_array().unwrap().len() > 10);
    ct.cancel();
}

#[test]
fn sse_parser() {
    let mut p = bridge::SseParser::default();
    assert!(p.push(b"data: {\"a\":").is_empty());
    let out = p.push(b"1}\n\nevent: message\r\ndata: {\"b\":2}\r\n\r\ndata: {\"c\"");
    assert_eq!(out, vec![r#"{"a":1}"#.to_string(), r#"{"b":2}"#.to_string()]);
    assert_eq!(p.push(b":3}"), Vec::<String>::new());
    assert_eq!(p.finish(), vec![r#"{"c":3}"#.to_string()]);
    // Un carácter UTF-8 partido entre dos trozos no se estropea.
    let msg = "data: {\"t\":\"ñandú\"}\n\n".as_bytes();
    let cut = msg.iter().position(|&b| b == 0xC3).unwrap() + 1;
    let mut p = bridge::SseParser::default();
    assert!(p.push(&msg[..cut]).is_empty());
    assert_eq!(p.push(&msg[cut..]), vec![r#"{"t":"ñandú"}"#.to_string()]);
}
