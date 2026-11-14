//! Exportar / importar servidores a `~/.ssh/config`.
//!
//! - **Exportar**: SSHorus escribe SOLO dentro de un bloque marcado
//!   (`# >>> SSHorus (no editar a mano) >>>` … `# <<< SSHorus <<<`). El resto del archivo se conserva
//!   byte a byte. La primera vez se guarda una copia en `~/.ssh/config.bak-sshorus`.
//!   Un bloque nuevo se inserta antes del primer `Host`/`Match` del usuario (así un `Host *` posterior
//!   no pisa nuestros valores y las opciones globales del principio siguen siendo globales).
//! - **Importar**: lee los `Host` concretos (con `Include`), resuelve sus opciones como OpenSSH
//!   (gana el primer valor; también aplican `Host *`, comodines y opciones globales) y devuelve candidatos.
//!
//! Las rutas se inyectan con [`SshEnv`] para poder probarlo con archivos temporales.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::{fsutil, ProfileStore, SettingsStore};
use crate::error::{AppError, AppResult};
use crate::types::{AuthMethod, ServerProfile, SshConfigExport};

pub const BEGIN_MARKER: &str = "# >>> SSHorus (no editar a mano) >>>";
pub const END_MARKER: &str = "# <<< SSHorus <<<";

/// Igual que OpenSSH (READCONF_MAX_DEPTH).
const MAX_INCLUDE_DEPTH: usize = 16;
/// Llaves que ssh prueba por defecto si no hay `IdentityFile`.
const DEFAULT_KEYS: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

/// Rutas y datos del entorno (inyectables para tests).
#[derive(Debug, Clone)]
pub struct SshEnv {
    pub home: PathBuf,
    pub ssh_dir: PathBuf,
    pub config: PathBuf,
    pub backup: PathBuf,
    /// Usuario local: el que usa ssh si el `Host` no dice `User`.
    pub local_user: String,
    /// Alias elegidos a mano (id del servidor → alias). None = no se guardan.
    pub aliases_file: Option<PathBuf>,
}

impl SshEnv {
    pub fn for_home(home: impl Into<PathBuf>, local_user: impl Into<String>) -> Self {
        let home = home.into();
        let ssh_dir = home.join(".ssh");
        SshEnv {
            config: ssh_dir.join("config"),
            backup: ssh_dir.join("config.bak-sshorus"),
            aliases_file: Some(home.join(".config").join("sshorus").join("ssh-aliases.json")),
            ssh_dir,
            home,
            local_user: local_user.into(),
        }
    }

    /// Entorno real del usuario (`~/.ssh/config`).
    pub fn user() -> AppResult<Self> {
        let home =
            dirs::home_dir().ok_or_else(|| AppError::Io("no se encontró la carpeta personal del usuario".into()))?;
        let user = ["USER", "LOGNAME", "USERNAME"]
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
            .unwrap_or_else(|| "root".into());
        let mut env = Self::for_home(home, user);
        env.aliases_file = fsutil::config_dir().map(|d| d.join("ssh-aliases.json"));
        Ok(env)
    }
}

// ───────────────────────── Exportar ─────────────────────────

/// Serializa exportaciones simultáneas (p. ej. dos guardados seguidos con sincronización activa).
static EXPORT_LOCK: Mutex<()> = Mutex::new(());

/// Exporta `servers` al bloque de SSHorus.
#[cfg(test)]
pub fn export(env: &SshEnv, servers: &[ServerProfile]) -> AppResult<SshConfigExport> {
    export_with(env, || servers.to_vec())
}

/// Igual que [`export`], pero lee los servidores ya dentro del candado: la última exportación
/// siempre escribe el estado más reciente.
pub fn export_with(env: &SshEnv, servers: impl FnOnce() -> Vec<ServerProfile>) -> AppResult<SshConfigExport> {
    let _guard = EXPORT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let servers = servers();
    let target = resolve_symlink(&env.config);
    let original = match fs::read(&target) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(AppError::Io(format!("no se pudo leer {}: {e}", env.config.display()))),
    };
    let aliases = assign_aliases_with(&servers, &load_overrides(env));
    let next = splice_aliased(&original, &servers, &aliases)?;
    let out = SshConfigExport { path: env.config.display().to_string(), count: servers.len() };
    if next == original {
        return Ok(out);
    }
    if !env.ssh_dir.exists() {
        fsutil::ensure_private_dir(&env.ssh_dir)?;
    }
    if let Some(dir) = target.parent().filter(|d| !d.exists()) {
        fsutil::ensure_private_dir(dir)?;
    }
    // Copia de seguridad única, antes de la primera escritura.
    if !original.is_empty() && !env.backup.exists() {
        fsutil::write_atomic(&env.backup, &original)?;
    }
    fsutil::write_atomic(&target, &next)?;
    Ok(out)
}

/// Si `~/.ssh/config` es un enlace simbólico (dotfiles), escribimos en el destino y no lo rompemos.
fn resolve_symlink(p: &Path) -> PathBuf {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()),
        _ => p.to_path_buf(),
    }
}

/// Devuelve el contenido nuevo: el original con el bloque de SSHorus reemplazado/insertado
/// (o quitado si no hay servidores). Todo lo de fuera del bloque se conserva byte a byte.
#[cfg(test)]
pub fn splice_block(original: &[u8], servers: &[ServerProfile]) -> AppResult<Vec<u8>> {
    splice_aliased(original, servers, &assign_aliases(servers))
}

/// Igual que [`splice_block`] con los alias ya decididos (uno por servidor, mismo orden).
fn splice_aliased(original: &[u8], servers: &[ServerProfile], aliases: &[String]) -> AppResult<Vec<u8>> {
    let lines = split_lines(original);
    let begin = lines.iter().position(|&(s, e)| line_trim(&original[s..e]) == BEGIN_MARKER.as_bytes());

    if let Some(b) = begin {
        let end = lines[b + 1..]
            .iter()
            .position(|&(s, e)| line_trim(&original[s..e]) == END_MARKER.as_bytes())
            .map(|i| b + 1 + i)
            .ok_or_else(|| {
                AppError::Invalid(format!(
                    "El bloque de SSHorus en ~/.ssh/config está incompleto (falta «{END_MARKER}»). Corrígelo a mano."
                ))
            })?;
        let prefix = &original[..lines[b].0];
        let mut suffix = &original[lines[end].1..];
        let mut out = prefix.to_vec();
        if servers.is_empty() {
            // Quitar el bloque y la línea en blanco que lo separaba.
            if prefix.is_empty() || prefix.ends_with(b"\n\n") {
                suffix = suffix.strip_prefix(b"\r\n").or_else(|| suffix.strip_prefix(b"\n")).unwrap_or(suffix);
            }
        } else {
            // Si tras el bloque hay opciones sueltas (no Host/Match), cerramos con `Host *`
            // para que sigan aplicando a todos como antes.
            let reset = !next_is_section_or_eof(suffix);
            out.extend_from_slice(render_aliased(servers, aliases, reset).as_bytes());
        }
        out.extend_from_slice(suffix);
        return Ok(out);
    }

    if servers.is_empty() {
        return Ok(original.to_vec());
    }
    let block = render_aliased(servers, aliases, false);
    let first_section = lines.iter().find(|&&(s, e)| is_section_line(&original[s..e])).map(|&(s, _)| s);
    let mut out = Vec::with_capacity(original.len() + block.len() + 2);
    match first_section {
        Some(at) => {
            let prefix = &original[..at];
            out.extend_from_slice(prefix);
            if !prefix.is_empty() && !ends_with_blank_line(prefix) {
                out.push(b'\n');
            }
            out.extend_from_slice(block.as_bytes());
            out.push(b'\n');
            out.extend_from_slice(&original[at..]);
        }
        None => {
            out.extend_from_slice(original);
            if !original.is_empty() {
                if !original.ends_with(b"\n") {
                    out.push(b'\n');
                }
                if !ends_with_blank_line(&out) {
                    out.push(b'\n');
                }
            }
            out.extend_from_slice(block.as_bytes());
        }
    }
    Ok(out)
}

/// Bloque completo (con marcadores), terminado en `\n`.
fn render_aliased(servers: &[ServerProfile], aliases: &[String], reset: bool) -> String {
    let mut s = String::new();
    s.push_str(BEGIN_MARKER);
    s.push('\n');
    for (i, (srv, alias)) in servers.iter().zip(aliases).enumerate() {
        if i > 0 {
            s.push('\n');
        }
        s.push_str(&format!("Host {alias}\n"));
        s.push_str(&format!("    HostName {}\n", cfg_value(&srv.host)));
        if srv.port != 22 {
            s.push_str(&format!("    Port {}\n", srv.port));
        }
        s.push_str(&format!("    User {}\n", cfg_value(&srv.username)));
        let key = srv.key_path.as_deref().map(str::trim).filter(|k| !k.is_empty());
        if let (AuthMethod::Key, Some(k)) = (srv.auth, key) {
            s.push_str(&format!("    IdentityFile {}\n", cfg_value(&identity_path(k))));
        }
    }
    if reset {
        s.push_str("\n# Lo que sigue vuelve a aplicarse a todos los hosts\nHost *\n");
    }
    s.push_str(END_MARKER);
    s.push('\n');
    s
}

/// Alias seguro para cada servidor (mismo orden), sin duplicados: `web`, `web-2`, `web-3`…
#[cfg(test)]
pub fn assign_aliases(servers: &[ServerProfile]) -> Vec<String> {
    assign_aliases_with(servers, &AliasOverrides::new())
}

/// Como [`assign_aliases`], pero respetando los alias elegidos a mano (`overrides`, id → alias).
/// Los elegidos a mano se reservan primero, así un alias automático nunca se los quita.
pub fn assign_aliases_with(servers: &[ServerProfile], overrides: &AliasOverrides) -> Vec<String> {
    let mut used = HashSet::new();
    let mut out = vec![String::new(); servers.len()];
    let mut pending = Vec::new();
    for (i, s) in servers.iter().enumerate() {
        match overrides.get(&s.id).and_then(|a| sanitize_alias(a).ok()) {
            Some(a) if used.insert(a.clone()) => out[i] = a,
            other => pending.push((i, other.unwrap_or_else(|| slugify(&s.name)))),
        }
    }
    for (i, base) in pending {
        let mut alias = base.clone();
        let mut n = 2;
        while used.contains(&alias) {
            alias = format!("{base}-{n}");
            n += 1;
        }
        used.insert(alias.clone());
        out[i] = alias;
    }
    out
}

/// Alias escrito a mano → forma segura para `Host`: minúsculas, `[a-z0-9._-]`, sin comodines.
pub fn sanitize_alias(input: &str) -> AppResult<String> {
    let a = input.trim().to_lowercase();
    if a.is_empty() {
        return Err(AppError::Invalid("El alias no puede estar vacío".into()));
    }
    if a.chars().count() > 64 {
        return Err(AppError::Invalid("El alias es demasiado largo (máximo 64 caracteres)".into()));
    }
    if !a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err(AppError::Invalid(
            "El alias solo puede tener letras sin acentos, números, «-», «_» y «.»".into(),
        ));
    }
    if a.starts_with(['-', '.']) {
        return Err(AppError::Invalid("El alias no puede empezar por «-» ni por «.»".into()));
    }
    Ok(a)
}

/// `Cliente X / web` → `cliente-x-web`. Solo `[a-z0-9-]`; vacío → `servidor`.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.chars().flat_map(char::to_lowercase).map(fold_accent) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "servidor".into()
    } else {
        out
    }
}

fn fold_accent(c: char) -> char {
    match c {
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        'ý' | 'ÿ' => 'y',
        _ => c,
    }
}

/// Ruta de llave para `IdentityFile`. En Windows se escribe con `/`: OpenSSH trata la barra
/// invertida como escape en algunos casos (`\\servidor` se rompería) y acepta `/` como separador.
fn identity_path(k: &str) -> String {
    if cfg!(windows) { k.replace('\\', "/") } else { k.to_string() }
}

/// Valor seguro para una línea de ssh_config: sin saltos ni comillas; entre comillas si tiene espacios.
fn cfg_value(v: &str) -> String {
    let clean: String = v.chars().filter(|c| !c.is_control() && *c != '"').collect();
    if clean.chars().any(char::is_whitespace) || clean.starts_with('#') {
        format!("\"{clean}\"")
    } else {
        clean
    }
}

/// (inicio, fin) de cada línea, con su `\n` incluido.
fn split_lines(b: &[u8]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, &c) in b.iter().enumerate() {
        if c == b'\n' {
            out.push((start, i + 1));
            start = i + 1;
        }
    }
    if start < b.len() {
        out.push((start, b.len()));
    }
    out
}

fn line_trim(l: &[u8]) -> &[u8] {
    l.trim_ascii()
}

fn line_keyword(l: &[u8]) -> Option<String> {
    let t = String::from_utf8_lossy(l);
    split_line(&t).map(|(k, _)| k)
}

fn is_section_line(l: &[u8]) -> bool {
    matches!(line_keyword(l).as_deref(), Some("host" | "match"))
}

fn next_is_section_or_eof(rest: &[u8]) -> bool {
    for (s, e) in split_lines(rest) {
        if let Some(k) = line_keyword(&rest[s..e]) {
            return k == "host" || k == "match";
        }
    }
    true
}

fn ends_with_blank_line(b: &[u8]) -> bool {
    b.ends_with(b"\n\n") || b.ends_with(b"\n\r\n")
}

/// Divide una línea en (palabra clave en minúsculas, argumentos). None si es vacía o comentario.
/// Admite `Clave valor`, `Clave=valor` y argumentos entre comillas dobles.
pub fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = line[..end].to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    let mut rest = line[end..].trim_start();
    if let Some(r) = rest.strip_prefix('=') {
        rest = r.trim_start();
    }
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_arg = false;
    let mut quoted = false;
    for c in rest.chars() {
        if quoted {
            if c == '"' {
                quoted = false;
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            quoted = true;
            in_arg = true;
        } else if c.is_whitespace() {
            if in_arg {
                args.push(std::mem::take(&mut cur));
                in_arg = false;
            }
        } else if c == '#' && !in_arg {
            break; // comentario al final de la línea
        } else {
            cur.push(c);
            in_arg = true;
        }
    }
    if in_arg {
        args.push(cur);
    }
    Some((key, args))
}

// ───────────────────────── Importar ─────────────────────────

#[derive(Debug, Clone)]
enum Cond {
    /// Opciones globales o `Match all`.
    All,
    /// `Host patrón…`
    Hosts(Vec<String>),
    /// `Match …` (no lo evaluamos: se ignora).
    Never,
}

#[derive(Debug)]
struct Section {
    cond: Cond,
    opts: Vec<(String, Vec<String>)>,
}

struct Parser<'a> {
    env: &'a SshEnv,
    sections: Vec<Section>,
    aliases: Vec<String>,
}

impl Parser<'_> {
    fn parse_file(&mut self, path: &Path, depth: usize, cond: Cond) {
        match fs::read(path) {
            Ok(b) => self.parse_text(&String::from_utf8_lossy(&b), depth, cond),
            Err(e) => log::warn!("No se pudo leer {}: {e}", path.display()),
        }
    }

    fn parse_text(&mut self, text: &str, depth: usize, cond: Cond) {
        self.sections.push(Section { cond: cond.clone(), opts: Vec::new() });
        let mut cur = cond;
        let mut in_sshorus = false;
        for raw in text.lines() {
            let trimmed = raw.trim();
            if trimmed == BEGIN_MARKER {
                in_sshorus = true;
                continue;
            }
            if trimmed == END_MARKER {
                in_sshorus = false;
                continue;
            }
            let Some((key, args)) = split_line(trimmed) else { continue };
            match key.as_str() {
                "host" => {
                    cur = Cond::Hosts(args.clone());
                    self.sections.push(Section { cond: cur.clone(), opts: Vec::new() });
                    if !in_sshorus {
                        for a in args {
                            if is_concrete(&a) && !self.aliases.contains(&a) {
                                self.aliases.push(a);
                            }
                        }
                    }
                }
                "match" => {
                    let all = args.len() == 1 && args[0].eq_ignore_ascii_case("all");
                    cur = if all { Cond::All } else { Cond::Never };
                    self.sections.push(Section { cond: cur.clone(), opts: Vec::new() });
                }
                "include" => {
                    if in_sshorus || depth >= MAX_INCLUDE_DEPTH {
                        continue;
                    }
                    for a in &args {
                        for p in expand_include(self.env, a) {
                            self.parse_file(&p, depth + 1, cur.clone());
                        }
                    }
                    // Tras el Include sigue el contexto del archivo actual.
                    self.sections.push(Section { cond: cur.clone(), opts: Vec::new() });
                }
                _ if in_sshorus => {}
                _ => {
                    if let Some(s) = self.sections.last_mut() {
                        s.opts.push((key, args));
                    }
                }
            }
        }
    }
}

fn is_concrete(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.contains(['*', '?', '!'])
}

/// Igual que `match_pattern_list` de OpenSSH: un negado que coincide descarta.
fn cond_matches(cond: &Cond, alias: &str) -> bool {
    match cond {
        Cond::All => true,
        Cond::Never => false,
        Cond::Hosts(pats) => {
            let alias = alias.to_lowercase();
            let mut found = false;
            for p in pats {
                let (neg, p) = match p.strip_prefix('!') {
                    Some(r) => (true, r),
                    None => (false, p.as_str()),
                };
                if wildmatch(&p.to_lowercase(), &alias) {
                    if neg {
                        return false;
                    }
                    found = true;
                }
            }
            found
        }
    }
}

/// Comodines `*` y `?`.
fn wildmatch(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn expand_tilde(env: &SshEnv, p: &str) -> PathBuf {
    if p == "~" {
        env.home.clone()
    } else if let Some(r) = p.strip_prefix("~/") {
        env.home.join(r)
    } else if let Some(r) = p.strip_prefix("~\\").filter(|_| cfg!(windows)) {
        env.home.join(r)
    } else {
        PathBuf::from(p)
    }
}

/// Rutas de un `Include`: `~` → home, relativas → ~/.ssh, con comodines (ordenadas, como glob()).
fn expand_include(env: &SshEnv, arg: &str) -> Vec<PathBuf> {
    let p = expand_tilde(env, arg);
    let p = if p.is_absolute() { p } else { env.ssh_dir.join(p) };
    glob(&p)
}

fn glob(pattern: &Path) -> Vec<PathBuf> {
    let mut acc = vec![PathBuf::new()];
    for comp in pattern.components() {
        let part = comp.as_os_str().to_string_lossy();
        let is_glob = matches!(comp, Component::Normal(_)) && part.contains(['*', '?']);
        let mut next = Vec::new();
        for base in &acc {
            if is_glob {
                let Ok(rd) = fs::read_dir(base) else { continue };
                let mut names: Vec<String> = rd
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| (!n.starts_with('.') || part.starts_with('.')) && wildmatch(&part, n))
                    .collect();
                names.sort();
                next.extend(names.into_iter().map(|n| base.join(n)));
            } else {
                next.push(base.join(comp.as_os_str()));
            }
        }
        acc = next;
    }
    acc.retain(|p| p.is_file());
    acc
}

/// `~/…` con `/` como separador (también en Windows, donde OpenSSH lo acepta).
fn tildeify(env: &SshEnv, p: &Path) -> String {
    match p.strip_prefix(&env.home) {
        Ok(rest) => {
            let parts: Vec<String> = rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            format!("~/{}", parts.join("/"))
        }
        Err(_) => p.display().to_string(),
    }
}

/// Expande los tokens más comunes de OpenSSH.
fn expand_tokens(env: &SshEnv, v: &str, alias: &str) -> String {
    let mut out = String::new();
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('%') => out.push('%'),
            Some('h') | Some('n') => out.push_str(alias),
            Some('u') => out.push_str(&env.local_user),
            Some('d') => out.push('~'),
            Some(o) => {
                out.push('%');
                out.push(o);
            }
            None => out.push('%'),
        }
    }
    out
}

fn same_key(host: &str, port: u16, user: &str) -> (String, u16, String) {
    (host.to_lowercase(), port, user.to_string())
}

/// Lee la configuración de ssh y devuelve servidores candidatos (id ""), omitiendo los que ya
/// existen en `existing` (mismo host + puerto + usuario) y el propio bloque de SSHorus.
pub fn import(env: &SshEnv, existing: &[ServerProfile]) -> AppResult<Vec<ServerProfile>> {
    Ok(import_preview(env, existing)?
        .into_iter()
        .filter(|c| c.existing_id.is_none())
        .map(|c| c.server)
        .collect())
}

/// Candidato a importar, marcado si ya está en SSHorus.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportCandidate {
    pub server: ServerProfile,
    /// Servidor de SSHorus con el mismo host + puerto + usuario.
    pub existing_id: Option<String>,
    pub existing_name: Option<String>,
    /// Nombre del servidor de SSHorus que se exporta con este mismo alias (choque de `Host`).
    pub alias_used_by: Option<String>,
}

/// Como [`import`], pero devuelve también los que ya existen (marcados) en lugar de omitirlos.
pub fn import_preview(env: &SshEnv, existing: &[ServerProfile]) -> AppResult<Vec<SshImportCandidate>> {
    let bytes = match fs::read(&env.config) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("no se pudo leer {}: {e}", env.config.display()))),
    };
    let mut parser = Parser { env, sections: Vec::new(), aliases: Vec::new() };
    parser.parse_text(&String::from_utf8_lossy(&bytes), 0, Cond::All);

    let mut seen: HashSet<(String, u16, String)> = HashSet::new();
    let sshorus_aliases = assign_aliases_with(existing, &load_overrides(env));
    let mut out = Vec::new();

    for alias in &parser.aliases {
        let (mut hostname, mut port, mut user, mut identity): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = (None, None, None, None);
        for s in parser.sections.iter().filter(|s| cond_matches(&s.cond, alias)) {
            for (k, args) in &s.opts {
                let Some(first) = args.first() else { continue };
                let slot = match k.as_str() {
                    "hostname" => &mut hostname,
                    "port" => &mut port,
                    "user" => &mut user,
                    "identityfile" => &mut identity,
                    _ => continue,
                };
                if slot.is_none() {
                    *slot = Some(first.clone());
                }
            }
        }

        let host = hostname.map(|h| expand_tokens(env, &h, alias)).unwrap_or_else(|| alias.clone());
        let port = match port {
            None => 22,
            Some(p) => match p.parse::<u16>() {
                Ok(p) if p > 0 => p,
                _ => {
                    log::warn!("~/.ssh/config: puerto inválido «{p}» en Host {alias}; se omite");
                    continue;
                }
            },
        };
        let username = user.unwrap_or_else(|| env.local_user.clone());
        let key_path = identity
            .filter(|i| !i.eq_ignore_ascii_case("none"))
            .map(|i| expand_tokens(env, &i, alias))
            .or_else(|| {
                DEFAULT_KEYS
                    .iter()
                    .map(|k| env.ssh_dir.join(k))
                    .find(|p| p.is_file())
                    .map(|p| tildeify(env, &p))
            });
        let auth = if key_path.is_some() { AuthMethod::Key } else { AuthMethod::Password };

        let candidate = ServerProfile {
            id: String::new(),
            name: alias.clone(),
            host,
            port,
            username,
            auth,
            key_path,
            default_path: None,
            color: None,
            tmux: None,
            sudo_mode: Default::default(),
        };
        let Ok(candidate) = super::validate_server(candidate) else { continue };
        let key = same_key(&candidate.host, candidate.port, &candidate.username);
        if !seen.insert(key.clone()) {
            continue; // otro Host del archivo ya apunta al mismo sitio
        }
        let same = existing.iter().find(|s| same_key(&s.host, s.port, &s.username) == key);
        let alias_used_by = sshorus_aliases
            .iter()
            .position(|a| a.eq_ignore_ascii_case(alias))
            .map(|i| existing[i].name.clone());
        out.push(SshImportCandidate {
            existing_id: same.map(|s| s.id.clone()),
            existing_name: same.map(|s| s.name.clone()),
            alias_used_by,
            server: candidate,
        });
    }
    Ok(out)
}

// ───────────────────────── Alias elegidos a mano ─────────────────────────

/// id del servidor → alias que el usuario eligió para `~/.ssh/config`.
pub type AliasOverrides = BTreeMap<String, String>;

static ALIASES_LOCK: Mutex<()> = Mutex::new(());

pub fn load_overrides(env: &SshEnv) -> AliasOverrides {
    match &env.aliases_file {
        Some(p) => fsutil::read_json_or_default(p),
        None => AliasOverrides::new(),
    }
}

/// Aplica cambios (`None` o vacío = volver al alias automático) y quita los de servidores que ya
/// no existen. Devuelve el mapa resultante. Falla (sin guardar nada) si algún alias no es válido.
pub fn update_overrides(
    env: &SshEnv,
    changes: &BTreeMap<String, Option<String>>,
    valid_ids: &HashSet<String>,
) -> AppResult<AliasOverrides> {
    let _guard = ALIASES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = load_overrides(env);
    for (id, alias) in changes {
        match alias.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            Some(a) => {
                map.insert(id.clone(), sanitize_alias(a)?);
            }
            None => {
                map.remove(id);
            }
        }
    }
    map.retain(|id, _| valid_ids.contains(id));
    if let Some(p) = &env.aliases_file {
        fsutil::write_json_atomic(p, &map)?;
    }
    Ok(map)
}

// ───────────────────────── Choques con `Host` escritos a mano ─────────────────────────

/// Sección `Host`/`Match` escrita por el usuario (fuera del bloque de SSHorus o en un `Include`).
#[derive(Debug, Clone)]
struct UserSection {
    file: PathBuf,
    /// 1 = primera línea.
    line: usize,
    text: String,
    kind: UserKind,
    /// Está antes del bloque de SSHorus: para esos alias ssh usa SUS valores, no los de SSHorus.
    before_block: bool,
}

#[derive(Debug, Clone)]
enum UserKind {
    Host(Vec<String>),
    /// `Match` con criterios `originalhost` (alias) y/o `host` (alias o HostName).
    Match {
        original: Vec<String>,
        host: Vec<String>,
        /// Tiene otros criterios (`user`, `exec`…) que no evaluamos: «podría» aplicar.
        conditional: bool,
    },
}

/// Un `Host`/`Match` del usuario que captura un alias de SSHorus.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshHostMatch {
    /// Archivo (con `~/` si está en la carpeta personal).
    pub file: String,
    pub line: usize,
    /// La línea tal cual (`Host web *.lan`).
    pub text: String,
    /// El patrón que coincide.
    pub pattern: String,
    /// "exact" (mismo nombre), "pattern" (comodín) o "match" (bloque `Match`).
    pub kind: String,
    /// `Match` con más condiciones: puede que no aplique siempre.
    pub conditional: bool,
    /// Está antes del bloque de SSHorus: ssh usará los valores de esa sección y no los de SSHorus.
    pub before_sshorus: bool,
}

/// Servidor de SSHorus cuyo alias choca con la configuración escrita a mano.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAliasConflict {
    pub server_id: String,
    pub server_name: String,
    pub alias: String,
    /// Alias libre propuesto (`<alias>-tv`).
    pub suggestion: String,
    /// El alias lo eligió el usuario (no es el automático).
    pub custom: bool,
    pub matches: Vec<SshHostMatch>,
}

/// Alias con el que se exportaría un servidor (p. ej. el que se está editando) y sus choques.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAliasInfo {
    pub alias: String,
    /// Alias libre propuesto si hay choques.
    pub suggestion: Option<String>,
    pub matches: Vec<SshHostMatch>,
}

struct Scanner<'a> {
    env: &'a SshEnv,
    out: Vec<UserSection>,
}

impl Scanner<'_> {
    /// `before`: None en el archivo principal (se calcula por línea); Some(x) en un `Include`.
    fn scan_text(&mut self, file: &Path, text: &str, depth: usize, before: Option<bool>) {
        let lines: Vec<&str> = text.lines().collect();
        // Dónde está (o se insertaría) el bloque de SSHorus en el archivo principal.
        let anchor = if before.is_none() {
            lines.iter().position(|l| l.trim() == BEGIN_MARKER).or_else(|| {
                lines
                    .iter()
                    .position(|l| matches!(split_line(l).map(|(k, _)| k).as_deref(), Some("host" | "match")))
            })
        } else {
            None
        };
        let mut in_sshorus = false;
        for (i, raw) in lines.iter().enumerate() {
            let trimmed = raw.trim();
            if trimmed == BEGIN_MARKER {
                in_sshorus = true;
                continue;
            }
            if trimmed == END_MARKER {
                in_sshorus = false;
                continue;
            }
            if in_sshorus {
                continue;
            }
            let Some((key, args)) = split_line(trimmed) else { continue };
            let is_before = before.unwrap_or_else(|| anchor.is_none_or(|a| i < a));
            let kind = match key.as_str() {
                "host" => UserKind::Host(args),
                "match" => match parse_match(&args) {
                    Some(k) => k,
                    None => continue,
                },
                "include" => {
                    if depth < MAX_INCLUDE_DEPTH {
                        for a in &args {
                            for p in expand_include(self.env, a) {
                                match fs::read(&p) {
                                    Ok(b) => self.scan_text(&p, &String::from_utf8_lossy(&b), depth + 1, Some(is_before)),
                                    Err(e) => log::warn!("No se pudo leer {}: {e}", p.display()),
                                }
                            }
                        }
                    }
                    continue;
                }
                _ => continue,
            };
            self.out.push(UserSection {
                file: file.to_path_buf(),
                line: i + 1,
                text: trimmed.to_string(),
                kind,
                before_block: is_before,
            });
        }
    }
}

/// Criterios de `Match` que afectan a un alias. None si no puede capturar uno concreto
/// (`Match all`, solo `user`/`exec`…).
fn parse_match(args: &[String]) -> Option<UserKind> {
    let (mut original, mut host, mut conditional) = (Vec::new(), Vec::new(), false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let crit = a.to_ascii_lowercase();
        match crit.as_str() {
            "all" | "canonical" | "final" => {}
            "host" | "originalhost" => {
                let Some(v) = it.next() else { break };
                let pats = v.split(',').filter(|p| !p.is_empty()).map(str::to_string);
                if crit == "host" {
                    host.extend(pats);
                } else {
                    original.extend(pats);
                }
            }
            _ => {
                // `user x`, `exec "…"`, `!host x`… : no se evalúan.
                conditional = true;
                if !matches!(crit.trim_start_matches('!'), "all" | "canonical" | "final") {
                    it.next();
                }
            }
        }
    }
    if original.is_empty() && host.is_empty() {
        return None;
    }
    Some(UserKind::Match { original, host, conditional })
}

/// Lee `~/.ssh/config` (y sus `Include`) y devuelve los `Host`/`Match` escritos a mano.
fn scan_user_sections(env: &SshEnv) -> AppResult<Vec<UserSection>> {
    let bytes = match fs::read(&env.config) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("no se pudo leer {}: {e}", env.config.display()))),
    };
    let mut sc = Scanner { env, out: Vec::new() };
    sc.scan_text(&env.config, &String::from_utf8_lossy(&bytes), 0, None);
    Ok(sc.out)
}

/// Patrón que solo tiene `*` (p. ej. `Host *`): es la configuración común a todos, no un choque.
fn is_catch_all(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| c == '*')
}

/// Primer patrón positivo que captura `name` dentro de una lista estilo OpenSSH
/// (un negado que coincide descarta la lista entera). Ignora los `*` sueltos.
fn matching_pattern(pats: &[String], name: &str) -> Option<String> {
    if !cond_matches(&Cond::Hosts(pats.to_vec()), name) {
        return None;
    }
    let lower = name.to_lowercase();
    pats.iter()
        .filter(|p| !p.starts_with('!') && !is_catch_all(p))
        .find(|p| wildmatch(&p.to_lowercase(), &lower))
        .cloned()
}

/// Secciones del usuario que capturan `alias` (cuyo `HostName` es `hostname`).
fn find_matches(env: &SshEnv, sections: &[UserSection], alias: &str, hostname: &str) -> Vec<SshHostMatch> {
    let mut out = Vec::new();
    for s in sections {
        let (pattern, kind, conditional) = match &s.kind {
            UserKind::Host(pats) => match matching_pattern(pats, alias) {
                Some(p) => {
                    let kind = if is_concrete(&p) { "exact" } else { "pattern" };
                    (p, kind, false)
                }
                None => continue,
            },
            UserKind::Match { original, host, conditional } => {
                // `host` se compara con el nombre final (tras HostName); `originalhost`, con el alias.
                let hit = matching_pattern(original, alias)
                    .or_else(|| matching_pattern(host, hostname))
                    .or_else(|| matching_pattern(host, alias));
                match hit {
                    Some(p) => (p, "match", *conditional),
                    None => continue,
                }
            }
        };
        out.push(SshHostMatch {
            file: tildeify(env, &s.file),
            line: s.line,
            text: s.text.clone(),
            pattern,
            kind: kind.into(),
            conditional,
            before_sshorus: s.before_block,
        });
    }
    out
}

/// Primer alias libre entre `<alias>-tv`, `<alias>-tv2`… y `tv-<alias>`, `tv-<alias>-2`… (este último
/// por si el choque es un prefijo como `Host web*`). Libre = no lo captura ningún `Host`/`Match` por
/// nombre y no lo usa otro servidor. Si no hay ninguno, `<alias>-tv`.
fn suggest_alias(env: &SshEnv, sections: &[UserSection], alias: &str, used: &HashSet<String>) -> String {
    let first = format!("{alias}-tv");
    let candidates = std::iter::once(first.clone())
        .chain((2..10).map(|n| format!("{alias}-tv{n}")))
        .chain(std::iter::once(format!("tv-{alias}")))
        .chain((2..10).map(|n| format!("tv-{alias}-{n}")));
    for cand in candidates {
        // Sin HostName: un `Match host <ip>` no se arregla cambiando el alias.
        if !used.contains(&cand) && find_matches(env, sections, &cand, "").is_empty() {
            return cand;
        }
    }
    first
}

/// Servidores de SSHorus cuyo alias exportado choca con un `Host`/`Match` escrito a mano.
pub fn conflicts(env: &SshEnv, servers: &[ServerProfile]) -> AppResult<Vec<SshAliasConflict>> {
    let overrides = load_overrides(env);
    let aliases = assign_aliases_with(servers, &overrides);
    let sections = scan_user_sections(env)?;
    let mut used: HashSet<String> = aliases.iter().cloned().collect();
    let mut out = Vec::new();
    for (srv, alias) in servers.iter().zip(&aliases) {
        let matches = find_matches(env, &sections, alias, &srv.host);
        if matches.is_empty() {
            continue;
        }
        let suggestion = suggest_alias(env, &sections, alias, &used);
        used.insert(suggestion.clone());
        out.push(SshAliasConflict {
            server_id: srv.id.clone(),
            server_name: srv.name.clone(),
            alias: alias.clone(),
            suggestion,
            custom: overrides.get(&srv.id).is_some_and(|a| sanitize_alias(a).ok().as_ref() == Some(alias)),
            matches,
        });
    }
    Ok(out)
}

/// Alias con el que se exportaría `draft` (nuevo si su id está vacío o no existe) y sus choques.
/// `custom`: alias escrito en el editor (None o vacío = automático).
pub fn alias_info(
    env: &SshEnv,
    servers: &[ServerProfile],
    draft: ServerProfile,
    custom: Option<&str>,
) -> AppResult<SshAliasInfo> {
    let custom = custom.map(str::trim).filter(|c| !c.is_empty()).map(sanitize_alias).transpose()?;
    let mut overrides = load_overrides(env);
    let mut list = servers.to_vec();
    let idx = match list.iter().position(|s| !draft.id.is_empty() && s.id == draft.id) {
        Some(i) => i,
        None => {
            list.push(draft.clone());
            list.len() - 1
        }
    };
    list[idx] = draft.clone();
    match custom {
        Some(c) => overrides.insert(draft.id.clone(), c),
        None => overrides.remove(&draft.id),
    };
    let aliases = assign_aliases_with(&list, &overrides);
    let alias = aliases[idx].clone();
    let sections = scan_user_sections(env)?;
    let matches = find_matches(env, &sections, &alias, &draft.host);
    let suggestion = if matches.is_empty() {
        None
    } else {
        let used: HashSet<String> = aliases.into_iter().collect();
        Some(suggest_alias(env, &sections, &alias, &used))
    };
    Ok(SshAliasInfo { alias, suggestion, matches })
}

// ───────────────────────── Comandos ─────────────────────────

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("tarea interna interrumpida: {e}")))?
}

/// Servidores cuyo alias choca con un `Host`/`Match` escrito a mano en `~/.ssh/config` (o sus `Include`).
#[tauri::command]
pub async fn ssh_config_conflicts(store: State<'_, ProfileStore>) -> AppResult<Vec<SshAliasConflict>> {
    let servers = store.data().servers;
    blocking(move || conflicts(&SshEnv::user()?, &servers)).await
}

/// Alias que tendría un servidor en edición (`id` vacío = nuevo) y si choca.
#[tauri::command]
pub async fn ssh_config_alias_info(
    store: State<'_, ProfileStore>,
    id: String,
    name: String,
    host: String,
    alias: Option<String>,
) -> AppResult<SshAliasInfo> {
    let servers = store.data().servers;
    let draft = ServerProfile {
        id,
        name: if name.trim().is_empty() { host.trim().to_string() } else { name.trim().to_string() },
        host: host.trim().to_string(),
        port: 22,
        username: String::new(),
        auth: AuthMethod::Password,
        key_path: None,
        default_path: None,
        color: None,
        tmux: None,
        sudo_mode: Default::default(),
    };
    blocking(move || alias_info(&SshEnv::user()?, &servers, draft, alias.as_deref())).await
}

/// Alias elegidos a mano (id del servidor → alias).
#[tauri::command]
pub async fn ssh_config_aliases() -> AppResult<AliasOverrides> {
    blocking(|| Ok(load_overrides(&SshEnv::user()?))).await
}

/// Cambia alias elegidos a mano (`null` o "" = automático). Si «Mantener sincronizado» está activo,
/// vuelve a exportar. Devuelve todos los alias elegidos a mano.
#[tauri::command]
pub async fn ssh_config_set_aliases(
    app: AppHandle,
    aliases: BTreeMap<String, Option<String>>,
) -> AppResult<AliasOverrides> {
    blocking(move || {
        let env = SshEnv::user()?;
        let store = app.state::<ProfileStore>();
        let ids: HashSet<String> = store.data().servers.into_iter().map(|s| s.id).collect();
        let map = update_overrides(&env, &aliases, &ids)?;
        if app.state::<SettingsStore>().get().ssh_config_sync
            && let Err(e) = export_with(&env, || store.data().servers)
        {
            log::error!("No se pudo sincronizar ~/.ssh/config: {e}");
        }
        Ok(map)
    })
    .await
}

/// Como `profiles_import_ssh_config`, pero incluye (marcados) los que ya están en SSHorus.
#[tauri::command]
pub async fn ssh_config_import_preview(store: State<'_, ProfileStore>) -> AppResult<Vec<SshImportCandidate>> {
    let existing = store.data().servers;
    blocking(move || import_preview(&SshEnv::user()?, &existing)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("sshorus-sshcfg-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn env(&self) -> SshEnv {
            SshEnv::for_home(&self.0, "yo")
        }
        fn write(&self, rel: &str, content: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn srv(name: &str, host: &str, port: u16, user: &str, key: Option<&str>) -> ServerProfile {
        ServerProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            host: host.into(),
            port,
            username: user.into(),
            auth: if key.is_some() { AuthMethod::Key } else { AuthMethod::Password },
            key_path: key.map(Into::into),
            default_path: None,
            color: None,
            tmux: None,
            sudo_mode: Default::default(),
        }
    }

    #[test]
    fn slugs_and_collisions() {
        assert_eq!(slugify("Cliente X / web"), "cliente-x-web");
        assert_eq!(slugify("  Producción  Ñandú!! "), "produccion-nandu");
        assert_eq!(slugify("***"), "servidor");
        let s = |n: &str| srv(n, "h", 22, "u", None);
        let a = assign_aliases(&[s("Web"), s("web"), s("WEB!"), s("db"), s("")]);
        assert_eq!(a, ["web", "web-2", "web-3", "db", "servidor"]);
    }

    #[test]
    fn export_creates_file_with_private_perms() {
        let t = Tmp::new();
        let env = t.env();
        let r = export(
            &env,
            &[srv("Web prod", "10.0.0.1", 22, "deploy", Some("~/.ssh/id_ed25519")), srv("db", "db.lan", 2222, "root", None)],
        )
        .unwrap();
        assert_eq!(r.count, 2);
        let text = fs::read_to_string(&env.config).unwrap();
        assert_eq!(
            text,
            format!(
                "{BEGIN_MARKER}\nHost web-prod\n    HostName 10.0.0.1\n    User deploy\n    IdentityFile ~/.ssh/id_ed25519\n\n\
                 Host db\n    HostName db.lan\n    Port 2222\n    User root\n{END_MARKER}\n"
            )
        );
        // No había archivo previo: no hace falta copia.
        assert!(!env.backup.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&env.config).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(&env.ssh_dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn export_preserves_outside_and_replaces_block() {
        let t = Tmp::new();
        let env = t.env();
        let original = "# mis cosas\nServerAliveInterval 30\n\nHost github.com\n  User git\n\nHost *\n  User nadie\n";
        t.write(".ssh/config", original);

        export(&env, &[srv("a", "a.lan", 22, "u", None)]).unwrap();
        let first = fs::read_to_string(&env.config).unwrap();
        // Insertado antes del primer Host; lo de fuera, intacto.
        assert!(first.starts_with("# mis cosas\nServerAliveInterval 30\n\n# >>> SSHorus"));
        assert!(first.ends_with("# <<< SSHorus <<<\n\nHost github.com\n  User git\n\nHost *\n  User nadie\n"));
        assert_eq!(fs::read_to_string(&env.backup).unwrap(), original);

        // Reemplaza el bloque en su sitio.
        export(&env, &[srv("b", "b.lan", 22, "u", None), srv("c", "c.lan", 22, "u", None)]).unwrap();
        let second = fs::read_to_string(&env.config).unwrap();
        assert_eq!(second.matches(BEGIN_MARKER).count(), 1);
        assert!(!second.contains("a.lan"));
        assert!(second.contains("Host b\n") && second.contains("Host c\n"));
        let strip = |s: &str| {
            let b = s.find(BEGIN_MARKER).unwrap();
            let e = s.find(END_MARKER).unwrap() + END_MARKER.len();
            format!("{}{}", &s[..b], &s[e..])
        };
        assert_eq!(strip(&first), strip(&second));
        // La copia es solo la primera vez.
        assert_eq!(fs::read_to_string(&env.backup).unwrap(), original);

        // Sin servidores, el bloque desaparece y el archivo vuelve a ser el original.
        export(&env, &[]).unwrap();
        assert_eq!(fs::read_to_string(&env.config).unwrap(), original);
    }

    #[test]
    fn export_appends_when_no_hosts_and_resets_scope() {
        // Sin Host/Match: va al final.
        let out = splice_block(b"Compression yes", &[srv("x", "x", 22, "u", None)]).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.starts_with("Compression yes\n\n# >>> SSHorus"));
        // Bloque (movido a mano) seguido de opciones sueltas: cierra con `Host *`.
        let src = format!("{BEGIN_MARKER}\n{END_MARKER}\nForwardAgent no\n");
        let out = String::from_utf8(splice_block(src.as_bytes(), &[srv("x", "x", 22, "u", None)]).unwrap()).unwrap();
        assert!(out.contains("Host *\n# <<< SSHorus <<<\nForwardAgent no\n"));
        // Bloque sin cierre: error, no se toca nada.
        let bad = format!("Host a\n{BEGIN_MARKER}\nHost x\n");
        assert!(splice_block(bad.as_bytes(), &[srv("x", "x", 22, "u", None)]).is_err());
    }

    #[test]
    fn export_keeps_bytes_and_skips_unchanged_write() {
        let t = Tmp::new();
        let env = t.env();
        // Bytes no UTF-8 y CRLF fuera del bloque se conservan.
        let mut original = b"Host raro\r\n  User \xff\xfe\r\n".to_vec();
        original.extend_from_slice(b"# fin sin salto");
        t.write(".ssh/config", "");
        fs::write(&env.config, &original).unwrap();
        export(&env, &[srv("x", "x", 22, "u", None)]).unwrap();
        let after = fs::read(&env.config).unwrap();
        let b = after.windows(BEGIN_MARKER.len()).position(|w| w == BEGIN_MARKER.as_bytes()).unwrap();
        assert_eq!(b, 0);
        assert!(after.ends_with(&original));
        let mtime = fs::metadata(&env.config).unwrap().modified().unwrap();
        export(&env, &[srv("x", "x", 22, "u", None)]).unwrap();
        assert_eq!(fs::read(&env.config).unwrap(), after);
        assert_eq!(fs::metadata(&env.config).unwrap().modified().unwrap(), mtime);
    }

    #[test]
    fn import_parses_hosts_includes_and_wildcards() {
        let t = Tmp::new();
        let env = t.env();
        t.write(
            ".ssh/config",
            &format!(
                "User global-user\n\
                 Include conf.d/*.conf\n\
                 Include ~/otros/extra\n\
                 \n\
                 {BEGIN_MARKER}\nHost sshorus-propio\n    HostName propio.lan\n{END_MARKER}\n\
                 Host web web-alias\n\
                 \x20   HostName 10.0.0.5\n\
                 \x20   Port 2200\n\
                 \x20   IdentityFile \"~/.ssh/mi llave\"\n\
                 \x20   Port 9999\n\
                 Host *.lan !nope.lan\n\
                 \x20   User lan-user\n\
                 Host nas.lan nope.lan\n\
                 Host db\n\
                 \x20   HostName=db.example.com\n\
                 \x20   User root\n\
                 Host ya-guardado\n\
                 \x20   HostName saved.example.com\n\
                 \x20   User admin\n\
                 Match host foo\n\
                 \x20   User match-user\n\
                 Host *\n\
                 \x20   User star-user\n\
                 \x20   Port 2022\n"
            ),
        );
        t.write(".ssh/conf.d/b.conf", "Host from-b\n    HostName b.example.com\n");
        t.write(".ssh/conf.d/a.conf", "Host from-a\n    HostName a.example.com\n    User ana\n");
        t.write(".ssh/conf.d/ignored.txt", "Host no-incluido\n");
        t.write("otros/extra", "Host extra\n    HostName extra.example.com\n");

        let existing = [srv("guardado", "SAVED.example.com", 2022, "global-user", None)];
        let got = import(&env, &existing).unwrap();
        let summary: Vec<String> = got
            .iter()
            .map(|s| format!("{} {}@{}:{} {:?} {:?}", s.name, s.username, s.host, s.port, s.auth, s.key_path))
            .collect();
        assert_eq!(
            summary,
            [
                // El User global va primero → gana a los de cada Host. Port de `Host *` aplica si no hay otro.
                "from-a global-user@a.example.com:2022 Password None",
                "from-b global-user@b.example.com:2022 Password None",
                "extra global-user@extra.example.com:2022 Password None",
                "web global-user@10.0.0.5:2200 Key Some(\"~/.ssh/mi llave\")",
                // web-alias: mismo host/puerto/usuario que web → no se repite.
                "nas.lan global-user@nas.lan:2022 Password None",
                "nope.lan global-user@nope.lan:2022 Password None",
                "db global-user@db.example.com:2022 Password None",
            ]
        );
        assert!(got.iter().all(|s| s.id.is_empty()));
    }

    #[test]
    fn import_first_value_wins_and_defaults() {
        let t = Tmp::new();
        let env = t.env();
        t.write(
            ".ssh/config",
            "Host *.lan !nope.lan\n  User lan-user\nHost nas.lan nope.lan\n  User own\nHost bare\nHost *\n  User star\n",
        );
        let got = import(&env, &[]).unwrap();
        let summary: Vec<String> = got.iter().map(|s| format!("{}@{}:{}", s.username, s.host, s.port)).collect();
        assert_eq!(summary, ["lan-user@nas.lan:22", "own@nope.lan:22", "star@bare:22"]);

        // Sin User en ningún sitio → usuario local; llave por defecto si existe.
        t.write(".ssh/config", "Host solo\n");
        t.write(".ssh/id_ed25519", "x");
        let got = import(&env, &[]).unwrap();
        assert_eq!(got[0].username, "yo");
        assert_eq!(got[0].auth, AuthMethod::Key);
        assert_eq!(got[0].key_path.as_deref(), Some("~/.ssh/id_ed25519"));

        // Sin archivo → vacío.
        fs::remove_file(&env.config).unwrap();
        assert!(import(&env, &[]).unwrap().is_empty());
    }

    #[test]
    fn export_then_import_ignores_own_block() {
        let t = Tmp::new();
        let env = t.env();
        export(&env, &[srv("a", "a.lan", 22, "u", None)]).unwrap();
        assert!(import(&env, &[]).unwrap().is_empty());
    }

    /// Resumen compacto de choques: `alias: pattern@archivo:línea(kind[,antes][,cond])`.
    fn summary(c: &[SshAliasConflict]) -> Vec<String> {
        c.iter()
            .map(|c| {
                let m: Vec<String> = c
                    .matches
                    .iter()
                    .map(|m| {
                        let mut s = format!("{}@{}:{}({}", m.pattern, m.file, m.line, m.kind);
                        if m.before_sshorus {
                            s.push_str(",antes");
                        }
                        if m.conditional {
                            s.push_str(",cond");
                        }
                        s.push(')');
                        s
                    })
                    .collect();
                format!("{} -> {} [{}]", c.alias, c.suggestion, m.join(" "))
            })
            .collect()
    }

    #[test]
    fn conflicts_exact_patterns_case_include_and_match() {
        let t = Tmp::new();
        let env = t.env();
        t.write(
            ".ssh/config",
            &format!(
                "Include conf.d/*\n\
                 \n\
                 {BEGIN_MARKER}\nHost web\n    HostName 10.0.0.1\n{END_MARKER}\n\
                 \n\
                 Host WEB\n\
                 \x20   User manual\n\
                 Host db?? !db-tv\n\
                 \x20   Port 2200\n\
                 Host *-lan !nas-lan\n\
                 Match originalhost cache exec \"true\"\n\
                 Match host 10.9.9.9\n\
                 Match all\n\
                 Host *\n\
                 \x20   ServerAliveInterval 30\n"
            ),
        );
        t.write(".ssh/conf.d/trabajo", "Host api\n    HostName api.example.com\n");
        let servers = [
            srv("web", "10.0.0.1", 22, "u", None),
            srv("db01", "db.lan", 22, "u", None),
            srv("nas lan", "nas.lan", 22, "u", None),
            srv("caja lan", "caja.lan", 22, "u", None),
            srv("api", "api.example.com", 22, "u", None),
            srv("cache", "cache.lan", 22, "u", None),
            srv("monitor", "10.9.9.9", 22, "u", None),
            srv("libre", "libre.example.com", 22, "u", None),
        ];
        let got = conflicts(&env, &servers).unwrap();
        assert_eq!(
            summary(&got),
            [
                // Mayúsculas: ssh compara sin distinguirlas. El bloque propio no cuenta.
                "web -> web-tv [WEB@~/.ssh/config:8(exact)]",
                "db01 -> db01-tv [db??@~/.ssh/config:10(pattern)]",
                // nas-lan está excluido con `!nas-lan`; caja-lan, no.
                "caja-lan -> caja-lan-tv [*-lan@~/.ssh/config:12(pattern)]",
                // Include al principio: va antes del bloque → sus valores ganan.
                "api -> api-tv [api@~/.ssh/conf.d/trabajo:1(exact,antes)]",
                // `Match` con `exec`: puede que no aplique siempre.
                "cache -> cache-tv [cache@~/.ssh/config:13(match,cond)]",
                // `Match host` compara con el HostName.
                "monitor -> monitor-tv [10.9.9.9@~/.ssh/config:14(match)]",
            ]
        );
        assert!(got.iter().all(|c| !c.custom));
    }

    #[test]
    fn conflicts_without_block_use_insert_position() {
        let t = Tmp::new();
        let env = t.env();
        // Sin bloque todavía: se insertará antes del primer Host → el Host va después.
        t.write(".ssh/config", "Host web\n  User a\n");
        let got = conflicts(&env, &[srv("web", "h", 22, "u", None)]).unwrap();
        assert_eq!(summary(&got), ["web -> web-tv [web@~/.ssh/config:1(exact)]"]);
        // Sin archivo: nada.
        fs::remove_file(&env.config).unwrap();
        assert!(conflicts(&env, &[srv("web", "h", 22, "u", None)]).unwrap().is_empty());
        // Solo `Host *` y `Match all`: no son choques.
        t.write(".ssh/config", "Host *\n  User x\nMatch all\n  Port 1\nHost **\n");
        assert!(conflicts(&env, &[srv("web", "h", 22, "u", None)]).unwrap().is_empty());
    }

    #[test]
    fn custom_aliases_fix_conflicts_and_export() {
        let t = Tmp::new();
        let env = t.env();
        t.write(".ssh/config", "Host web web-tv\n  User mano\n");
        let a = srv("web", "10.0.0.1", 22, "u", None);
        let b = srv("Web", "10.0.0.2", 22, "u", None);
        let servers = [a.clone(), b.clone()];
        let got = conflicts(&env, &servers).unwrap();
        // web-tv ya existe a mano → web-tv2. El segundo se llama web-2 (no choca).
        assert_eq!(summary(&got), ["web -> web-tv2 [web@~/.ssh/config:1(exact)]"]);

        // Elegir el alias propuesto: se guarda y se usa al exportar.
        let ids: HashSet<String> = servers.iter().map(|s| s.id.clone()).collect();
        let mut ch = BTreeMap::new();
        ch.insert(a.id.clone(), Some(" WEB-tv2 ".to_string()));
        ch.insert("borrado".to_string(), Some("x".to_string()));
        let map = update_overrides(&env, &ch, &ids).unwrap();
        assert_eq!(map.get(&a.id).map(String::as_str), Some("web-tv2"));
        assert!(!map.contains_key("borrado"));
        export(&env, &servers).unwrap();
        let text = fs::read_to_string(&env.config).unwrap();
        assert!(text.contains("Host web-tv2\n    HostName 10.0.0.1"));
        // El automático del segundo pasa a ser `web` (el nombre quedó libre)… y choca.
        assert!(text.contains("Host web\n    HostName 10.0.0.2"));
        let got = conflicts(&env, &servers).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].server_id, b.id);

        // Alias inválidos: no se guarda nada.
        let mut bad = BTreeMap::new();
        bad.insert(b.id.clone(), Some("web *".to_string()));
        assert!(update_overrides(&env, &bad, &ids).is_err());
        assert_eq!(load_overrides(&env).len(), 1);
        // Volver al automático.
        let mut back = BTreeMap::new();
        back.insert(a.id.clone(), None);
        assert!(update_overrides(&env, &back, &ids).unwrap().is_empty());
    }

    #[test]
    fn alias_info_for_draft_server() {
        let t = Tmp::new();
        let env = t.env();
        t.write(".ssh/config", "Host prod*\n  User mano\n");
        let existing = [srv("prod", "a", 22, "u", None)];
        // Nuevo servidor llamado «Prod»: sería `prod-2` (prod ya lo usa otro) y lo captura `prod*`.
        let mut draft = srv("Prod", "b", 22, "u", None);
        draft.id = String::new();
        let info = alias_info(&env, &existing, draft.clone(), None).unwrap();
        assert_eq!(info.alias, "prod-2");
        assert_eq!(info.matches.len(), 1);
        assert_eq!(info.matches[0].pattern, "prod*");
        // `prod-2-tv…` también empiezan por «prod» → se propone con prefijo.
        assert_eq!(info.suggestion.as_deref(), Some("tv-prod-2"));
        // Con alias propio libre: sin choques.
        let info = alias_info(&env, &existing, draft.clone(), Some("Backend")).unwrap();
        assert_eq!(info.alias, "backend");
        assert!(info.matches.is_empty() && info.suggestion.is_none());
        // Alias inválido: error.
        assert!(alias_info(&env, &existing, draft, Some("a?b")).is_err());
        // Editar el existente: mismo id → no cuenta como otro.
        let info = alias_info(&env, &existing, existing[0].clone(), None).unwrap();
        assert_eq!(info.alias, "prod");
    }

    #[test]
    fn import_preview_marks_existing() {
        let t = Tmp::new();
        let env = t.env();
        t.write(
            ".ssh/config",
            "Host nuevo\n  HostName n.lan\n  User u\nHost viejo\n  HostName v.lan\n  User u\nHost web\n  HostName w2.lan\n  User u\n",
        );
        let existing = [srv("Viejo guardado", "V.lan", 22, "u", None), srv("web", "w.lan", 22, "u", None)];
        let got = import_preview(&env, &existing).unwrap();
        let s: Vec<String> = got
            .iter()
            .map(|c| format!("{} {:?} {:?}", c.server.name, c.existing_name, c.alias_used_by))
            .collect();
        assert_eq!(
            s,
            [
                "nuevo None None",
                "viejo Some(\"Viejo guardado\") None",
                "web None Some(\"web\")",
            ]
        );
        assert_eq!(got[1].existing_id.as_deref(), Some(existing[0].id.as_str()));
        // `import` sigue omitiendo los existentes.
        let names: Vec<String> = import(&env, &existing).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["nuevo", "web"]);
    }

    #[test]
    fn sanitize_alias_rules() {
        assert_eq!(sanitize_alias("  Mi.Server_1-a ").unwrap(), "mi.server_1-a");
        for bad in ["", "  ", "a b", "web*", "a?", "!x", "-x", ".x", "ñandu", &"a".repeat(65)] {
            assert!(sanitize_alias(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn split_line_variants() {
        assert_eq!(split_line("  # nada"), None);
        assert_eq!(split_line("HostName=x"), Some(("hostname".into(), vec!["x".into()])));
        assert_eq!(split_line("Host = a b # comentario"), Some(("host".into(), vec!["a".into(), "b".into()])));
        assert_eq!(
            split_line("IdentityFile \"/a b/c\" d"),
            Some(("identityfile".into(), vec!["/a b/c".into(), "d".into()]))
        );
        assert!(wildmatch("*.lan", "nas.lan") && !wildmatch("*.lan", "nas.lan2") && wildmatch("h?st*", "host1"));
    }
}
