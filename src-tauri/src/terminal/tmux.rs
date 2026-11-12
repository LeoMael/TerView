//! Terminales persistentes con tmux.
//!
//! Cada terminal de TerView puede vivir dentro de una sesión tmux con nombre propio
//! (`terview-<id>`). Si se corta la red o se cierra la app, la sesión sigue en el servidor y al
//! volver se engancha a ella (`new-session -A`).
//!
//! Decisiones:
//! - Servidor tmux propio (`-L terview`) y sin leer configuraciones (`-f /dev/null`): no toca el
//!   `~/.tmux.conf` del usuario ni sus sesiones, y `list-sessions` solo ve las de TerView.
//!   Desde una shell normal se llega con `tmux -L terview attach -t terview-…`.
//! - La configuración va por línea de comandos, solo al arrancar ese servidor (así no se repiten
//!   los valores que se añaden a listas como `terminal-overrides`).
//! - Sin pantalla alternativa hacia fuera (`smcup@:rmcup@`): tmux dibuja en la pantalla normal de
//!   xterm.js, así la rueda del ratón, el historial, la búsqueda (Ctrl+Mayús+F), la selección y los
//!   enlaces siguen funcionando como en una terminal normal.
//! - Sin tecla prefijo (Ctrl+B llega a los programas) ni barra de estado.
//!
//! Los scripts se ejecutan con `sh -c '…'` porque el shell de login puede no ser POSIX: dentro NO
//! puede haber comillas simples, «!» ni saltos de línea.

use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::snippets::exec;
use crate::ssh::SshSession;
use crate::types::{TmuxList, TmuxSession};

/// Socket del servidor tmux propio de TerView (`tmux -L terview`).
pub const SOCKET: &str = "terview";
/// Prefijo de las sesiones de TerView.
pub const PREFIX: &str = "terview-";
/// Versión mínima: `new-session -A` llegó en tmux 1.8.
pub const MIN_VERSION: TmuxVersion = TmuxVersion { major: 1, minor: 8 };
/// Líneas de historial que se vuelcan al reabrir una sesión en una terminal nueva.
const REPLAY_LINES: u32 = 10_000;
/// Historial que guarda tmux por terminal.
const HISTORY_LIMIT: u32 = 50_000;
/// Límite de las comprobaciones (s).
const PROBE_TIMEOUT_SECS: u32 = 8;

/// Busca tmux: primero en el PATH y luego en rutas típicas (el PATH de un canal exec suele ser
/// mínimo; en macOS Homebrew instala en /opt/homebrew/bin). Deja la ruta en `$t` (vacía si no hay).
const FIND_TMUX: &str = "t=$(command -v tmux 2>/dev/null); \
case \"$t\" in /*) ;; *) t= ;; esac; \
for d in /usr/local/bin /opt/homebrew/bin /usr/bin /bin /usr/pkg/bin; do \
if [ -z \"$t\" ] && [ -x \"$d/tmux\" ]; then t=\"$d/tmux\"; fi; done";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TmuxVersion {
    pub major: u32,
    pub minor: u32,
}

impl TmuxVersion {
    /// Lee la salida de `tmux -V` ("tmux 3.4", "tmux 3.3a", "tmux next-3.5"). None si no hay número.
    pub fn parse(s: &str) -> Option<Self> {
        let start = s.find(|c: char| c.is_ascii_digit())?;
        let rest = &s[start..];
        let mut parts = rest.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor_txt: String = parts
            .next()
            .unwrap_or("0")
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let minor = minor_txt.parse().unwrap_or(0);
        Some(Self { major, minor })
    }

    const fn at_least(self, major: u32, minor: u32) -> bool {
        self.major > major || (self.major == major && self.minor >= minor)
    }
}

/// tmux encontrado en el servidor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxProbe {
    /// Ruta absoluta del ejecutable.
    pub path: String,
    /// Texto de `tmux -V`.
    pub version_text: String,
    /// None si no se pudo leer el número (se asume una versión moderna).
    pub version: Option<TmuxVersion>,
}

impl TmuxProbe {
    /// Versión con la que se eligen las opciones (desconocida = moderna).
    fn effective_version(&self) -> TmuxVersion {
        self.version.unwrap_or(TmuxVersion { major: 3, minor: 0 })
    }

    /// true si la versión permite engancharse (`new-session -A`).
    pub fn supported(&self) -> bool {
        self.effective_version() >= MIN_VERSION
    }
}

/// Resultado de buscar tmux.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeResult {
    Found(TmuxProbe),
    NotInstalled,
}

/// Nombre válido para una sesión de TerView: `terview-` y luego letras, números, `-` o `_`.
/// Así nunca hace falta escaparlo dentro de los scripts.
pub fn valid_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(PREFIX) else { return false };
    !rest.is_empty()
        && name.len() <= 64
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn check_name(name: &str) -> AppResult<()> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("nombre de sesión tmux no válido: {name}")))
    }
}

/// Ruta segura para escribirla entre comillas dobles en el script.
fn safe_path(p: &str) -> bool {
    p.starts_with('/')
        && p.len() < 512
        && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._+-".contains(&b))
}

/// Script que dice si hay tmux, dónde y qué versión.
pub fn probe_command() -> String {
    format!(
        "sh -c '{FIND_TMUX}; if [ -z \"$t\" ]; then echo tv_tmux=0; exit 0; fi; \
         echo tv_tmux=1; echo \"tv_path=$t\"; echo \"tv_version=$(\"$t\" -V 2>/dev/null)\"'"
    )
}

/// Lee las líneas `clave=valor` que empiezan por `tv_`.
fn kv(stdout: &str, key: &str) -> Option<String> {
    stdout.lines().find_map(|l| {
        let l = l.trim_end_matches('\r');
        l.strip_prefix(key)
            .and_then(|r| r.strip_prefix('='))
            .map(|v| v.trim().to_string())
    })
}

/// Interpreta la salida de [`probe_command`]. None si la salida no tiene el formato esperado
/// (p. ej. un servidor Windows sin `sh`).
pub fn parse_probe(stdout: &str) -> Option<ProbeResult> {
    match kv(stdout, "tv_tmux")?.as_str() {
        "0" => Some(ProbeResult::NotInstalled),
        "1" => {
            let path = kv(stdout, "tv_path")?;
            if !safe_path(&path) {
                // Ruta rara: mejor no usarla que escaparla mal.
                return Some(ProbeResult::NotInstalled);
            }
            let version_text = kv(stdout, "tv_version").unwrap_or_default();
            Some(ProbeResult::Found(TmuxProbe {
                version: TmuxVersion::parse(&version_text),
                version_text,
                path,
            }))
        }
        _ => None,
    }
}

/// Opciones del servidor tmux de TerView (se aplican al arrancarlo, antes de crear la primera
/// ventana, para que valgan `default-terminal` e `history-limit`).
pub fn server_options(v: TmuxVersion) -> Vec<String> {
    let mut o: Vec<String> = vec![
        // Que se sienta como una terminal normal: sin barra, sin prefijo, Esc inmediato.
        "set -g status off".into(),
        "set -g prefix None".into(),
        "set -g prefix2 None".into(),
        "set -g escape-time 10".into(),
        format!("set -g history-limit {HISTORY_LIMIT}"),
        // $tt lo elige el script: tmux-256color si el servidor lo conoce, si no screen-256color.
        "set -g default-terminal \"$tt\"".into(),
        // Sin pantalla alternativa hacia xterm.js (historial, rueda y búsqueda de xterm.js) y color real.
        "set -ga terminal-overrides \",xterm*:smcup@:rmcup@,xterm-256color:Tc\"".into(),
        // El tamaño lo manda la ventana que se usó por última vez.
        "setw -g aggressive-resize on".into(),
    ];
    if v.at_least(3, 1) {
        o.push("set -g window-size latest".into());
    }
    if v.at_least(3, 2) {
        o.push("set -ga terminal-features \",xterm*:RGB\"".into());
    }
    if v.at_least(3, 4) {
        o.push("set -ga terminal-features \",xterm*:hyperlinks\"".into());
    }
    o
}

/// Comando del canal (con PTY) que abre o reabre la sesión `name`.
///
/// - Si la sesión existe y `replay`, primero escribe su historial (lo que ya no cabe en pantalla) y
///   `rows` saltos de línea: así pasa al historial de xterm.js y tmux redibuja la pantalla encima.
/// - Si el servidor tmux de TerView ya corre, solo `new-session -A` (crear o engancharse).
/// - Si no, lo arranca con la configuración de [`server_options`].
pub fn attach_command(probe: &TmuxProbe, name: &str, rows: u32, replay: bool) -> AppResult<String> {
    check_name(name)?;
    if !safe_path(&probe.path) {
        return Err(AppError::Invalid("ruta de tmux no válida".into()));
    }
    let t = &probe.path;
    let mut script = format!("t=\"{t}\"; s=\"{name}\"; ");
    if replay {
        let pad = "\\n".repeat(rows.clamp(1, 300) as usize);
        script.push_str(&format!(
            "if \"$t\" -L {SOCKET} has-session -t \"$s\" 2>/dev/null; then \
             h=$(\"$t\" -L {SOCKET} capture-pane -p -e -J -S -{REPLAY_LINES} -E -1 -t \"$s:\" 2>/dev/null); \
             if [ -n \"$h\" ]; then printf \"%s\\n\" \"$h\"; printf \"{pad}\"; fi; fi; "
        ));
    }
    script.push_str(&format!(
        "if \"$t\" -L {SOCKET} list-sessions >/dev/null 2>&1; then \
         exec \"$t\" -u -2 -L {SOCKET} new-session -A -s \"$s\"; fi; \
         tt=screen-256color; if infocmp tmux-256color >/dev/null 2>&1; then tt=tmux-256color; fi; \
         exec \"$t\" -u -2 -L {SOCKET} -f /dev/null start-server"
    ));
    for opt in server_options(probe.effective_version()) {
        script.push_str(" \\; ");
        script.push_str(&opt);
    }
    script.push_str(" \\; new-session -A -s \"$s\"");
    Ok(format!("sh -c '{script}'"))
}

/// Script que lista las sesiones de TerView.
pub fn list_command() -> String {
    format!(
        "sh -c '{FIND_TMUX}; if [ -z \"$t\" ]; then echo tv_tmux=0; exit 0; fi; \
         echo tv_tmux=1; echo \"tv_version=$(\"$t\" -V 2>/dev/null)\"; \
         \"$t\" -L {SOCKET} list-sessions -F \"tv_s=#{{session_name}}|#{{session_created}}|#{{session_activity}}|#{{session_attached}}|#{{session_windows}}|#{{pane_current_command}}|#{{pane_current_path}}\" 2>/dev/null; \
         echo tv_end=1'"
    )
}

/// Interpreta la salida de [`list_command`]: solo sesiones con nombre de TerView, más recientes primero.
pub fn parse_list(stdout: &str) -> TmuxList {
    let installed = kv(stdout, "tv_tmux").as_deref() == Some("1");
    let version = kv(stdout, "tv_version").filter(|v| !v.is_empty());
    let mut sessions: Vec<TmuxSession> = stdout
        .lines()
        .filter_map(|l| l.trim_end_matches('\r').strip_prefix("tv_s="))
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(7, '|').collect();
            if f.len() < 7 || !valid_name(f[0]) {
                return None;
            }
            Some(TmuxSession {
                name: f[0].to_string(),
                created: f[1].parse().ok(),
                activity: f[2].parse().ok(),
                attached: f[3].parse().unwrap_or(0),
                windows: f[4].parse().unwrap_or(1),
                command: f[5].to_string(),
                path: f[6].to_string(),
            })
        })
        .collect();
    sessions.sort_by(|a, b| b.activity.cmp(&a.activity).then_with(|| a.name.cmp(&b.name)));
    TmuxList {
        installed,
        version,
        sessions,
    }
}

/// Script que termina las sesiones indicadas (las que ya no existen se ignoran).
pub fn kill_command(names: &[String]) -> AppResult<String> {
    if names.is_empty() {
        return Err(AppError::Invalid("no hay sesiones que cerrar".into()));
    }
    for n in names {
        check_name(n)?;
    }
    Ok(format!(
        "sh -c '{FIND_TMUX}; if [ -z \"$t\" ]; then exit 0; fi; \
         for s in {}; do \"$t\" -L {SOCKET} kill-session -t \"$s\" 2>/dev/null; done; exit 0'",
        names.join(" ")
    ))
}

// ───────── Ejecución en el servidor ─────────

/// Busca tmux en el servidor.
pub async fn probe(session: &SshSession) -> AppResult<ProbeResult> {
    let r = exec::run(session, &probe_command(), PROBE_TIMEOUT_SECS).await?;
    if r.timed_out {
        return Err(AppError::Network("el servidor tardó demasiado en responder".into()));
    }
    // Sin el formato esperado (p. ej. un servidor Windows sin `sh`): para TerView no hay tmux.
    Ok(parse_probe(&r.stdout).unwrap_or(ProbeResult::NotInstalled))
}

/// Sesiones de TerView vivas en el servidor.
pub async fn list(session: Arc<SshSession>) -> AppResult<TmuxList> {
    let r = exec::run(&session, &list_command(), PROBE_TIMEOUT_SECS).await?;
    if kv(&r.stdout, "tv_tmux").is_none() {
        return Err(AppError::Ssh("no se pudieron listar las sesiones tmux".into()));
    }
    Ok(parse_list(&r.stdout))
}

/// Termina sesiones de TerView.
pub async fn kill(session: Arc<SshSession>, names: &[String]) -> AppResult<()> {
    let r = exec::run(&session, &kill_command(names)?, PROBE_TIMEOUT_SECS).await?;
    if r.timed_out {
        return Err(AppError::Network("el servidor tardó demasiado en cerrar las sesiones".into()));
    }
    Ok(())
}

#[cfg(test)]
#[path = "tmux_tests.rs"]
mod tests;
