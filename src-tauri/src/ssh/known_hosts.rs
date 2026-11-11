//! Lectura/escritura de ~/.ssh/known_hosts.
//! DUEÑO: agente SSH.
//!
//! Implementación propia (en vez de `russh::keys::known_hosts`) porque la de russh
//! no tolera tabuladores, marcadores (`@cert-authority`, `@revoked`), comodines
//! ni negaciones, y falla entera si una línea que coincide trae una llave rara.
//! Compatible con el formato de OpenSSH:
//! - `host`, `host1,host2`, `[host]:puerto` (puertos ≠ 22), comodines `*`/`?`, `!negación`.
//! - Entradas cifradas `|1|sal|hmac` (HashKnownHosts yes) → HMAC-SHA1.
//! - `@revoked` → se trata como llave cambiada (no se confía). `@cert-authority` → se ignora.

use std::io::Write;
use std::path::{Path, PathBuf};

use russh::keys::PublicKey;
use russh::keys::ssh_encoding::base64::{Base64, Encoding};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// Hay una entrada para el host con exactamente esta llave.
    Match,
    /// No hay ninguna entrada (o solo con otros algoritmos).
    Unknown,
    /// Hay una entrada con el mismo algoritmo pero otra llave (o la llave está revocada).
    Changed,
}

#[derive(Debug)]
pub struct KnownHostsError(pub String);

impl From<KnownHostsError> for AppError {
    fn from(e: KnownHostsError) -> Self {
        AppError::Io(e.0)
    }
}

/// `~/.ssh/known_hosts`
pub fn default_path() -> AppResult<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".ssh").join("known_hosts"))
        .ok_or_else(|| AppError::Io("No se encontró la carpeta personal del usuario".into()))
}

/// Nombre del host tal como lo escribe OpenSSH: `host` o `[host]:puerto`.
pub fn host_field(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Una línea de known_hosts ya separada en campos.
struct Entry<'a> {
    marker: Option<&'a str>,
    hosts: &'a str,
    key_type: &'a str,
    key_b64: &'a str,
}

fn parse_line(line: &str) -> Option<Entry<'_>> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let mut it = t.split_whitespace();
    let mut first = it.next()?;
    let marker = if first.starts_with('@') {
        let m = first;
        first = it.next()?;
        Some(m)
    } else {
        None
    };
    Some(Entry {
        marker,
        hosts: first,
        key_type: it.next()?,
        key_b64: it.next()?,
    })
}

/// Comprueba la llave `key` del servidor `host:port` contra el archivo `path`.
/// Un archivo inexistente equivale a "host desconocido".
pub fn check(
    path: &Path,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> Result<HostKeyStatus, KnownHostsError> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HostKeyStatus::Unknown),
        Err(e) => {
            return Err(KnownHostsError(format!(
                "No se pudo leer {}: {e}",
                path.display()
            )));
        }
    };
    Ok(check_content(&content, host, port, key))
}

fn check_content(content: &str, host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
    let target = host_field(host, port).to_ascii_lowercase();
    let mut matched = false;
    let mut changed = false;
    for line in content.lines() {
        let Some(e) = parse_line(line) else { continue };
        if e.marker == Some("@cert-authority") {
            continue;
        }
        if !matches_host_list(&target, e.hosts) {
            continue;
        }
        let Ok(recorded) = PublicKey::from_openssh(&format!("{} {}", e.key_type, e.key_b64))
        else {
            log::debug!("known_hosts: llave ilegible en una línea, se ignora");
            continue;
        };
        let same = recorded.key_data() == key.key_data();
        if e.marker == Some("@revoked") {
            if same {
                return HostKeyStatus::Changed;
            }
            continue;
        }
        if e.marker.is_some() {
            continue;
        }
        if same {
            matched = true;
        } else if recorded.algorithm() == key.algorithm() {
            changed = true;
        }
    }
    if matched {
        HostKeyStatus::Match
    } else if changed {
        HostKeyStatus::Changed
    } else {
        HostKeyStatus::Unknown
    }
}

/// `hosts` es la lista separada por comas del primer campo. Una negación que coincide
/// anula toda la línea (como OpenSSH).
fn matches_host_list(target: &str, hosts: &str) -> bool {
    let mut positive = false;
    for pat in hosts.split(',') {
        if pat.is_empty() {
            continue;
        }
        if let Some(neg) = pat.strip_prefix('!') {
            if glob_match(&neg.to_ascii_lowercase(), target) {
                return false;
            }
        } else if pat.starts_with("|1|") {
            if hashed_match(pat, target) {
                positive = true;
            }
        } else if glob_match(&pat.to_ascii_lowercase(), target) {
            positive = true;
        }
    }
    positive
}

/// Coincidencia exacta (sin comodines) — para decidir qué borrar al confiar.
fn exact_match(pat: &str, target: &str) -> bool {
    if pat.starts_with("|1|") {
        hashed_match(pat, target)
    } else {
        pat.eq_ignore_ascii_case(target)
    }
}

fn hashed_match(entry: &str, target: &str) -> bool {
    let mut parts = entry.split('|').skip(2);
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (Base64::decode_vec(salt), Base64::decode_vec(hash)) else {
        return false;
    };
    hmac_sha1(&salt, target.as_bytes()).as_slice() == hash.as_slice()
}

/// Glob de OpenSSH: `*` (cualquier secuencia) y `?` (un carácter).
fn glob_match(pat: &str, s: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = s.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

// ───────────────────────── Escritura ─────────────────────────

/// Normaliza la llave recibida de la interfaz a `algoritmo base64` (sin comentario).
pub fn parse_key_openssh(key_openssh: &str) -> AppResult<PublicKey> {
    PublicKey::from_openssh(key_openssh.trim())
        .map_err(|e| AppError::Invalid(format!("Llave pública del servidor no válida: {e}")))
}

fn key_line(key: &PublicKey) -> AppResult<String> {
    let full = key
        .to_openssh()
        .map_err(|e| AppError::Invalid(format!("No se pudo codificar la llave: {e}")))?;
    let mut it = full.split_whitespace();
    match (it.next(), it.next()) {
        (Some(a), Some(b)) => Ok(format!("{a} {b}")),
        _ => Err(AppError::Invalid("Llave pública del servidor no válida".into())),
    }
}

/// Quita del contenido todas las entradas exactas de `host:port` (planas o cifradas).
/// En líneas con varios nombres (`host,ip`) solo quita ese nombre. No toca comentarios,
/// marcadores ni líneas con comodines. Devuelve (nuevo contenido, entradas quitadas).
fn remove_host_from_content(content: &str, host: &str, port: u16) -> (String, usize) {
    let target = host_field(host, port).to_ascii_lowercase();
    let mut out = String::with_capacity(content.len());
    let mut removed = 0usize;
    for line in content.split_inclusive('\n') {
        let keep_as_is = match parse_line(line) {
            None => true,
            Some(e) if e.marker.is_some() => true,
            Some(e) => !e.hosts.split(',').any(|p| exact_match(p, &target)),
        };
        if keep_as_is {
            out.push_str(line);
            continue;
        }
        // La línea contiene el host: reconstruirla sin ese nombre.
        let trimmed_start = line.trim_start();
        let hosts_end = trimmed_start
            .find(char::is_whitespace)
            .unwrap_or(trimmed_start.len());
        let hosts = &trimmed_start[..hosts_end];
        let rest = &trimmed_start[hosts_end..];
        let remaining: Vec<&str> = hosts
            .split(',')
            .filter(|p| !p.is_empty() && !exact_match(p, &target))
            .collect();
        removed += 1;
        if remaining.is_empty() {
            continue;
        }
        out.push_str(&remaining.join(","));
        out.push_str(rest);
    }
    (out, removed)
}

/// Escribe el archivo de forma atómica (temporal + rename) con permisos 0600.
fn write_atomic(path: &Path, content: &str) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Io("Ruta de known_hosts no válida".into()))?;
    let tmp = dir.join(format!(
        ".known_hosts.terview-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        drop(f);
        // Si el archivo original tenía otros permisos, se respetan (en Unix; en Windows
        // copiar el «solo lectura» impediría reemplazarlo).
        #[cfg(unix)]
        if let Ok(meta) = std::fs::metadata(path) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        crate::storage::fsutil::replace_file(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(format!(
            "No se pudo escribir {}: {e}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_parent_dir(path: &Path) -> AppResult<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    if dir.as_os_str().is_empty() || dir.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::Io(format!("No se pudo crear {}: {e}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Confía en `key_openssh` para `host:port`: borra las entradas previas de ese host
/// (p. ej. una llave cambiada que el usuario ya aceptó reemplazar) y añade la nueva.
pub fn trust(path: &Path, host: &str, port: u16, key_openssh: &str) -> AppResult<()> {
    let host = host.trim();
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains(',') {
        return Err(AppError::Invalid(format!("Nombre de host no válido: {host:?}")));
    }
    let key = parse_key_openssh(key_openssh)?;
    let line = format!("{} {}\n", host_field(host, port), key_line(&key)?);
    ensure_parent_dir(path)?;
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(AppError::Io(format!(
                "No se pudo leer {}: {e}",
                path.display()
            )));
        }
    };
    let (mut new_content, removed) = remove_host_from_content(&content, host, port);
    if removed > 0 {
        log::info!("known_hosts: {removed} entrada(s) anteriores de {host}:{port} reemplazadas");
    }
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(&line);
    write_atomic(path, &new_content)
}

// ───────────────────────── SHA-1 / HMAC-SHA1 (para entradas cifradas) ─────────────────────────

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (i, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..20].copy_from_slice(&sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(64 + msg.len());
    inner.extend(k.iter().map(|b| b ^ 0x36));
    inner.extend_from_slice(msg);
    let ih = sha1(&inner);
    let mut outer = Vec::with_capacity(84);
    outer.extend(k.iter().map(|b| b ^ 0x5c));
    outer.extend_from_slice(&ih);
    sha1(&outer)
}

#[cfg(test)]
mod tests {
    use super::*;

    const K1: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const K2: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    fn key(s: &str) -> PublicKey {
        PublicKey::from_openssh(s).unwrap()
    }

    #[test]
    fn sha1_vectors() {
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(hex(&sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&hmac_sha1(b"key", b"The quick brown fox jumps over the lazy dog")),
            "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9"
        );
    }

    #[test]
    fn check_plain_port_and_tabs() {
        let c = format!("# comentario\nexample.com,1.2.3.4\t{K1}\n[localhost]:2222 {K2} c\n");
        assert_eq!(check_content(&c, "example.com", 22, &key(K1)), HostKeyStatus::Match);
        assert_eq!(check_content(&c, "1.2.3.4", 22, &key(K1)), HostKeyStatus::Match);
        assert_eq!(check_content(&c, "example.com", 22, &key(K2)), HostKeyStatus::Changed);
        assert_eq!(check_content(&c, "example.com", 2200, &key(K1)), HostKeyStatus::Unknown);
        assert_eq!(check_content(&c, "localhost", 2222, &key(K2)), HostKeyStatus::Match);
        assert_eq!(check_content(&c, "localhost", 22, &key(K2)), HostKeyStatus::Unknown);
        assert_eq!(check_content(&c, "other", 22, &key(K1)), HostKeyStatus::Unknown);
    }

    #[test]
    fn check_hashed_wildcard_revoked() {
        // Entrada cifrada de pruebas de russh: corresponde a "example.com".
        let c = format!(
            "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= {K2}\n*.lan,!bad.lan {K1}\n@revoked * {K2}\n"
        );
        assert_eq!(check_content(&c, "example.com", 22, &key(K2)), HostKeyStatus::Changed); // revocada
        let c2 = format!("|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= {K2}\n*.lan,!bad.lan {K1}\n");
        assert_eq!(check_content(&c2, "example.com", 22, &key(K2)), HostKeyStatus::Match);
        assert_eq!(check_content(&c2, "example.com", 22, &key(K1)), HostKeyStatus::Changed);
        assert_eq!(check_content(&c2, "pc.lan", 22, &key(K1)), HostKeyStatus::Match);
        assert_eq!(check_content(&c2, "bad.lan", 22, &key(K1)), HostKeyStatus::Unknown);
    }

    #[test]
    fn remove_keeps_other_lines() {
        let c = format!(
            "# c\n[h]:2222 {K1}\nh,alias {K1}\n[h]:2222,x {K2}\n*.lan {K1}\n|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= {K2}"
        );
        let (out, n) = remove_host_from_content(&c, "h", 2222);
        assert_eq!(n, 2);
        assert_eq!(out, format!("# c\nh,alias {K1}\nx {K2}\n*.lan {K1}\n|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= {K2}"));
        let (out, n) = remove_host_from_content(&c, "example.com", 22);
        assert_eq!(n, 1);
        assert!(!out.contains("|1|"));
    }

    #[test]
    fn trust_creates_and_replaces() {
        let dir = std::env::temp_dir().join(format!("terview-kh-{}", uuid::Uuid::new_v4()));
        let path = dir.join("sub").join("known_hosts");
        trust(&path, "h", 2222, &format!("{K1} comentario")).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("[h]:2222 {K1}\n"));
        assert_eq!(check(&path, "h", 2222, &key(K2)).unwrap(), HostKeyStatus::Changed);
        trust(&path, "h", 2222, K2).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("[h]:2222 {K2}\n"));
        assert_eq!(check(&path, "h", 2222, &key(K2)).unwrap(), HostKeyStatus::Match);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
