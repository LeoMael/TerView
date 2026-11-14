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
use super::vuln::fixtures as vuln_fixtures;
use super::{bridge, diff, http, template};
use crate::error::{AppError, AppResult};
use crate::sftp::FilePart;
use crate::types::{
    AuthMethod, ExecResult, FileEntry, FileKind, ProfilesData, Project, ServerProfile, SessionInfo, Snippet,
    TransferJob,
};
use crate::vulnscan::model::{Report, Severity};
use crate::vulnscan::scan::ScanOptions;
use crate::vulnscan::VulnScanSettings;

// ───────────────────────── Motor simulado ─────────────────────────

#[derive(Clone, Copy)]
enum Answer {
    Give(Decision),
    /// Nadie responde (para el tiempo límite).
    Never,
}

struct Mock {
    locked: AtomicBool,
    /// Se bloquea SSHorus justo al preguntar (bloqueo mientras se espera la respuesta).
    lock_on_ask: AtomicBool,
    data: ProfilesData,
    sessions: Vec<SessionInfo>,
    answer: Mutex<Answer>,
    asked: Mutex<Vec<ApprovalRequest>>,
    ran: Mutex<Vec<String>>,
    stdout: Mutex<String>,
    files: Mutex<HashMap<String, String>>,
    ui_calls: Mutex<Vec<String>>,
    /// Escáner: ajustes, último informe guardado, cuánto tarda un análisis y lo que se pidió.
    vuln_settings: Mutex<VulnScanSettings>,
    vuln_saved: Mutex<HashMap<String, Report>>,
    audit_saved: Mutex<HashMap<String, crate::audit::model::AuditReport>>,
    scan_takes: Mutex<Duration>,
    scans: Mutex<Vec<(String, ScanOptions)>>,
    /// Análisis en curso por exec_id (para `cancel_exec`, el «Detener» del panel).
    scan_stops: Mutex<HashMap<String, CancellationToken>>,
    /// stdin de cada ejecución (None = sin stdin).
    stdins: Mutex<Vec<Option<Vec<u8>>>>,
    /// Respuesta de la interfaz a «sudo» y peticiones recibidas (tipo, payload).
    sudo_reply: Mutex<Value>,
    ui_payloads: Mutex<Vec<(String, Value)>>,
    /// Resultado fijo de exec (si no, stdout de `stdout` con código 0).
    exec_result: Mutex<Option<ExecResult>>,
    /// Ejecutar de verdad con `sh` en este equipo, con un sudo simulado (ver `FakeSudo`).
    local: Mutex<Option<FakeSudo>>,
    /// Se bloquea SSHorus mientras se busca la contraseña de sudo.
    lock_on_sudo: AtomicBool,
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
            vuln_settings: Mutex::new(VulnScanSettings::default()),
            vuln_saved: Mutex::new(HashMap::new()),
            audit_saved: Mutex::new(HashMap::new()),
            scan_takes: Mutex::new(Duration::from_secs(5)),
            scans: Mutex::new(Vec::new()),
            scan_stops: Mutex::new(HashMap::new()),
            stdins: Mutex::new(Vec::new()),
            sudo_reply: Mutex::new(json!({ "elevate": false })),
            ui_payloads: Mutex::new(Vec::new()),
            exec_result: Mutex::new(None),
            local: Mutex::new(None),
            lock_on_sudo: AtomicBool::new(false),
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
    async fn exec(&self, _sid: &str, command: &str, stdin: Option<&[u8]>, _t: u32, _id: &str) -> AppResult<ExecResult> {
        self.ran.lock().unwrap().push(command.to_string());
        self.stdins.lock().unwrap().push(stdin.map(<[u8]>::to_vec));
        let local = self.local.lock().unwrap().clone();
        if let Some(fake) = local {
            return Ok(fake.run(command, stdin));
        }
        if let Some(r) = self.exec_result.lock().unwrap().clone() {
            return Ok(r);
        }
        Ok(ExecResult {
            stdout: self.stdout.lock().unwrap().clone(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 5,
            truncated: false,
            timed_out: false,
        })
    }
    fn cancel_exec(&self, id: &str) -> bool {
        match self.scan_stops.lock().unwrap().get(id) {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
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
    fn vuln_settings(&self) -> VulnScanSettings {
        self.vuln_settings.lock().unwrap().clone()
    }
    async fn vuln_latest(&self, server_id: &str) -> AppResult<Option<Report>> {
        Ok(self.vuln_saved.lock().unwrap().get(server_id).cloned())
    }
    async fn audit_latest(&self, server_id: &str) -> AppResult<Option<crate::audit::model::AuditReport>> {
        Ok(self.audit_saved.lock().unwrap().get(server_id).cloned())
    }
    async fn vuln_scan(&self, sid: &str, opts: ScanOptions, exec_id: &str, cancel: &CancellationToken) -> AppResult<Report> {
        self.scans.lock().unwrap().push((sid.to_string(), opts.clone()));
        self.scan_stops.lock().unwrap().insert(exec_id.to_string(), cancel.clone());
        let takes = *self.scan_takes.lock().unwrap();
        let finished = tokio::select! {
            () = tokio::time::sleep(takes) => true,
            () = cancel.cancelled() => false,
        };
        self.scan_stops.lock().unwrap().remove(exec_id);
        if !finished {
            return Err(AppError::Canceled);
        }
        let mut r = vuln_fixtures::report(vec![
            vuln_fixtures::finding("CVE-2024-0001", Severity::Critical, true, Some(9.8)),
            vuln_fixtures::finding("CVE-2024-0002", Severity::Low, false, None),
        ]);
        r.server_id = opts.server_id.clone();
        r.summary.critical = 1;
        r.summary.low = 1;
        if opts.save {
            self.vuln_saved.lock().unwrap().insert(opts.server_id.clone(), r.clone());
        }
        Ok(r)
    }
    async fn ui_request(&self, kind: &str, payload: Value, _t: Duration) -> AppResult<Value> {
        self.ui_calls.lock().unwrap().push(kind.to_string());
        self.ui_payloads.lock().unwrap().push((kind.to_string(), payload));
        match kind {
            "connect" => Ok(json!({ "sessionId": "nueva" })),
            "sudo" => {
                if self.lock_on_sudo.load(Ordering::SeqCst) {
                    self.locked.store(true, Ordering::SeqCst);
                }
                Ok(self.sudo_reply.lock().unwrap().clone())
            }
            "sudo-rejected" => Ok(Value::Null),
            "ports" => Ok(json!({ "tool": "ss", "ports": [{ "port": 22 }] })),
            "audit" => Ok(serde_json::to_value(audit_fixture()).unwrap()),
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
    // El usuario aprueba, pero SSHorus se bloqueó mientras esperaba: no se ejecuta.
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

#[tokio::test]
async fn transfers_need_permission() {
    let c = core();
    let here = std::env::temp_dir().display().to_string();
    // Subir a un servidor de solo lectura: no.
    let out = call(&c, "upload", json!({ "server": "db-server", "local_paths": [here], "remote_dir": "/tmp" })).await;
    assert!(out.is_error && out.text.contains("solo lectura"), "{}", out.text);
    // Descargar desde solo lectura: sí, con permiso.
    let out = call(&c, "download", json!({ "server": "db-server", "remote_paths": ["/etc/hosts"], "local_dir": here })).await;
    assert!(!out.is_error && out.text.contains("lote-2"), "{}", out.text);
    assert_eq!(asked(&c), 1);
    // Rutas locales que no existen o relativas: error claro, sin preguntar.
    let out = call(&c, "upload", json!({ "server": "web-prod", "local_paths": ["no/existe"], "remote_dir": "/tmp" })).await;
    assert!(out.is_error && out.text.contains("No existe"), "{}", out.text);
    let out = call(&c, "download", json!({ "server": "web-prod", "remote_paths": ["/x"], "local_dir": "relativa" })).await;
    assert!(out.is_error);
    assert_eq!(asked(&c), 1);
    // Subir a completo: pregunta mostrando los archivos.
    let out = call(&c, "upload", json!({ "server": "web-prod", "local_paths": [here], "remote_dir": "/srv" })).await;
    assert!(!out.is_error && out.text.contains("lote-1"));
    let req = c.backend.asked.lock().unwrap()[1].clone();
    assert!(req.command.contains("/srv") && req.command.contains(&here), "{}", req.command);
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
    let dir = std::env::temp_dir().join(format!("sshorus-mcp-audit-{}", uuid::Uuid::new_v4().simple()));
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
    assert_eq!(v["result"]["serverInfo"]["name"], "sshorus");
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
    assert_eq!(v["result"]["serverInfo"]["name"], "sshorus");
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
    send(&mut w, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sshorus_abrir","arguments":{}}}"#).await;
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

// ───────────────────────── Vulnerabilidades ─────────────────────────

fn scans(core: &McpCore<Mock>) -> usize {
    core.backend.scans.lock().unwrap().len()
}

#[tokio::test]
async fn vuln_report_is_a_read_with_access_rules() {
    let core = core();
    // Sin informe: no es un error; dice cómo conseguir uno. No pregunta nada (es lectura).
    let out = call(&core, "get_vuln_report", json!({ "server": "db-server" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("no tiene ningún análisis") && out.text.contains("scan_vulnerabilities"), "{}", out.text);

    let mut r = vuln_fixtures::report(
        (0..30).map(|i| vuln_fixtures::finding(&format!("CVE-2024-{i:04}"), Severity::High, true, Some(7.5))).collect(),
    );
    r.summary.high = 30;
    core.backend.vuln_saved.lock().unwrap().insert("s-read".into(), r);
    let out = call(&core, "get_vuln_report", json!({ "server": "db-server", "limit": 5 })).await;
    assert!(!out.is_error, "{}", out.text);
    let v: Value = serde_json::from_str(&out.text).unwrap();
    assert_eq!(v["server"], "db-server");
    assert_eq!(v["summary"]["high"], 30);
    assert_eq!(v["topFindings"].as_array().unwrap().len(), 5, "resumido, no el informe entero");
    assert_eq!(v["of"], 30);
    assert_eq!(asked(&core), 0);
    // No necesita conexión: lee el historial de este PC.
    let no_sessions = Mock { sessions: vec![], ..Mock::new() };
    no_sessions.vuln_saved.lock().unwrap().insert("s-full".into(), vuln_fixtures::report(vec![]));
    let core2 = core_with(no_sessions, config());
    let out = call(&core2, "get_vuln_report", json!({ "server": "web-prod" })).await;
    assert!(!out.is_error, "{}", out.text);

    // Sin acceso: rechazado y sin leer nada.
    let out = call(&core, "get_vuln_report", json!({ "server": "vps-personal" })).await;
    assert!(out.is_error && out.text.contains("no tiene acceso"), "{}", out.text);
    let log = core.audit.list();
    assert!(log.iter().any(|e| e.tool == "get_vuln_report" && e.status == AuditStatus::Denied));
    assert!(log.iter().any(|e| e.tool == "get_vuln_report" && e.approved_by.as_deref() == Some(policy::AUTO_READ)));
}

#[tokio::test(start_paused = true)]
async fn vuln_scan_asks_once_then_always_even_read_only() {
    let core = core();
    core.backend.vuln_settings.lock().unwrap().use_osv = false;
    set_answer(&core, Answer::Give(Decision::Always));
    // Servidor de solo lectura: permitido, pero con permiso.
    let out = call(&core, "scan_vulnerabilities", json!({ "server": "db-server" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(asked(&core), 1);
    let req = core.backend.asked.lock().unwrap()[0].clone();
    assert_eq!(req.tool, "scan_vulnerabilities");
    assert!(req.can_remember, "se ofrece «Permitir siempre»");
    assert!(req.command.contains("SIN sudo") && req.command.contains("deploy"), "{}", req.command);
    assert!(!req.command.contains("OSV"), "OSV apagado en Ajustes: no se menciona: {}", req.command);
    // Resumen: recuento y la lista principal.
    let v: Value = serde_json::from_str(&out.text).unwrap();
    assert_eq!(v["summary"]["critical"], 1);
    assert_eq!(v["topFindings"][0]["id"], "CVE-2024-0001");
    // Opciones: las de Ajustes, sin sudo, guardando el informe, con la conexión del servidor.
    let (sid, opts) = core.backend.scans.lock().unwrap()[0].clone();
    assert_eq!(sid, "ss-read");
    assert!(!opts.use_osv && opts.save && opts.server_id == "s-read");

    // Segunda vez: regla «siempre», sin preguntar.
    let out = call(&core, "scan_vulnerabilities", json!({ "server": "db-server" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(asked(&core), 1);
    assert_eq!(scans(&core), 2);
    let log = core.audit.list();
    assert!(log.iter().any(|e| e.tool == "scan_vulnerabilities" && e.approved_by.as_deref() == Some(policy::REMEMBERED)));
    // Y queda como último informe.
    let out = call(&core, "get_vuln_report", json!({ "server": "db-server" })).await;
    assert!(out.text.contains("CVE-2024-0001"), "{}", out.text);
}

#[tokio::test]
async fn vuln_scan_denied_or_without_connection() {
    let core = core();
    set_answer(&core, Answer::Give(Decision::Deny));
    let out = call(&core, "scan_vulnerabilities", json!({ "server": "web-prod" })).await;
    assert!(out.is_error && out.text.contains("denegó"), "{}", out.text);
    assert_eq!(scans(&core), 0);
    let out = call(&core, "scan_vulnerabilities", json!({ "server": "vps-personal" })).await;
    assert!(out.is_error && out.text.contains("no tiene acceso"), "{}", out.text);

    let core = core_with(Mock { sessions: vec![], ..Mock::new() }, config());
    let out = call(&core, "scan_vulnerabilities", json!({ "server": "web-prod" })).await;
    assert!(out.is_error && out.text.contains("connect"), "{}", out.text);
    assert_eq!(asked(&core), 0);
}

#[tokio::test(start_paused = true)]
async fn vuln_scan_has_a_time_limit() {
    let core = core();
    *core.backend.scan_takes.lock().unwrap() = Duration::from_secs(3600);
    // Por debajo del mínimo: se usan 60 s.
    let out = call(&core, "scan_vulnerabilities", json!({ "server": "web-prod", "timeout_secs": 1 })).await;
    assert!(out.is_error && out.text.contains("pasó de 60 s") && out.text.contains("se detuvo"), "{}", out.text);
    assert!(core.backend.scan_stops.lock().unwrap().is_empty(), "el análisis se detuvo");
    assert!(core.backend.vuln_saved.lock().unwrap().is_empty());
    let last = core.audit.list().into_iter().find(|e| e.tool == "scan_vulnerabilities").unwrap();
    assert_eq!(last.status, AuditStatus::Error);
}

#[tokio::test(start_paused = true)]
async fn vuln_scan_cancel_and_one_at_a_time() {
    let core = core();
    *core.backend.scan_takes.lock().unwrap() = Duration::from_secs(300);
    let first = call(&core, "scan_vulnerabilities", json!({ "server": "web-prod" }));
    let second = async {
        // Espera a que el primero esté analizando.
        while core.backend.scan_stops.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let busy = call(&core, "scan_vulnerabilities", json!({ "server": "web-prod" })).await;
        // «Detener» del panel de actividad: cancel_exec con el exec_id del análisis.
        let id = core.backend.scan_stops.lock().unwrap().keys().next().cloned().unwrap();
        assert!(core.backend.cancel_exec(&id));
        busy
    };
    let (first, busy) = tokio::join!(first, second);
    assert!(busy.is_error && busy.text.contains("en curso"), "{}", busy.text);
    assert!(first.is_error && first.text.contains("Se canceló el análisis"), "{}", first.text);
    assert_eq!(scans(&core), 1);

    // El cliente cancela la petición: también se detiene.
    let ct = CancellationToken::new();
    let c2 = ct.clone();
    let (out, ()) = tokio::join!(
        core.call("scan_vulnerabilities", json!({ "server": "web-prod" }), None, ct),
        async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            c2.cancel();
        }
    );
    assert!(out.is_error && out.text.contains("Se canceló"), "{}", out.text);
    // Ya no está «en curso»: se puede volver a analizar.
    *core.backend.scan_takes.lock().unwrap() = Duration::from_secs(1);
    let out = call(&core, "scan_vulnerabilities", json!({ "server": "web-prod" })).await;
    assert!(!out.is_error, "{}", out.text);
}

#[test]
fn vuln_tools_are_announced_as_reads() {
    let tools = super::server::tools();
    for name in ["get_vuln_report", "scan_vulnerabilities", "get_infra_map"] {
        let t = tools.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("falta {name}"));
        assert_eq!(t.annotations.as_ref().and_then(|a| a.read_only_hint), Some(true), "{name}");
    }
    assert_eq!(tools.len(), 22);
}

// ───────────────────────── Auditoría del servidor ─────────────────────────

fn audit_fixture() -> crate::audit::model::AuditReport {
    use crate::audit::model::*;
    let check = |id: &str, status: CheckStatus, weight: u8, items: usize| Check {
        id: id.into(),
        category: "ssh".into(),
        title: format!("título {id}"),
        status,
        detail: "detalle".into(),
        items: (0..items).map(|i| format!("elemento {i}")).collect(),
        fix: (status == CheckStatus::Bad).then(|| Fix { command: "echo arreglo".into(), danger: true, manual: false, note: None }),
        weight,
    };
    AuditReport {
        id: "a1".into(),
        server_id: "s-read".into(),
        created_at: "2026-11-13T10:00:00Z".into(),
        duration_ms: 1000,
        elevated: false,
        os: "Debian 12".into(),
        score: Some(64),
        grade: Some("D".into()),
        summary: "1 grave, 1 aviso".into(),
        categories: vec![CategoryScore { id: "ssh".into(), label: "SSH".into(), score: Some(40), grade: Some("F".into()), summary: "1 grave".into() }],
        checks: vec![
            check("ssh.keys", CheckStatus::Ok, 1, 0),
            check("ssh.password", CheckStatus::Warn, 2, 0),
            check("ssh.root", CheckStatus::Bad, 3, 25),
            check("hard.cron", CheckStatus::Skip, 1, 0),
        ],
        ai: None,
    }
}

#[tokio::test]
async fn audit_report_is_a_read_and_run_audit_asks() {
    let core = core();
    let out = call(&core, "get_audit_report", json!({ "server": "db-server" })).await;
    assert!(!out.is_error && out.text.contains("run_audit"), "{}", out.text);
    core.backend.audit_saved.lock().unwrap().insert("s-read".into(), audit_fixture());
    let out = call(&core, "get_audit_report", json!({ "server": "db-server" })).await;
    let v: Value = serde_json::from_str(&out.text).unwrap();
    assert_eq!(v["score"], 64);
    assert_eq!(v["problems"].as_array().unwrap().len(), 2);
    // Lo grave primero, con su arreglo y lo afectado recortado.
    assert_eq!(v["problems"][0]["id"], "ssh.root");
    assert_eq!(v["problems"][0]["fix"]["command"], "echo arreglo");
    assert_eq!(v["problems"][0]["affected"].as_array().unwrap().len(), 10);
    assert_eq!(v["problems"][0]["moreAffected"], 15);
    assert_eq!(v["unchecked"].as_array().unwrap().len(), 1);
    assert_eq!(asked(&core), 0, "leer el informe no pide permiso");

    // run_audit pide permiso y lo hace la interfaz.
    let out = call(&core, "run_audit", json!({ "server": "db-server" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(asked(&core), 1);
    assert!(core.backend.ui_calls.lock().unwrap().iter().any(|k| k == "audit"));
    let v: Value = serde_json::from_str(&out.text).unwrap();
    assert_eq!(v["grade"], "D");
}

// ───────────────────────── sudo con contraseña ─────────────────────────

/// sudo simulado en una carpeta temporal de este equipo: el envoltorio de `sudo.rs` se prueba con un `sh`
/// de verdad. Acepta la contraseña de `<dir>/pw` por `-S` o por el askpass (`-A`), apunta cada intento en
/// `<dir>/log` («ok S», «ok A», «bad S»…) y, como no es root de verdad, `whoami` responde «root».
#[derive(Clone)]
struct FakeSudo(Arc<FakeDir>);

struct FakeDir(std::path::PathBuf);

impl Drop for FakeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) const FAKE_SUDO: &str = r#"#!/bin/sh
ask=0 std=0 val=0 non=0
while [ $# -gt 0 ]; do
  case $1 in
    -A) ask=1 ;; -S) std=1 ;; -n) non=1 ;; -k) ;; -v) val=1 ;;
    -p|-u) shift ;;
    --) shift; break ;;
    -*) ;;
    *) break ;;
  esac
  shift
done
if [ $std = 1 ] && [ $ask = 1 ]; then echo "sudo: the -A and -S options may not be used together" >&2; exit 1; fi
if [ $std = 1 ]; then IFS= read -r pw || pw=; how=S
elif [ $ask = 1 ]; then pw=$("$SUDO_ASKPASS" "[sudo] password: "); how=A
elif [ $non = 1 ]; then echo "sudo: a password is required" >&2; exit 1
else
  echo "sudo: a terminal is required to read the password; either use ssh's -t option or configure an askpass helper" >&2
  echo "sudo: a password is required" >&2; exit 1
fi
if [ "$pw" != "$(cat "$TV_FAKE_DIR/pw")" ]; then
  echo "bad $how" >> "$TV_FAKE_DIR/log"; echo "Sorry, try again." >&2; echo "sudo: 1 incorrect password attempt" >&2; exit 1
fi
echo "ok $how" >> "$TV_FAKE_DIR/log"
[ $val = 1 ] && exit 0
[ $# -gt 0 ] || exit 0
case $1 in
  whoami) echo root; exit 0 ;;
  useradd) shift; echo "useradd $*"; exit 0 ;;
esac
exec "$@"
"#;

pub(super) const SUDO_PW: &str = "s3cr3t o'k \"$x\" \\n";

impl FakeSudo {
    fn new(password: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sshorus-fakesudo-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("run")).unwrap();
        std::fs::create_dir_all(dir.join("work")).unwrap();
        std::fs::write(dir.join("pw"), password).unwrap();
        let sudo = dir.join("bin").join("sudo");
        std::fs::write(&sudo, FAKE_SUDO).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&sudo, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        FakeSudo(Arc::new(FakeDir(dir)))
    }

    fn dir(&self) -> &std::path::Path {
        &self.0 .0
    }

    fn work(&self) -> String {
        self.dir().join("work").display().to_string()
    }

    fn log(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir().join("log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    /// Lo que quedó en la carpeta temporal (XDG_RUNTIME_DIR) del envoltorio: debe quedar vacía.
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.dir().join("run"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    /// Ejecuta como el canal exec tras el arranque: `sh -c COMANDO` con `stdin` (y EOF).
    fn run(&self, command: &str, stdin: Option<&[u8]>) -> ExecResult {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let started = std::time::Instant::now();
        let path = format!("{}:{}", self.dir().join("bin").display(), std::env::var("PATH").unwrap_or_default());
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(command)
            .env("PATH", path)
            .env("SHELL", "/bin/sh")
            .env("XDG_RUNTIME_DIR", self.dir().join("run"))
            .env("TV_FAKE_DIR", self.dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let data = stdin.map(<[u8]>::to_vec).unwrap_or_default();
        let mut input = child.stdin.take().unwrap();
        let writer = std::thread::spawn(move || {
            let _ = input.write_all(&data);
        });
        let out = child.wait_with_output().unwrap();
        writer.join().unwrap();
        ExecResult {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            exit_code: out.status.code().map(|c| c as u32),
            duration_ms: started.elapsed().as_millis() as u64,
            truncated: false,
            timed_out: false,
        }
    }

    fn run_wrapped(&self, command: &str, password: &str) -> ExecResult {
        let w = super::sudo::wrap(command, password).unwrap();
        self.run(&w.command, Some(&w.stdin))
    }
}

#[test]
fn sudo_detection() {
    for c in ["sudo whoami", "echo hola | sudo tee /etc/x", "ls && sudo -u postgres psql", "x=$(sudo cat /etc/shadow)", "sudo"] {
        assert!(policy::uses_sudo(c), "{c}");
    }
    for c in ["ls", "grep -r sudoers /etc", "pseudo x", "doas apk add x", "cat /etc/sudo.conf", "visudo -c"] {
        assert!(!policy::uses_sudo(c), "{c}");
    }
}

#[test]
fn sudo_wrapper_never_puts_the_password_or_command_in_argv() {
    let w = super::sudo::wrap("sudo useradd -m ana", SUDO_PW).unwrap();
    // Línea de comandos remota (visible con ps): solo el arranque fijo.
    assert!(!w.command.contains("s3cr3t") && !w.command.contains("useradd"), "{}", w.command);
    assert!(w.command.starts_with("sh -c 'eval \"$(dd bs=1 count="), "{}", w.command);
    // La contraseña va al final del stdin, tras el script, en una sola línea.
    let stdin = String::from_utf8(w.stdin.to_vec()).unwrap();
    assert!(stdin.ends_with(&format!("\n{SUDO_PW}\n")), "{stdin}");
    assert_eq!(stdin.matches("s3cr3t").count(), 1);
    // El script no lleva la contraseña.
    assert!(!super::sudo::script("sudo x").contains("s3cr3t"));
    // Contraseñas que no se pueden enviar en una línea.
    assert!(super::sudo::wrap("sudo x", "a\nb").is_err());
    assert!(super::sudo::wrap("sudo x", "").is_err());
    assert!(super::sudo::wrap("sudo x", &"x".repeat(501)).is_err());
}

#[test]
fn sudo_failures_need_code_and_mark() {
    use super::sudo::{failure, SudoFailure};
    assert_eq!(failure(Some(97), "__TV_SUDO_BAD__\n"), Some(SudoFailure::BadPassword));
    assert_eq!(failure(Some(96), "x\n__TV_SUDO_DENIED__\n"), Some(SudoFailure::Denied));
    assert_eq!(failure(Some(95), "__TV_SUDO_TTY__"), Some(SudoFailure::TtyRequired));
    assert_eq!(failure(Some(94), "__TV_SUDO_NOTMP__"), Some(SudoFailure::NoTemp));
    assert_eq!(failure(Some(93), "__TV_NO_SUDO__"), Some(SudoFailure::NoSudo));
    // El comando del asistente puede salir con 97 por su cuenta: sin la marca no es un fallo de sudo.
    assert_eq!(failure(Some(97), "otra cosa"), None);
    assert_eq!(failure(Some(0), "__TV_SUDO_BAD__"), None);
    assert_eq!(failure(None, "__TV_SUDO_BAD__"), None);
    let mut t = format!("a {SUDO_PW} b {SUDO_PW}");
    super::sudo::redact(&mut t, SUDO_PW);
    assert_eq!(t, "a ******** b ********");
}

#[cfg(unix)]
#[test]
fn sudo_wrapper_runs_with_a_real_shell() {
    let fake = FakeSudo::new(SUDO_PW);
    let work = fake.work();

    // sudo whoami → root (con la contraseña por el askpass).
    let r = fake.run_wrapped("sudo whoami", SUDO_PW);
    assert_eq!((r.exit_code, r.stdout.as_str()), (Some(0), "root\n"), "{}", r.stderr);
    assert_eq!(fake.log(), ["ok S", "ok A"], "una comprobación (-S -v) y el comando (-A)");
    assert!(fake.leftovers().is_empty(), "{:?}", fake.leftovers());

    // Compuestos: tubería con el stdin propio, varios sudo, sudo dentro de otro shell y por xargs/env.
    let cmd = format!(
        "echo hola | sudo tee {work}/x >/dev/null && sudo sh -c 'cat {work}/x' && sudo whoami && \
         sh -c 'sudo whoami' && echo whoami | xargs sudo && env sudo whoami"
    );
    let r = fake.run_wrapped(&cmd, SUDO_PW);
    assert_eq!(r.exit_code, Some(0), "{}", r.stderr);
    assert_eq!(r.stdout, "hola\nroot\nroot\nroot\nroot\n");
    let log = fake.log();
    assert_eq!(log.iter().filter(|l| l.as_str() == "ok S").count(), 2, "{log:?}");
    assert_eq!(log.iter().filter(|l| l.as_str() == "ok A").count(), 1 + 6, "{log:?}");
    assert!(!log.iter().any(|l| l.starts_with("bad")), "{log:?}");
    assert!(fake.leftovers().is_empty());

    // Varios sudo a la vez (tubería): cada uno recibe la contraseña entera.
    for _ in 0..5 {
        let r = fake.run_wrapped("sudo whoami | sudo cat | sudo cat | sudo cat | sudo cat", SUDO_PW);
        assert_eq!((r.exit_code, r.stdout.as_str()), (Some(0), "root\n"), "{}", r.stderr);
        assert!(!fake.log().iter().any(|l| l.starts_with("bad")), "{:?}", fake.log());
    }

    // El código de salida del comando se conserva; su stdin está cerrado (no se queda esperando).
    let r = fake.run_wrapped("sudo sh -c 'exit 7'", SUDO_PW);
    assert_eq!(r.exit_code, Some(7));
    let r = fake.run_wrapped("sudo cat; echo fin", SUDO_PW);
    assert_eq!(r.stdout, "fin\n");

    // El comando no ve la contraseña: ni en variables, ni en el entorno, ni en la salida.
    let r = fake.run_wrapped("sudo true; set; env; echo \"p=[$p] c=[$c]\"; s=$(command -v sudo); cat \"$s\" \"${s%/*/*}/a\"; true", SUDO_PW);
    assert_eq!(r.exit_code, Some(0), "{}", r.stderr);
    assert!(r.stdout.contains("p=[]") && r.stdout.contains("SUDO_ASKPASS"), "{}", r.stdout);
    for out in [&r.stdout, &r.stderr] {
        assert!(!out.contains("s3cr3t"), "la contraseña apareció en la salida:\n{out}");
    }
    assert!(fake.leftovers().is_empty());

    // Un `sudo -S` del propio comando no recibe también -A (sudo no acepta los dos juntos).
    let r = fake.run_wrapped("echo nada | sudo -S true; echo $?", SUDO_PW);
    assert!(!r.stderr.contains("may not be used together"), "{}", r.stderr);
}

#[cfg(unix)]
#[test]
fn sudo_wrapper_bad_password_fails_fast_with_one_attempt() {
    let fake = FakeSudo::new(SUDO_PW);
    let r = fake.run_wrapped("sudo whoami; echo no-debe-llegar", "otra");
    assert_eq!(super::sudo::failure(r.exit_code, &r.stderr), Some(super::sudo::SudoFailure::BadPassword), "{r:?}");
    assert!(!r.stdout.contains("no-debe-llegar"));
    assert_eq!(fake.log(), ["bad S"], "un solo intento fallido");
    assert!(fake.leftovers().is_empty());
    assert!(r.duration_ms < 5000, "{} ms", r.duration_ms);
}

fn sudo_core(fake: Option<&FakeSudo>) -> McpCore<Mock> {
    let c = core();
    *c.backend.local.lock().unwrap() = fake.cloned();
    *c.backend.sudo_reply.lock().unwrap() = json!({ "elevate": true, "password": SUDO_PW });
    c
}

fn ui_kinds(core: &McpCore<Mock>) -> Vec<String> {
    core.backend.ui_calls.lock().unwrap().clone()
}

#[cfg(unix)]
#[tokio::test]
async fn run_command_with_sudo_uses_the_password_without_showing_it() {
    let fake = FakeSudo::new(SUDO_PW);
    let c = sudo_core(Some(&fake));
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo whoami" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("Código de salida: 0") && out.text.contains("root"), "{}", out.text);
    assert_eq!(asked(&c), 1, "sudo pide permiso siempre");
    assert_eq!(ui_kinds(&c), ["sudo"]);
    let (_, payload) = c.backend.ui_payloads.lock().unwrap()[0].clone();
    assert_eq!(payload["sessionId"], "ss-full");
    assert_eq!(payload["profileId"], "s-full");
    // Nada con la contraseña: ni la respuesta, ni la línea de comandos, ni el registro.
    assert!(!out.text.contains("s3cr3t"));
    assert!(ran(&c).iter().all(|cmd| !cmd.contains("s3cr3t") && !cmd.contains("whoami")));
    let log = serde_json::to_string(&c.audit.list()).unwrap();
    assert!(!log.contains("s3cr3t"), "{log}");
    assert!(log.contains("(con sudo)"), "{log}");
    assert!(fake.leftovers().is_empty());
}

#[tokio::test]
async fn sudo_output_is_redacted_and_non_sudo_commands_do_not_ask() {
    let c = sudo_core(None);
    *c.backend.exec_result.lock().unwrap() = Some(ExecResult {
        stdout: format!("la clave es {SUDO_PW}\n"),
        stderr: format!("[{SUDO_PW}]"),
        exit_code: Some(0),
        duration_ms: 1,
        truncated: false,
        timed_out: false,
    });
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo cat /tmp/x" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(!out.text.contains("s3cr3t"), "{}", out.text);
    assert!(out.text.contains("la clave es ********"), "{}", out.text);
    // La contraseña solo viajó por stdin.
    let stdin = c.backend.stdins.lock().unwrap()[0].clone().unwrap();
    assert!(String::from_utf8_lossy(&stdin).contains(SUDO_PW));

    // Sin sudo: ni se pide la contraseña ni hay stdin.
    *c.backend.exec_result.lock().unwrap() = None;
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "touch /tmp/pseudo" })).await;
    assert!(!out.is_error);
    assert_eq!(ui_kinds(&c), ["sudo"]);
    assert_eq!(c.backend.stdins.lock().unwrap()[1], None);
    assert_eq!(ran(&c)[1], "touch /tmp/pseudo");
}

#[tokio::test]
async fn sudo_not_needed_or_canceled() {
    // root o sudo sin contraseña: la interfaz dice que no hace falta y se ejecuta tal cual.
    let c = core();
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo whoami" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(ran(&c), ["sudo whoami"]);
    assert_eq!(c.backend.stdins.lock().unwrap()[0], None);

    // El usuario cierra el diálogo de la contraseña: denegado y no se ejecuta.
    *c.backend.sudo_reply.lock().unwrap() = json!({ "canceled": true });
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo whoami" })).await;
    assert!(out.is_error);
    assert_eq!(out.text, super::core::SUDO_CANCELED_MSG);
    assert_eq!(ran(&c).len(), 1);
    assert_eq!(c.audit.list()[0].status, AuditStatus::Denied);

    // SSHorus se bloquea mientras se busca la contraseña: nada.
    let c = sudo_core(None);
    c.backend.lock_on_sudo.store(true, Ordering::SeqCst);
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo whoami" })).await;
    assert_eq!(out.text, LOCKED_MSG);
    assert!(ran(&c).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn sudo_bad_password_is_clear_and_rejected_in_the_ui() {
    let fake = FakeSudo::new("la-buena");
    let c = sudo_core(Some(&fake));
    let started = std::time::Instant::now();
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo whoami" })).await;
    assert!(out.is_error);
    assert!(out.text.contains("Contraseña de sudo incorrecta"), "{}", out.text);
    assert!(!out.text.contains("s3cr3t"));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(ui_kinds(&c), ["sudo", "sudo-rejected"]);
    let (_, payload) = c.backend.ui_payloads.lock().unwrap()[1].clone();
    assert_eq!(payload["sessionId"], "ss-full");
    assert_eq!(fake.log(), ["bad S"]);
    assert_eq!(c.audit.list()[0].status, AuditStatus::Error);
}

#[cfg(unix)]
#[tokio::test]
async fn catalog_command_with_sudo_flag() {
    let fake = FakeSudo::new(SUDO_PW);
    let c = sudo_core(Some(&fake));
    c.set_catalog(vec![CatalogEntry {
        id: "usuarios.crear-usuario".into(),
        category: "Usuarios".into(),
        name: "Crear usuario".into(),
        description: None,
        command: "sudo useradd -m {{usuario}}".into(),
        dangerous: false,
        sudo: true,
        read_only: false,
        interactive: false,
        scope: None,
    }]);
    let out = call(
        &c,
        "run_catalog_command",
        json!({ "server": "web-prod", "id": "usuarios.crear-usuario", "vars": { "usuario": "ana" } }),
    )
    .await;
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("useradd -m ana"), "{}", out.text);
    assert_eq!(asked(&c), 1);
    assert_eq!(ui_kinds(&c), ["sudo"]);
    assert!(!out.text.contains("s3cr3t"));
    assert!(fake.leftovers().is_empty());
}

#[tokio::test]
async fn catalog_sudo_flag_always_asks() {
    // Marcado «sudo» aunque el texto no diga sudo: SSHorus pone la contraseña, así que se pregunta siempre.
    let c = sudo_core(None);
    c.set_catalog(vec![CatalogEntry {
        id: "x.reiniciar".into(),
        category: "X".into(),
        name: "Reiniciar".into(),
        description: None,
        command: "systemctl restart nginx".into(),
        dangerous: false,
        sudo: true,
        read_only: true,
        interactive: false,
        scope: None,
    }]);
    set_answer(&c, Answer::Give(Decision::Always));
    for _ in 0..2 {
        let out = call(&c, "run_catalog_command", json!({ "server": "web-prod", "id": "x.reiniciar" })).await;
        assert!(!out.is_error, "{}", out.text);
    }
    assert_eq!(asked(&c), 2);
    let reqs = c.backend.asked.lock().unwrap().clone();
    assert!(!reqs[0].can_remember && reqs[0].danger.iter().any(|d| d.contains("sudo")), "{:?}", reqs[0]);
    assert!(c.config.get().remembered_of("s-full").is_empty());
    assert_eq!(ui_kinds(&c), ["sudo", "sudo"]);
}

// ───────────────────────── Aceptar automáticamente ─────────────────────────

use super::core::AutoDuration;
use super::policy::{AutoGrant, AutoLevel};

#[test]
fn auto_policy_levels() {
    let empty = Default::default();
    let normal = Action::change("run_command\nuptime");
    let danger = Action::change("run_command\nrm -rf /x").with_danger(policy::danger_reasons("rm -rf /x"));
    let sudo = Action::change("run_command\nsudo ls").with_danger(policy::danger_reasons("sudo ls"));
    let dl = Action::change_on_read("download");
    let read = Action::read("list_dir");
    let d = |acc, a: &Action, lvl| policy::decide_auto("x", acc, a, &empty, lvl);

    // Apagado: como siempre.
    assert_eq!(d(Access::Full, &normal, AutoLevel::Off), Verdict::Ask { can_remember: true });
    assert_eq!(d(Access::Full, &danger, AutoLevel::Off), Verdict::Ask { can_remember: false });
    assert_eq!(d(Access::Full, &sudo, AutoLevel::Off), Verdict::Ask { can_remember: false });
    // Cambios normales: lo normal pasa; lo peligroso y sudo se siguen preguntando.
    assert_eq!(d(Access::Full, &normal, AutoLevel::Changes), Verdict::AutoAllow { danger: false });
    assert_eq!(d(Access::Full, &danger, AutoLevel::Changes), Verdict::Ask { can_remember: false });
    assert_eq!(d(Access::Full, &sudo, AutoLevel::Changes), Verdict::Ask { can_remember: false });
    // Todo: también lo peligroso y sudo (marcado como peligroso).
    assert_eq!(d(Access::Full, &normal, AutoLevel::All), Verdict::AutoAllow { danger: false });
    assert_eq!(d(Access::Full, &danger, AutoLevel::All), Verdict::AutoAllow { danger: true });
    assert_eq!(d(Access::Full, &sudo, AutoLevel::All), Verdict::AutoAllow { danger: true });
    // Las lecturas siguen siendo «automático (lectura)».
    assert_eq!(d(Access::Full, &read, AutoLevel::All), Verdict::Allow(policy::AUTO_READ));
    // Solo lectura: los cambios se rechazan y lo que se permite se sigue preguntando.
    for lvl in [AutoLevel::Changes, AutoLevel::All] {
        for a in [&normal, &danger, &sudo] {
            assert!(matches!(d(Access::Read, a, lvl), Verdict::Deny(m) if m.contains("solo lectura")));
        }
        assert_eq!(d(Access::Read, &dl, lvl), Verdict::Ask { can_remember: true });
        // Sin acceso: rechazado.
        assert!(matches!(d(Access::None, &normal, lvl), Verdict::Deny(_)));
        assert!(matches!(d(Access::None, &read, lvl), Verdict::Deny(_)));
    }
    // Una regla «siempre» sigue anotándose como regla.
    let remembered = ["run_command\nuptime".to_string()].into_iter().collect();
    assert_eq!(
        policy::decide_auto("x", Access::Full, &normal, &remembered, AutoLevel::Changes),
        Verdict::Allow(policy::REMEMBERED)
    );
}

#[test]
fn auto_effective_lock_access_and_expiry() {
    let now = 1_000_000;
    let temp = |level, until| Some(AutoGrant { level, until });
    let eff = policy::effective_auto;
    // Bloqueado o sin acceso Completo: nunca.
    assert_eq!(eff(Access::Full, true, Some(AutoLevel::All), temp(AutoLevel::All, None), now), AutoLevel::Off);
    assert_eq!(eff(Access::Read, false, Some(AutoLevel::All), temp(AutoLevel::All, None), now), AutoLevel::Off);
    assert_eq!(eff(Access::None, false, Some(AutoLevel::Changes), None, now), AutoLevel::Off);
    // Guardado («siempre»).
    assert_eq!(eff(Access::Full, false, Some(AutoLevel::Changes), None, now), AutoLevel::Changes);
    // Temporal: manda sobre el guardado mientras no caduque.
    assert_eq!(eff(Access::Full, false, Some(AutoLevel::Changes), temp(AutoLevel::All, Some(now + 1)), now), AutoLevel::All);
    assert_eq!(eff(Access::Full, false, None, temp(AutoLevel::All, Some(now)), now), AutoLevel::Off, "caducado");
    assert_eq!(eff(Access::Full, false, Some(AutoLevel::Changes), temp(AutoLevel::All, Some(now)), now), AutoLevel::Changes);
    // Hasta cerrar SSHorus: no caduca.
    assert_eq!(eff(Access::Full, false, None, temp(AutoLevel::Changes, None), u64::MAX - 1), AutoLevel::Changes);
}

#[tokio::test]
async fn auto_durations_with_simulated_clock() {
    let c = core();
    let t0 = 5_000_000;
    c.set_auto_at("s-full", AutoLevel::Changes, AutoDuration::Min15, t0).unwrap();
    assert_eq!(c.auto_level_at("s-full", t0 + 15 * 60 * 1000 - 1), AutoLevel::Changes);
    assert_eq!(c.auto_level_at("s-full", t0 + 15 * 60 * 1000), AutoLevel::Off, "15 min caducados");
    c.set_auto_at("s-full", AutoLevel::All, AutoDuration::Hour, t0).unwrap();
    assert_eq!(c.auto_level_at("s-full", t0 + 59 * 60 * 1000), AutoLevel::All);
    assert_eq!(c.auto_level_at("s-full", t0 + 60 * 60 * 1000), AutoLevel::Off, "1 h caducada");
    assert!(c.auto_list_at(t0 + 60 * 60 * 1000).is_empty());
    // Lo temporal no se guarda en mcp.json.
    assert!(c.config.get().auto_accept.is_empty());
    c.set_auto_at("s-full", AutoLevel::Changes, AutoDuration::Session, t0).unwrap();
    assert_eq!(c.auto_level_at("s-full", u64::MAX - 1), AutoLevel::Changes);
    assert!(c.config.get().auto_accept.is_empty());
    // «Siempre»: en la configuración (y quita el temporal).
    c.set_auto_at("s-full", AutoLevel::All, AutoDuration::Always, t0).unwrap();
    assert_eq!(c.config.get().auto_accept.get("s-full"), Some(&AutoLevel::All));
    let list = c.auto_list_at(t0);
    assert_eq!(list.len(), 1);
    assert!(list[0].saved && list[0].level == AutoLevel::All && list[0].server_name == "web-prod");
    // Bloqueado: no vale.
    c.backend.locked.store(true, Ordering::SeqCst);
    assert_eq!(c.auto_level_at("s-full", t0), AutoLevel::Off);
    c.backend.locked.store(false, Ordering::SeqCst);
    // Apagar: quita guardado y temporal.
    c.set_auto_at("s-full", AutoLevel::Off, AutoDuration::Always, t0).unwrap();
    assert!(c.config.get().auto_accept.is_empty());
    assert_eq!(c.auto_level_at("s-full", t0), AutoLevel::Off);
    c.set_auto_at("s-full", AutoLevel::Changes, AutoDuration::Session, t0).unwrap();
    c.auto_off_all().unwrap();
    assert!(c.auto_list_at(t0).is_empty());
    // Solo lectura y sin acceso: no se puede activar.
    assert!(c.set_auto_at("s-read", AutoLevel::Changes, AutoDuration::Session, t0).is_err());
    assert!(c.set_auto_at("s-none", AutoLevel::All, AutoDuration::Always, t0).is_err());
    // Si el servidor deja de tener acceso Completo, lo guardado desaparece.
    c.set_auto_at("s-full", AutoLevel::Changes, AutoDuration::Always, t0).unwrap();
    c.config
        .update(|cfg| {
            cfg.access.insert("s-full".into(), Access::Read);
        })
        .unwrap();
    assert!(c.config.get().auto_accept.is_empty());
}

#[tokio::test]
async fn auto_accept_in_calls() {
    let c = core();
    set_answer(&c, Answer::Give(Decision::Deny));
    // Cambios normales: no pregunta, queda marcado como automático.
    c.set_auto_at("s-full", AutoLevel::Changes, AutoDuration::Session, super::audit::now_ms()).unwrap();
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "podman restart web" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(asked(&c), 0);
    let e = c.audit.list().into_iter().find(|e| e.detail == "podman restart web").unwrap();
    assert!(e.auto && !e.auto_danger);
    assert_eq!(e.approved_by.as_deref(), Some(policy::AUTO_CHANGE));
    // Lo peligroso y sudo se siguen preguntando (y aquí se deniegan).
    for cmd in ["rm -rf /tmp/x", "sudo systemctl restart nginx"] {
        let out = call(&c, "run_command", json!({ "server": "web-prod", "command": cmd })).await;
        assert!(out.is_error && out.text.contains("denegó"), "{cmd}: {}", out.text);
    }
    assert_eq!(asked(&c), 2);
    // Solo lectura: sigue rechazando escrituras sin preguntar.
    let out = call(&c, "write_file", json!({ "server": "db-server", "path": "/tmp/a", "content": "x" })).await;
    assert!(out.is_error && out.text.contains("solo lectura"));
    assert_eq!(asked(&c), 2);

    // Todo: sudo y lo peligroso pasan solos, marcados como peligrosos.
    c.set_auto_at("s-full", AutoLevel::All, AutoDuration::Session, super::audit::now_ms()).unwrap();
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "sudo systemctl restart nginx" })).await;
    assert!(!out.is_error, "{}", out.text);
    let out = call(&c, "run_catalog_command", json!({ "server": "web-prod", "id": "podman.prune" })).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(asked(&c), 2, "no debió preguntar");
    let log = c.audit.list();
    let e = log.iter().find(|e| e.detail.contains("sudo systemctl") && e.status == AuditStatus::Ok).unwrap();
    assert!(e.auto && e.auto_danger);
    assert_eq!(e.approved_by.as_deref(), Some(policy::AUTO_DANGER));
    // La petición de la contraseña a la interfaz dice que fue automático (y nunca lleva contraseña).
    let payloads = c.backend.ui_payloads.lock().unwrap().clone();
    let (_, p) = payloads.iter().rev().find(|(k, _)| k == "sudo").unwrap();
    assert_eq!(p["auto"], json!(true));
    // Nada se recordó como regla.
    assert!(c.config.get().remembered_of("s-full").is_empty());

    // Bloqueado: no se acepta nada (se rechaza todo).
    c.backend.locked.store(true, Ordering::SeqCst);
    let before = ran(&c).len();
    let out = call(&c, "run_command", json!({ "server": "web-prod", "command": "touch /tmp/y" })).await;
    assert!(out.is_error && out.text == LOCKED_MSG, "{}", out.text);
    assert_eq!(ran(&c).len(), before);
}
