//! Exportar / importar servidores a `~/.ssh/config`.
//!
//! - **Exportar**: TerView escribe SOLO dentro de un bloque marcado
//!   (`# >>> TerView (no editar a mano) >>>` … `# <<< TerView <<<`). El resto del archivo se conserva
//!   byte a byte. La primera vez se guarda una copia en `~/.ssh/config.bak-terview`.
//!   Un bloque nuevo se inserta antes del primer `Host`/`Match` del usuario (así un `Host *` posterior
//!   no pisa nuestros valores y las opciones globales del principio siguen siendo globales).
//! - **Importar**: lee los `Host` concretos (con `Include`), resuelve sus opciones como OpenSSH
//!   (gana el primer valor; también aplican `Host *`, comodines y opciones globales) y devuelve candidatos.
//!
//! Las rutas se inyectan con [`SshEnv`] para poder probarlo con archivos temporales.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use super::fsutil;
use crate::error::{AppError, AppResult};
use crate::types::{AuthMethod, ServerProfile, SshConfigExport};

pub const BEGIN_MARKER: &str = "# >>> TerView (no editar a mano) >>>";
pub const END_MARKER: &str = "# <<< TerView <<<";

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
}

impl SshEnv {
    pub fn for_home(home: impl Into<PathBuf>, local_user: impl Into<String>) -> Self {
        let home = home.into();
        let ssh_dir = home.join(".ssh");
        SshEnv {
            config: ssh_dir.join("config"),
            backup: ssh_dir.join("config.bak-terview"),
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
        Ok(Self::for_home(home, user))
    }
}

// ───────────────────────── Exportar ─────────────────────────

/// Serializa exportaciones simultáneas (p. ej. dos guardados seguidos con sincronización activa).
static EXPORT_LOCK: Mutex<()> = Mutex::new(());

/// Exporta `servers` al bloque de TerView.
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
    let next = splice_block(&original, &servers)?;
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

/// Devuelve el contenido nuevo: el original con el bloque de TerView reemplazado/insertado
/// (o quitado si no hay servidores). Todo lo de fuera del bloque se conserva byte a byte.
pub fn splice_block(original: &[u8], servers: &[ServerProfile]) -> AppResult<Vec<u8>> {
    let lines = split_lines(original);
    let begin = lines.iter().position(|&(s, e)| line_trim(&original[s..e]) == BEGIN_MARKER.as_bytes());

    if let Some(b) = begin {
        let end = lines[b + 1..]
            .iter()
            .position(|&(s, e)| line_trim(&original[s..e]) == END_MARKER.as_bytes())
            .map(|i| b + 1 + i)
            .ok_or_else(|| {
                AppError::Invalid(format!(
                    "El bloque de TerView en ~/.ssh/config está incompleto (falta «{END_MARKER}»). Corrígelo a mano."
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
            out.extend_from_slice(render_block(servers, reset).as_bytes());
        }
        out.extend_from_slice(suffix);
        return Ok(out);
    }

    if servers.is_empty() {
        return Ok(original.to_vec());
    }
    let block = render_block(servers, false);
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
pub fn render_block(servers: &[ServerProfile], reset: bool) -> String {
    let aliases = assign_aliases(servers);
    let mut s = String::new();
    s.push_str(BEGIN_MARKER);
    s.push('\n');
    for (i, (srv, alias)) in servers.iter().zip(&aliases).enumerate() {
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
pub fn assign_aliases(servers: &[ServerProfile]) -> Vec<String> {
    let mut used = HashSet::new();
    servers
        .iter()
        .map(|s| {
            let base = slugify(&s.name);
            let mut alias = base.clone();
            let mut n = 2;
            while used.contains(&alias) {
                alias = format!("{base}-{n}");
                n += 1;
            }
            used.insert(alias.clone());
            alias
        })
        .collect()
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
        let mut in_terview = false;
        for raw in text.lines() {
            let trimmed = raw.trim();
            if trimmed == BEGIN_MARKER {
                in_terview = true;
                continue;
            }
            if trimmed == END_MARKER {
                in_terview = false;
                continue;
            }
            let Some((key, args)) = split_line(trimmed) else { continue };
            match key.as_str() {
                "host" => {
                    cur = Cond::Hosts(args.clone());
                    self.sections.push(Section { cond: cur.clone(), opts: Vec::new() });
                    if !in_terview {
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
                    if in_terview || depth >= MAX_INCLUDE_DEPTH {
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
                _ if in_terview => {}
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
/// existen en `existing` (mismo host + puerto + usuario) y el propio bloque de TerView.
pub fn import(env: &SshEnv, existing: &[ServerProfile]) -> AppResult<Vec<ServerProfile>> {
    let bytes = match fs::read(&env.config) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("no se pudo leer {}: {e}", env.config.display()))),
    };
    let mut parser = Parser { env, sections: Vec::new(), aliases: Vec::new() };
    parser.parse_text(&String::from_utf8_lossy(&bytes), 0, Cond::All);

    let mut seen: HashSet<(String, u16, String)> =
        existing.iter().map(|s| same_key(&s.host, s.port, &s.username)).collect();
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
        };
        let Ok(candidate) = super::validate_server(candidate) else { continue };
        if seen.insert(same_key(&candidate.host, candidate.port, &candidate.username)) {
            out.push(candidate);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("terview-sshcfg-test-{}", uuid::Uuid::new_v4()));
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
        assert!(first.starts_with("# mis cosas\nServerAliveInterval 30\n\n# >>> TerView"));
        assert!(first.ends_with("# <<< TerView <<<\n\nHost github.com\n  User git\n\nHost *\n  User nadie\n"));
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
        assert!(out.starts_with("Compression yes\n\n# >>> TerView"));
        // Bloque (movido a mano) seguido de opciones sueltas: cierra con `Host *`.
        let src = format!("{BEGIN_MARKER}\n{END_MARKER}\nForwardAgent no\n");
        let out = String::from_utf8(splice_block(src.as_bytes(), &[srv("x", "x", 22, "u", None)]).unwrap()).unwrap();
        assert!(out.contains("Host *\n# <<< TerView <<<\nForwardAgent no\n"));
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
                 {BEGIN_MARKER}\nHost terview-propio\n    HostName propio.lan\n{END_MARKER}\n\
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
