//! Asistentes de IA de línea de comandos (Claude Code y Codex): dónde están, cómo se instalan y
//! con qué argumentos se abren para darles el contexto de SSHorus y su MCP.
//!
//! Todo es lógica pura (sin tocar el disco salvo por la función `is_file` que se inyecta), así se
//! prueba igual en Linux, macOS y Windows.
//!
//! Cómo se pasa el contexto (sin escribir nada en la carpeta del usuario):
//! - Claude Code: `--append-system-prompt <texto>` y `--mcp-config <json>` (el JSON va en el propio
//!   argumento; el token NO va dentro: el puente lo lee de la variable de entorno que hereda).
//! - Codex: `-c developer_instructions="…"` y `-c mcp_servers.sshorus.*` con
//!   `env_vars = ["SSHORUS_MCP_TOKEN", …]` para que Codex le pase el token al puente.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Variable con el token del MCP (la lee el puente `sshorus-mcp`).
pub const TOKEN_ENV: &str = "SSHORUS_MCP_TOKEN";
/// Variable con el puerto del MCP.
pub const PORT_ENV: &str = "SSHORUS_MCP_PORT";
/// Nombre del servidor MCP en los asistentes.
pub const MCP_NAME: &str = "sshorus";
/// Codex corta una herramienta MCP a los 60 s por defecto; una aprobación puede tardar más.
pub const CODEX_TOOL_TIMEOUT_SECS: u32 = 900;
/// Límite del contexto (la línea de órdenes de Windows admite ~32 000 caracteres en total).
pub const MAX_CONTEXT_CHARS: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiTool {
    Claude,
    Codex,
}

impl AiTool {
    pub fn label(self) -> &'static str {
        match self {
            AiTool::Claude => "Claude Code",
            AiTool::Codex => "Codex",
        }
    }

    fn base_name(self) -> &'static str {
        match self {
            AiTool::Claude => "claude",
            AiTool::Codex => "codex",
        }
    }

    /// Archivo JavaScript del paquete de npm (para lanzarlo con node si solo hay un `.cmd`).
    fn npm_entry(self) -> &'static [&'static str] {
        match self {
            AiTool::Claude => &["@anthropic-ai", "claude-code", "cli.js"],
            AiTool::Codex => &["@openai", "codex", "bin", "codex.js"],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    Mac,
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// Lo necesario para buscar programas (inyectable en las pruebas).
#[derive(Debug, Clone)]
pub struct SearchEnv {
    pub os: Os,
    /// Carpetas de `PATH`, en orden.
    pub path: Vec<PathBuf>,
    pub home: Option<PathBuf>,
    /// Windows: `%APPDATA%` y `%LOCALAPPDATA%`.
    pub appdata: Option<PathBuf>,
    pub local_appdata: Option<PathBuf>,
    /// Carpetas `bin` de las versiones de Node instaladas con nvm (la más nueva primero).
    pub nvm_bins: Vec<PathBuf>,
}

impl SearchEnv {
    /// Carpetas habituales que no siempre están en el `PATH` de una app abierta desde el escritorio.
    pub fn extra_dirs(&self) -> Vec<PathBuf> {
        let mut v = Vec::new();
        match self.os {
            Os::Windows => {
                if let Some(h) = &self.home {
                    v.push(h.join(".local").join("bin"));
                }
                if let Some(a) = &self.appdata {
                    v.push(a.join("npm"));
                }
                if let Some(l) = &self.local_appdata {
                    v.push(l.join("Programs").join("nodejs"));
                }
                v.push(PathBuf::from(r"C:\Program Files\nodejs"));
            }
            Os::Linux | Os::Mac => {
                if let Some(h) = &self.home {
                    for d in [".local/bin", "bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".yarn/bin"] {
                        v.push(h.join(d));
                    }
                }
                v.extend(self.nvm_bins.iter().cloned());
                if self.os == Os::Mac {
                    v.push(PathBuf::from("/opt/homebrew/bin"));
                }
                v.push(PathBuf::from("/usr/local/bin"));
                v.push(PathBuf::from("/usr/bin"));
            }
        }
        v
    }

    /// `PATH` primero y luego las carpetas habituales (sin repetir).
    pub fn search_dirs(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for d in self.path.iter().cloned().chain(self.extra_dirs()) {
            if !d.as_os_str().is_empty() && !out.contains(&d) {
                out.push(d);
            }
        }
        out
    }

    fn names(&self, base: &str) -> Vec<String> {
        match self.os {
            Os::Windows => vec![format!("{base}.exe"), format!("{base}.cmd")],
            _ => vec![base.to_string()],
        }
    }
}

/// Primer programa `base` en las carpetas de búsqueda.
pub fn find_program(env: &SearchEnv, base: &str, is_file: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let names = env.names(base);
    for dir in env.search_dirs() {
        for n in &names {
            let p = dir.join(n);
            if is_file(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Cómo se arranca un programa encontrado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Programa a ejecutar.
    pub program: PathBuf,
    /// Argumentos que van antes de los nuestros (p. ej. el `.js` cuando se lanza con node).
    pub prefix: Vec<String>,
    /// Ruta que se muestra al usuario.
    pub shown: PathBuf,
}

/// Busca el asistente. En Windows, si solo está el `.cmd` de npm, se lanza su `.js` con node
/// (un `.cmd` no se puede lanzar directamente y pasarle textos largos por cmd.exe no es seguro).
pub fn resolve_tool(env: &SearchEnv, tool: AiTool, is_file: &dyn Fn(&Path) -> bool) -> Option<Resolved> {
    let found = find_program(env, tool.base_name(), is_file)?;
    let is_cmd = found.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    if !is_cmd {
        return Some(Resolved { program: found.clone(), prefix: Vec::new(), shown: found });
    }
    let dir = found.parent()?;
    let mut js = dir.join("node_modules");
    for part in tool.npm_entry() {
        js.push(part);
    }
    let node = find_program(env, "node", is_file)?;
    if !is_file(&js) {
        return None;
    }
    Some(Resolved { program: node, prefix: vec![js.display().to_string()], shown: found })
}

/// Comando oficial de instalación (se muestra antes y se ejecuta en la pestaña).
pub fn install_command(tool: AiTool, os: Os) -> &'static str {
    match (tool, os) {
        (AiTool::Claude, Os::Windows) => "irm https://claude.ai/install.ps1 | iex",
        (AiTool::Claude, _) => "curl -fsSL https://claude.ai/install.sh | bash",
        // npm.cmd: en PowerShell, `npm` (npm.ps1) puede estar bloqueado por la política de scripts.
        (AiTool::Codex, Os::Windows) => "npm.cmd install -g @openai/codex",
        (AiTool::Codex, _) => "npm install -g @openai/codex",
    }
}

/// Necesita Node.js (npm) para instalarse.
pub fn needs_node(tool: AiTool) -> bool {
    tool == AiTool::Codex
}

/// `PATH` para los procesos de la terminal local: el actual más las carpetas habituales que
/// existan (y las de los programas encontrados), sin repetir y sin cambiar el orden del usuario.
pub fn augmented_path(env: &SearchEnv, also: &[PathBuf], is_dir: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for d in &env.path {
        if !d.as_os_str().is_empty() && !out.contains(d) {
            out.push(d.clone());
        }
    }
    for d in also.iter().cloned().chain(env.extra_dirs()) {
        if !out.contains(&d) && is_dir(&d) {
            out.push(d);
        }
    }
    out
}

// ───────────────────────── Argumentos ─────────────────────────

/// MCP de SSHorus para el asistente (el token va aparte, por variable de entorno).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpLaunch {
    /// Ruta del puente `sshorus-mcp`.
    pub bridge: String,
}

/// Quita caracteres de control (salvo saltos de línea y tabuladores) y recorta el tamaño.
pub fn clean_context(text: &str) -> String {
    let mut s: String = text
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    if s.chars().count() > MAX_CONTEXT_CHARS {
        s = s.chars().take(MAX_CONTEXT_CHARS).collect();
        s.push_str("\n[…contexto recortado]");
    }
    s.trim().to_string()
}

/// Cadena TOML básica entre comillas (para los `-c clave=valor` de Codex).
pub fn toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Argumentos de `claude`.
pub fn claude_args(context: Option<&str>, mcp: Option<&McpLaunch>) -> Vec<String> {
    let mut a = Vec::new();
    if let Some(ctx) = context.map(clean_context).filter(|c| !c.is_empty()) {
        a.push("--append-system-prompt".into());
        a.push(ctx);
    }
    if let Some(m) = mcp {
        let cfg = serde_json::json!({
            "mcpServers": { MCP_NAME: { "type": "stdio", "command": m.bridge, "args": [] } }
        });
        // Va al final: `--mcp-config` acepta varios valores seguidos.
        a.push("--mcp-config".into());
        a.push(cfg.to_string());
    }
    a
}

/// Argumentos de `codex`.
pub fn codex_args(context: Option<&str>, mcp: Option<&McpLaunch>) -> Vec<String> {
    let mut a = Vec::new();
    if let Some(ctx) = context.map(clean_context).filter(|c| !c.is_empty()) {
        a.push("-c".into());
        a.push(format!("developer_instructions={}", toml_string(&ctx)));
    }
    if let Some(m) = mcp {
        let key = format!("mcp_servers.{MCP_NAME}");
        a.push("-c".into());
        a.push(format!("{key}.command={}", toml_string(&m.bridge)));
        a.push("-c".into());
        a.push(format!("{key}.args=[]"));
        // Codex no pasa todo el entorno a los servidores MCP: hay que nombrar las variables.
        a.push("-c".into());
        a.push(format!("{key}.env_vars=[{}, {}]", toml_string(TOKEN_ENV), toml_string(PORT_ENV)));
        a.push("-c".into());
        a.push(format!("{key}.tool_timeout_sec={CODEX_TOOL_TIMEOUT_SECS}"));
    }
    a
}

pub fn tool_args(tool: AiTool, context: Option<&str>, mcp: Option<&McpLaunch>) -> Vec<String> {
    match tool {
        AiTool::Claude => claude_args(context, mcp),
        AiTool::Codex => codex_args(context, mcp),
    }
}

// ───────────────────────── Shell por defecto ─────────────────────────

/// Shell del sistema y sus argumentos. Unix: `$SHELL` como shell de inicio de sesión (carga el
/// `PATH` del perfil). Windows: PowerShell 7 si está, si no Windows PowerShell.
pub fn default_shell(
    os: Os,
    shell_var: Option<&str>,
    pwsh: Option<PathBuf>,
    is_file: &dyn Fn(&Path) -> bool,
) -> (PathBuf, Vec<String>) {
    match os {
        Os::Windows => {
            let p = pwsh.unwrap_or_else(|| PathBuf::from("powershell.exe"));
            (p, vec!["-NoLogo".into()])
        }
        Os::Linux | Os::Mac => {
            let sh = shell_var
                .map(str::trim)
                .filter(|s| !s.is_empty() && is_file(Path::new(s)))
                .map(PathBuf::from)
                .or_else(|| {
                    ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"]
                        .iter()
                        .map(PathBuf::from)
                        .find(|p| is_file(p))
                })
                .unwrap_or_else(|| PathBuf::from("/bin/sh"));
            (sh, vec!["-l".into()])
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // solo Linux tiene /proc
/// Sesión de un proceso a partir de `/proc/<pid>/stat` (campo 6). El nombre va entre paréntesis
/// y puede llevar espacios, por eso se cuenta desde el último `)`.
pub fn stat_session(stat: &str) -> Option<i32> {
    let rest = &stat[stat.rfind(')')? + 1..];
    // Tras el nombre: estado(3) ppid(4) pgrp(5) session(6).
    rest.split_whitespace().nth(3)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn env(os: Os, path: &[&str]) -> SearchEnv {
        SearchEnv {
            os,
            path: path.iter().map(PathBuf::from).collect(),
            home: Some(PathBuf::from(if os == Os::Windows { r"C:\Users\ana" } else { "/home/ana" })),
            appdata: (os == Os::Windows).then(|| PathBuf::from(r"C:\Users\ana\AppData\Roaming")),
            local_appdata: (os == Os::Windows).then(|| PathBuf::from(r"C:\Users\ana\AppData\Local")),
            nvm_bins: Vec::new(),
        }
    }

    fn files(list: &[&str]) -> impl Fn(&Path) -> bool + use<> {
        let set: HashSet<PathBuf> = list.iter().map(PathBuf::from).collect();
        move |p: &Path| set.contains(p)
    }

    #[test]
    fn encuentra_en_path_antes_que_en_las_habituales() {
        let e = env(Os::Linux, &["/usr/bin", "/opt/x"]);
        let f = files(&["/opt/x/claude", "/home/ana/.local/bin/claude"]);
        assert_eq!(find_program(&e, "claude", &f), Some(PathBuf::from("/opt/x/claude")));
    }

    #[test]
    fn encuentra_en_local_bin_aunque_no_este_en_path() {
        // Una app abierta desde el escritorio no siempre tiene ~/.local/bin en el PATH.
        let e = env(Os::Linux, &["/usr/bin"]);
        let f = files(&["/home/ana/.local/bin/claude", "/home/ana/.local/bin/codex"]);
        let r = resolve_tool(&e, AiTool::Claude, &f).unwrap();
        assert_eq!(r.program, PathBuf::from("/home/ana/.local/bin/claude"));
        assert!(r.prefix.is_empty());
        assert!(resolve_tool(&e, AiTool::Codex, &f).is_some());
    }

    #[test]
    fn no_instalado() {
        let e = env(Os::Mac, &["/usr/bin"]);
        assert!(resolve_tool(&e, AiTool::Codex, &files(&[])).is_none());
    }

    #[test]
    fn nvm_y_homebrew() {
        let mut e = env(Os::Mac, &["/usr/bin"]);
        e.nvm_bins = vec![PathBuf::from("/home/ana/.nvm/versions/node/v22.1.0/bin")];
        let f = files(&["/home/ana/.nvm/versions/node/v22.1.0/bin/codex", "/opt/homebrew/bin/node"]);
        assert_eq!(
            find_program(&e, "codex", &f),
            Some(PathBuf::from("/home/ana/.nvm/versions/node/v22.1.0/bin/codex"))
        );
        assert_eq!(find_program(&e, "node", &f), Some(PathBuf::from("/opt/homebrew/bin/node")));
    }

    #[test]
    fn windows_exe_y_cmd_de_npm() {
        let e = env(Os::Windows, &[r"C:\Windows\System32"]);
        let local = PathBuf::from(r"C:\Users\ana").join(".local").join("bin").join("claude.exe");
        let f = files(&[local.to_str().unwrap()]);
        let r = resolve_tool(&e, AiTool::Claude, &f).unwrap();
        assert_eq!(r.program, local);

        // Codex instalado con npm: se lanza su .js con node.
        let npm = PathBuf::from(r"C:\Users\ana\AppData\Roaming").join("npm");
        let cmd = npm.join("codex.cmd");
        let js = npm.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js");
        let node = PathBuf::from(r"C:\Program Files\nodejs").join("node.exe");
        let f = files(&[cmd.to_str().unwrap(), js.to_str().unwrap(), node.to_str().unwrap()]);
        let r = resolve_tool(&e, AiTool::Codex, &f).unwrap();
        assert_eq!(r.program, node);
        assert_eq!(r.prefix, vec![js.display().to_string()]);
        assert_eq!(r.shown, cmd);

        // Sin node no se puede lanzar el .cmd.
        let f = files(&[cmd.to_str().unwrap(), js.to_str().unwrap()]);
        assert!(resolve_tool(&e, AiTool::Codex, &f).is_none());
    }

    #[test]
    fn comandos_de_instalacion() {
        assert_eq!(install_command(AiTool::Claude, Os::Linux), "curl -fsSL https://claude.ai/install.sh | bash");
        assert_eq!(install_command(AiTool::Claude, Os::Mac), "curl -fsSL https://claude.ai/install.sh | bash");
        assert_eq!(install_command(AiTool::Claude, Os::Windows), "irm https://claude.ai/install.ps1 | iex");
        assert_eq!(install_command(AiTool::Codex, Os::Linux), "npm install -g @openai/codex");
        assert_eq!(install_command(AiTool::Codex, Os::Windows), "npm.cmd install -g @openai/codex");
        assert!(needs_node(AiTool::Codex));
        assert!(!needs_node(AiTool::Claude));
    }

    #[test]
    fn path_aumentado_sin_repetir() {
        let e = env(Os::Linux, &["/usr/bin", "/home/ana/.local/bin"]);
        let dirs = |p: &Path| p == Path::new("/home/ana/.local/bin") || p == Path::new("/opt/node/bin") || p == Path::new("/usr/local/bin");
        let p = augmented_path(&e, &[PathBuf::from("/opt/node/bin")], &dirs);
        assert_eq!(
            p,
            vec![
                PathBuf::from("/usr/bin"),
                PathBuf::from("/home/ana/.local/bin"),
                PathBuf::from("/opt/node/bin"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
    }

    #[test]
    fn claude_con_contexto_y_mcp() {
        let m = McpLaunch { bridge: "/opt/SSHorus/sshorus-mcp".into() };
        let a = claude_args(Some("Hola\nmundo"), Some(&m));
        assert_eq!(a[0], "--append-system-prompt");
        assert_eq!(a[1], "Hola\nmundo");
        assert_eq!(a[2], "--mcp-config");
        let v: serde_json::Value = serde_json::from_str(&a[3]).unwrap();
        assert_eq!(v["mcpServers"]["sshorus"]["command"], "/opt/SSHorus/sshorus-mcp");
        assert_eq!(v["mcpServers"]["sshorus"]["type"], "stdio");
        // El token nunca va en los argumentos.
        assert!(!a[3].contains("TOKEN") && !a[3].contains("env"));
        assert_eq!(a.len(), 4);
    }

    #[test]
    fn claude_sin_nada() {
        assert!(claude_args(None, None).is_empty());
        assert!(claude_args(Some("  \n "), None).is_empty());
    }

    #[test]
    fn codex_con_contexto_y_mcp() {
        let m = McpLaunch { bridge: r#"C:\Program Files\SSHorus\sshorus-mcp.exe"#.into() };
        let a = codex_args(Some("Línea \"uno\"\n\tdos"), Some(&m));
        assert_eq!(
            a,
            vec![
                "-c",
                r#"developer_instructions="Línea \"uno\"\n\tdos""#,
                "-c",
                r#"mcp_servers.sshorus.command="C:\\Program Files\\SSHorus\\sshorus-mcp.exe""#,
                "-c",
                "mcp_servers.sshorus.args=[]",
                "-c",
                r#"mcp_servers.sshorus.env_vars=["SSHORUS_MCP_TOKEN", "SSHORUS_MCP_PORT"]"#,
                "-c",
                "mcp_servers.sshorus.tool_timeout_sec=900",
            ]
        );
    }

    #[test]
    fn toml_escapa_controles() {
        assert_eq!(toml_string("a\u{7f}b\u{1}"), "\"a\\u007Fb\\u0001\"");
        assert_eq!(toml_string(r"c:\x"), r#""c:\\x""#);
    }

    #[test]
    fn contexto_limpio_y_recortado() {
        assert_eq!(clean_context("a\u{1b}[31mb\r\nc"), "a[31mb\nc");
        let big = "x".repeat(MAX_CONTEXT_CHARS + 50);
        let c = clean_context(&big);
        assert!(c.ends_with("[…contexto recortado]"));
        assert!(c.chars().count() < MAX_CONTEXT_CHARS + 40);
    }

    #[test]
    fn shell_por_defecto() {
        let f = files(&["/usr/bin/zsh", "/bin/bash"]);
        assert_eq!(default_shell(Os::Linux, Some("/usr/bin/zsh"), None, &f).0, PathBuf::from("/usr/bin/zsh"));
        assert_eq!(default_shell(Os::Linux, Some("/no/existe"), None, &f).0, PathBuf::from("/bin/bash"));
        assert_eq!(default_shell(Os::Mac, None, None, &f).1, vec!["-l".to_string()]);
        let (p, a) = default_shell(Os::Windows, None, Some(PathBuf::from(r"C:\pwsh\pwsh.exe")), &f);
        assert_eq!(p, PathBuf::from(r"C:\pwsh\pwsh.exe"));
        assert_eq!(a, vec!["-NoLogo".to_string()]);
        assert_eq!(default_shell(Os::Windows, None, None, &f).0, PathBuf::from("powershell.exe"));
    }

    #[test]
    fn sesion_desde_stat() {
        assert_eq!(stat_session("1234 (bash) S 1 1234 1234 34816 1234 4194560"), Some(1234));
        assert_eq!(stat_session("99 (mi (raro) prog) R 5 77 88 0"), Some(88));
        assert_eq!(stat_session("basura"), None);
    }
}
