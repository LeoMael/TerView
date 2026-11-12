//! Lectura de llaves PÚBLICAS de la PC (`*.pub`). Nunca lee otra cosa: rechaza cualquier archivo
//! que no termine en `.pub`, que sea grande o que contenga una llave privada.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

const MAX_PUB_BYTES: u64 = 16 * 1024;

/// Tipos de llave pública OpenSSH aceptados.
const KEY_TYPES: &[&str] = &[
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPubKey {
    pub path: String,
    /// Línea completa `tipo base64 [comentario]`.
    pub line: String,
    pub key_type: String,
    pub comment: String,
}

fn has_pub_ext(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pub"))
}

/// Valida una línea de llave pública OpenSSH y la normaliza (`tipo base64 comentario`).
/// No admite opciones de `authorized_keys` delante.
pub fn parse_public_key_line(text: &str) -> AppResult<(String, String, String)> {
    let bad = || {
        AppError::Invalid("no parece una llave pública SSH (ssh-ed25519, ssh-rsa, ecdsa…)".into())
    };
    if text.contains("PRIVATE KEY") {
        return Err(AppError::Invalid(
            "eso es una llave PRIVADA: nunca la compartas".into(),
        ));
    }
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .ok_or_else(bad)?;
    let mut parts = line.split_whitespace();
    let ty = parts.next().ok_or_else(bad)?;
    let body = parts.next().ok_or_else(bad)?;
    let comment = parts.collect::<Vec<_>>().join(" ");
    if !KEY_TYPES.contains(&ty) {
        return Err(bad());
    }
    let b64_ok = body.len() >= 16
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='));
    if !b64_ok {
        return Err(bad());
    }
    let norm = if comment.is_empty() {
        format!("{ty} {body}")
    } else {
        format!("{ty} {body} {comment}")
    };
    Ok((norm, ty.to_string(), comment))
}

/// Lee una llave pública de la PC. Solo archivos `.pub` (también tras resolver enlaces).
pub fn read_pub(path: &Path) -> AppResult<LocalPubKey> {
    if !has_pub_ext(path) {
        return Err(AppError::Invalid(
            "solo se pueden leer llaves públicas (archivos .pub)".into(),
        ));
    }
    let real = fs::canonicalize(path)
        .map_err(|e| AppError::Io(format!("no se pudo abrir {}: {e}", path.display())))?;
    if !has_pub_ext(&real) {
        return Err(AppError::Invalid(
            "solo se pueden leer llaves públicas (archivos .pub)".into(),
        ));
    }
    let meta = fs::metadata(&real)?;
    if !meta.is_file() {
        return Err(AppError::Invalid("no es un archivo".into()));
    }
    if meta.len() > MAX_PUB_BYTES {
        return Err(AppError::Invalid(
            "el archivo es demasiado grande para ser una llave pública".into(),
        ));
    }
    let bytes = fs::read(&real)?;
    let text =
        String::from_utf8(bytes).map_err(|_| AppError::Invalid("el archivo no es texto".into()))?;
    let (line, key_type, comment) = parse_public_key_line(&text)?;
    Ok(LocalPubKey {
        path: path.display().to_string(),
        line,
        key_type,
        comment,
    })
}

/// Carpeta `~/.ssh` del usuario.
pub fn ssh_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh"))
}

/// Llaves `*.pub` válidas de `~/.ssh` (las inválidas se omiten).
pub fn list_pub(dir: &Path) -> Vec<LocalPubKey> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<LocalPubKey> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| has_pub_ext(p))
        .filter_map(|p| read_pub(&p).ok())
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}
