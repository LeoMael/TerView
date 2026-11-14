//! Terminal local: pestañas con una shell **del propio equipo** (no de un servidor), y lanzar
//! Claude Code o Codex con el contexto de SSHorus y su MCP ya configurado.
//!
//! Igual que las terminales SSH: la salida llega por el `Channel` de `local_term_open` (bytes
//! crudos) y, al terminar, se emite `EV_TERMINAL_EXIT` con el id. Así la interfaz usa la misma vista.
//!
//! Lo que SSHorus NUNCA hace aquí: leer o copiar `~/.claude` ni `~/.codex`, escribir archivos en la
//! carpeta del usuario, ni poner el token del MCP en un archivo o en los argumentos (va por
//! variable de entorno al proceso hijo).

pub mod aicli;
pub mod aliases;
pub mod pty;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::mcp::McpState;
use crate::storage::ssh_config::{load_overrides, SshEnv};
use crate::storage::ProfileStore;
use crate::types::{TerminalExit, EV_TERMINAL_EXIT};
use aicli::{AiTool, McpLaunch, Os, SearchEnv};
use pty::LocalPty;

// ───────────────────────── Ajustes ─────────────────────────

/// Ajustes de la terminal local y de los asistentes (Ajustes → Terminal local e IA).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalAiSettings {
    /// Cómo trabaja el asistente con los servidores: "both" | "direct" (ssh) | "mcp".
    pub mode: String,
    /// Incluir la lista de servidores (nombre, alias, usuario…).
    pub include_servers: bool,
    /// Incluir host y puerto de cada servidor.
    pub include_hosts: bool,
    /// Incluir los proyectos.
    pub include_projects: bool,
    /// Incluir la pestaña que se estaba mirando.
    pub include_active: bool,
    /// Incluir la fecha.
    pub include_date: bool,
    /// Última carpeta elegida para abrir terminales locales (None = carpeta personal).
    pub last_cwd: Option<String>,
}

impl Default for LocalAiSettings {
    fn default() -> Self {
        LocalAiSettings {
            mode: "both".into(),
            include_servers: true,
            include_hosts: true,
            include_projects: true,
            include_active: true,
            include_date: true,
            last_cwd: None,
        }
    }
}

impl LocalAiSettings {
    pub fn sanitized(mut self) -> Self {
        if !matches!(self.mode.as_str(), "both" | "direct" | "mcp") {
            self.mode = "both".into();
        }
        if self.last_cwd.as_deref().is_some_and(|c| c.trim().is_empty()) {
            self.last_cwd = None;
        }
        self
    }
}

// ───────────────────────── Estado ─────────────────────────

/// Terminales locales abiertas: termId → PTY.
#[derive(Default)]
pub struct LocalTermStore {
    terms: Mutex<HashMap<String, LocalPty>>,
}

impl LocalTermStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, LocalPty>> {
        self.terms.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, id: &str) -> AppResult<LocalPty> {
        self.lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))
    }

    /// Cierra todas (al cerrar la app).
    pub fn close_all(&self) {
        for (_, t) in self.lock().drain() {
            t.close();
        }
    }
}

// ───────────────────────── Entorno ─────────────────────────

/// Carpetas `bin` de nvm, la versión más nueva primero.
fn nvm_bins(home: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) else { return Vec::new() };
    let mut v: Vec<(Vec<u64>, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let ver: Vec<u64> = name.trim_start_matches('v').split('.').filter_map(|p| p.parse().ok()).collect();
            (!ver.is_empty()).then(|| (ver, e.path().join("bin")))
        })
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, p)| p).collect()
}

fn search_env() -> SearchEnv {
    let home = dirs::home_dir();
    SearchEnv {
        os: Os::current(),
        path: std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default(),
        nvm_bins: home.as_deref().map(nvm_bins).unwrap_or_default(),
        appdata: std::env::var_os("APPDATA").map(PathBuf::from),
        local_appdata: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        home,
    }
}

fn is_file(p: &Path) -> bool {
    p.is_file()
}

fn is_dir(p: &Path) -> bool {
    p.is_dir()
}

/// Shell del sistema (programa y argumentos).
fn shell_command(env: &SearchEnv) -> (PathBuf, Vec<String>) {
    let pwsh = if env.os == Os::Windows { aicli::find_program(env, "pwsh", &is_file) } else { None };
    let shell_var = std::env::var("SHELL").ok();
    aicli::default_shell(env.os, shell_var.as_deref(), pwsh, &is_file)
}

/// Variables que pone el lanzador de AppImage para la propia app: en una shell del usuario
/// romperían programas del sistema (bibliotecas de la app en lugar de las suyas).
const APPIMAGE_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GTK_THEME",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_BACKEND",
    "GIO_MODULE_DIR",
    "GI_TYPELIB_PATH",
    "GSETTINGS_SCHEMA_DIR",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
];

/// Comando base con el entorno de una terminal: tipo de terminal, `PATH` completo y sin restos
/// del lanzador de la app.
fn base_command(program: &Path, env: &SearchEnv, extra_path: &[PathBuf], cwd: &Path) -> AppResult<CommandBuilder> {
    let mut cmd = CommandBuilder::new(program);
    cmd.cwd(cwd);
    let mut path = aicli::augmented_path(env, extra_path, &is_dir);
    if let Some(appdir) = std::env::var_os("APPDIR").filter(|_| std::env::var_os("APPIMAGE").is_some()) {
        let appdir = PathBuf::from(appdir);
        path.retain(|d| !d.starts_with(&appdir));
        for k in APPIMAGE_VARS {
            cmd.env_remove(k);
        }
    }
    // Lo que puso SSHorus para su propia ventana (Linux + NVIDIA).
    cmd.env_remove("WEBKIT_DISABLE_DMABUF_RENDERER");
    let joined: OsString =
        std::env::join_paths(&path).map_err(|e| AppError::Invalid(format!("PATH no válido: {e}")))?;
    cmd.env("PATH", joined);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "SSHorus");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // El token solo lo recibe un asistente lanzado con el MCP.
    cmd.env_remove(aicli::TOKEN_ENV);
    cmd.env_remove(aicli::PORT_ENV);
    Ok(cmd)
}

/// Carpeta de trabajo: la pedida si existe; si no, la carpeta personal.
fn resolve_cwd(cwd: Option<&str>) -> AppResult<PathBuf> {
    if let Some(c) = cwd.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        if p.is_dir() {
            return Ok(p);
        }
        return Err(AppError::NotFound(format!("la carpeta {c} no existe")));
    }
    dirs::home_dir().ok_or_else(|| AppError::Io("no se encontró la carpeta personal del usuario".into()))
}

// ───────────────────────── Tipos de la interfaz ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTermInfo {
    pub home: String,
    /// Shell que se abre por defecto.
    pub shell: String,
    /// "linux" | "mac" | "windows"
    pub os: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolInfo {
    pub tool: AiTool,
    pub label: String,
    pub installed: bool,
    pub path: Option<String>,
    /// Comando oficial para instalarlo en este sistema.
    pub install_command: String,
    /// Hace falta Node.js (npm) para instalarlo.
    pub needs_node: bool,
    /// Hay npm (para el aviso «falta Node.js»).
    pub npm_found: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLaunch {
    pub tool: AiTool,
    /// Contexto de SSHorus (lo arma la interfaz; nunca lleva secretos).
    pub context: Option<String>,
    /// Configurar el MCP de SSHorus.
    pub mcp: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOpen {
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Sin esto se abre la shell.
    pub launch: Option<AiLaunch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOpened {
    pub term_id: String,
    pub cwd: String,
    /// Programa que corre (ruta).
    pub program: String,
    /// El asistente se abrió con el MCP de SSHorus.
    pub mcp: bool,
    /// Algo no salió como se pidió (p. ej. el MCP está apagado y se abrió solo con el contexto).
    pub warning: Option<String>,
}

// ───────────────────────── Comandos ─────────────────────────

#[tauri::command]
pub async fn local_term_info() -> AppResult<LocalTermInfo> {
    let env = search_env();
    let (shell, _) = shell_command(&env);
    Ok(LocalTermInfo {
        home: dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default(),
        shell: shell.display().to_string(),
        os: match env.os {
            Os::Linux => "linux",
            Os::Mac => "mac",
            Os::Windows => "windows",
        }
        .into(),
    })
}

/// ¿Están instalados Claude Code y Codex? (Solo busca los programas; no lee su configuración.)
#[tauri::command]
pub async fn local_ai_detect() -> AppResult<Vec<AiToolInfo>> {
    tokio::task::spawn_blocking(|| {
        let env = search_env();
        let npm_found = aicli::find_program(&env, "npm", &is_file).is_some();
        [AiTool::Claude, AiTool::Codex]
            .into_iter()
            .map(|tool| {
                let r = aicli::resolve_tool(&env, tool, &is_file);
                AiToolInfo {
                    tool,
                    label: tool.label().into(),
                    installed: r.is_some(),
                    path: r.map(|r| r.shown.display().to_string()),
                    install_command: aicli::install_command(tool, env.os).into(),
                    needs_node: aicli::needs_node(tool),
                    npm_found,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::Io(format!("tarea interna interrumpida: {e}")))
}

/// Alias de `~/.ssh/config` exportados por SSHorus que de verdad llevan a cada servidor.
#[tauri::command]
pub async fn local_ai_ssh_aliases(store: State<'_, ProfileStore>) -> AppResult<Vec<aliases::ExportedAlias>> {
    let servers = store.data().servers;
    tokio::task::spawn_blocking(move || {
        let env = SshEnv::user()?;
        let text = match std::fs::read_to_string(&env.config) {
            Ok(t) => t,
            Err(_) => return Ok(Vec::new()),
        };
        Ok(aliases::exported_aliases(&text, &servers, &load_overrides(&env)))
    })
    .await
    .map_err(|e| AppError::Io(format!("tarea interna interrumpida: {e}")))?
}

/// Prepara el MCP para el asistente: puente y token. Si no se puede, explica por qué.
async fn prepare_mcp(app: &AppHandle) -> Result<(McpLaunch, String, u16), String> {
    let state = app.state::<McpState>();
    let st = state.status();
    if !st.enabled {
        return Err("El MCP de SSHorus está apagado: el asistente se abrió solo con el contexto.".into());
    }
    if !st.running {
        let why = st.error.unwrap_or_else(|| "no está en marcha".into());
        return Err(format!("El MCP de SSHorus no está disponible ({why}): el asistente se abrió solo con el contexto."));
    }
    if !st.bridge_found {
        return Err(format!(
            "No se encontró el puente {} junto a SSHorus: el asistente se abrió solo con el contexto.",
            crate::mcp::bridge_file_name()
        ));
    }
    let token = crate::mcp::ensure_token(&state).await.map_err(|e| format!("No se pudo leer el token del MCP: {e}"))?;
    Ok((McpLaunch { bridge: st.bridge_path }, token.to_string(), st.port))
}

/// Abre una terminal local: la shell del sistema o, con `launch`, Claude Code / Codex.
#[tauri::command]
pub async fn local_term_open(
    app: AppHandle,
    terms: State<'_, LocalTermStore>,
    opts: LocalOpen,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<LocalOpened> {
    let cwd = resolve_cwd(opts.cwd.as_deref())?;
    let env = tokio::task::spawn_blocking(search_env)
        .await
        .map_err(|e| AppError::Io(format!("tarea interna interrumpida: {e}")))?;

    let mut warning = None;
    let mut with_mcp = false;
    let (cmd, shown) = match &opts.launch {
        None => {
            let (shell, args) = shell_command(&env);
            let mut cmd = base_command(&shell, &env, &[], &cwd)?;
            cmd.args(&args);
            (cmd, shell)
        }
        Some(l) => {
            let resolved = aicli::resolve_tool(&env, l.tool, &is_file)
                .ok_or_else(|| AppError::NotFound(format!("{} no está instalado en este equipo", l.tool.label())))?;
            let mcp = if l.mcp {
                match prepare_mcp(&app).await {
                    Ok(m) => Some(m),
                    Err(w) => {
                        warning = Some(w);
                        None
                    }
                }
            } else {
                None
            };
            // La carpeta del programa (y la de node) también van al PATH: el asistente lanza
            // sus propios procesos y debe encontrarse a sí mismo.
            let mut extra = Vec::new();
            for p in [&resolved.program, &resolved.shown] {
                if let Some(d) = p.parent() {
                    extra.push(d.to_path_buf());
                }
            }
            let mut cmd = base_command(&resolved.program, &env, &extra, &cwd)?;
            cmd.args(&resolved.prefix);
            cmd.args(aicli::tool_args(l.tool, l.context.as_deref(), mcp.as_ref().map(|m| &m.0)));
            if let Some((_, token, port)) = &mcp {
                cmd.env(aicli::TOKEN_ENV, token);
                cmd.env(aicli::PORT_ENV, port.to_string());
                with_mcp = true;
            }
            (cmd, resolved.shown)
        }
    };

    let term_id = uuid::Uuid::new_v4().to_string();
    let exit_id = term_id.clone();
    let app2 = app.clone();
    let handle = pty::spawn(
        cmd,
        opts.cols,
        opts.rows,
        move |bytes| {
            if let Err(e) = on_data.send(InvokeResponseBody::Raw(bytes)) {
                log::debug!("terminal local: no se pudo enviar a la interfaz: {e}");
            }
        },
        move |code| {
            app2.state::<LocalTermStore>().lock().remove(&exit_id);
            let _ = app2.emit(EV_TERMINAL_EXIT, TerminalExit { term_id: exit_id, code });
        },
    )?;
    {
        let mut map = terms.lock();
        if !handle.is_finished() {
            map.insert(term_id.clone(), handle);
        }
    }
    Ok(LocalOpened {
        term_id,
        cwd: cwd.display().to_string(),
        program: shown.display().to_string(),
        mcp: with_mcp,
        warning,
    })
}

#[tauri::command]
pub async fn local_term_write(terms: State<'_, LocalTermStore>, term_id: String, data: String) -> AppResult<()> {
    terms.get(&term_id)?.write(data.into_bytes())
}

#[tauri::command]
pub async fn local_term_resize(terms: State<'_, LocalTermStore>, term_id: String, cols: u16, rows: u16) -> AppResult<()> {
    terms.get(&term_id)?.resize(cols, rows)
}

/// Cierra la terminal: termina el programa y todo lo que lanzó.
#[tauri::command]
pub async fn local_term_close(terms: State<'_, LocalTermStore>, term_id: String) -> AppResult<()> {
    match terms.lock().remove(&term_id) {
        Some(t) => {
            t.close();
            Ok(())
        }
        None => Err(AppError::NotFound(format!("terminal {term_id}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn ajustes_saneados() {
        let s = LocalAiSettings { mode: "otro".into(), last_cwd: Some("  ".into()), ..Default::default() }.sanitized();
        assert_eq!(s.mode, "both");
        assert_eq!(s.last_cwd, None);
        // Un settings.json antiguo (sin `localAi`) se lee con los valores por defecto.
        let st: crate::types::Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(st.local_ai, LocalAiSettings::default());
    }

    /// Ejecuta el programa real con los argumentos que usaría SSHorus (solo si está instalado).
    /// `cargo test --lib localterm::tests::asistentes_reales -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn asistentes_reales() {
        let env = search_env();
        let run = |tool: AiTool, extra: &[&str]| -> Option<String> {
            let r = aicli::resolve_tool(&env, tool, &is_file)?;
            let home = dirs::home_dir().unwrap();
            let mut cmd = base_command(&r.program, &env, &[], &home).unwrap();
            cmd.args(&r.prefix);
            let m = McpLaunch { bridge: "/opt/sshorus/sshorus-mcp".into() };
            cmd.args(aicli::tool_args(tool, Some("Contexto \"de\" prueba\ncon dos líneas"), Some(&m)));
            cmd.args(extra);
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            let (etx, erx) = mpsc::channel::<Option<u32>>();
            let on_data = move |b| {
                let _ = tx.send(b);
            };
            let _t = pty::spawn(cmd, 200, 50, on_data, move |c| {
                let _ = etx.send(c);
            })
            .unwrap();
            let code = erx.recv_timeout(Duration::from_secs(30)).expect("no terminó");
            let out = String::from_utf8_lossy(&rx.try_iter().flatten().collect::<Vec<u8>>()).to_string();
            println!("{tool:?} → código {code:?}\n{out}");
            Some(out)
        };
        // Codex: los -c se aplican y el servidor MCP queda con env_vars (sin token en la configuración).
        if let Some(out) = run(AiTool::Codex, &["mcp", "get", "sshorus", "--json"]) {
            assert!(out.contains("SSHORUS_MCP_TOKEN"), "codex no recibió env_vars");
            assert!(out.contains("/opt/sshorus/sshorus-mcp"));
            assert!(out.contains("900"));
        }
        if let Some(out) = run(AiTool::Claude, &["--version"]) {
            assert!(out.contains("Claude Code"));
        }
    }
}
