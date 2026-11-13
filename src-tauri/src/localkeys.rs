//! Llaves SSH LOCALES (en ~/.ssh de este equipo), para el asistente «Nuevo usuario con clave»:
//! listar las públicas (`*.pub`) y generar una ed25519 nueva. La privada nunca sale del equipo:
//! solo se devuelve la línea pública y la ruta de la privada.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use russh::keys::ssh_key::{LineEnding, private::Ed25519Keypair};
use russh::keys::PrivateKey;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

/// Máximo de `*.pub` que se listan y tamaño máximo de cada uno.
const MAX_FILES: usize = 64;
const MAX_PUB_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPublicKey {
    /// Ruta del `.pub`.
    pub path: String,
    /// Ruta de la privada (el `.pub` sin extensión) si existe.
    pub private_path: Option<String>,
    /// Primera línea no vacía (tipo, base64 y comentario).
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    pub private_path: String,
    pub public_path: String,
    /// Línea para authorized_keys.
    pub public_line: String,
}

fn ssh_dir() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Io("No se encontró la carpeta personal".into()))?;
    Ok(home.join(".ssh"))
}

/// Nombre de archivo de la llave: sin rutas ni caracteres raros.
pub fn check_key_name(name: &str) -> AppResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && !name.starts_with('-')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !name.ends_with(".pub");
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "Nombre de llave no válido: usa letras, números, «.», «_» o «-» (p. ej. id_ed25519_ana)".into(),
        ))
    }
}

/// Lista las llaves públicas de una carpeta (ordenadas por nombre).
pub fn list_public_keys(dir: &Path) -> Vec<LocalPublicKey> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<LocalPublicKey> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pub") && p.is_file())
        .filter(|p| p.metadata().is_ok_and(|m| m.len() <= MAX_PUB_BYTES))
        .filter_map(|p| {
            let text = fs::read_to_string(&p).ok()?;
            let line = text.lines().map(str::trim).find(|l| !l.is_empty())?.to_string();
            let private = p.with_extension("");
            Some(LocalPublicKey {
                path: p.to_string_lossy().into_owned(),
                private_path: private.is_file().then(|| private.to_string_lossy().into_owned()),
                line,
            })
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.truncate(MAX_FILES);
    out
}

/// Crea un archivo nuevo (falla si ya existe) con permisos `mode` en Unix.
fn create_new(path: &Path, content: &[u8], mode: u32) -> AppResult<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut f = opts.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Invalid(format!("Ya existe {}: elige otro nombre", path.display()))
        } else {
            AppError::Io(format!("{}: {e}", path.display()))
        }
    })?;
    f.write_all(content).and_then(|_| f.sync_all()).map_err(|e| AppError::Io(e.to_string()))
}

/// Genera una llave ed25519 en `dir/name` (privada 0600, pública 0644). No sobrescribe nada.
pub fn generate_ed25519(dir: &Path, name: &str, comment: &str, passphrase: &str) -> AppResult<GeneratedKey> {
    check_key_name(name)?;
    if comment.contains(['\n', '\r']) {
        return Err(AppError::Invalid("El comentario no puede tener saltos de línea".into()));
    }
    let private_path = dir.join(name);
    let public_path = dir.join(format!("{name}.pub"));
    if private_path.exists() || public_path.exists() {
        return Err(AppError::Invalid(format!("Ya existe una llave llamada «{name}» en {}", dir.display())));
    }
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| AppError::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }

    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(seed.as_mut()).map_err(|e| AppError::Io(format!("Sin datos aleatorios: {e}")))?;
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    key.set_comment(comment);
    let key = if passphrase.is_empty() {
        key
    } else {
        key.encrypt(&mut getrandom::SysRng, passphrase)
            .map_err(|e| AppError::Invalid(format!("No se pudo cifrar la llave: {e}")))?
    };
    let private_text = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::Invalid(format!("No se pudo guardar la llave: {e}")))?;
    let public_line = key
        .public_key()
        .to_openssh()
        .map_err(|e| AppError::Invalid(format!("No se pudo guardar la llave: {e}")))?;

    create_new(&private_path, private_text.as_bytes(), 0o600)?;
    if let Err(e) = create_new(&public_path, format!("{public_line}\n").as_bytes(), 0o644) {
        let _ = fs::remove_file(&private_path);
        return Err(e);
    }
    log::info!("llave ed25519 generada en {}", private_path.display());
    Ok(GeneratedKey {
        private_path: private_path.to_string_lossy().into_owned(),
        public_path: public_path.to_string_lossy().into_owned(),
        public_line,
    })
}

/// Llaves públicas de ~/.ssh.
#[tauri::command]
pub async fn local_ssh_public_keys() -> AppResult<Vec<LocalPublicKey>> {
    let dir = ssh_dir()?;
    tokio::task::spawn_blocking(move || list_public_keys(&dir))
        .await
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Genera ~/.ssh/<name> (ed25519, frase opcional) y devuelve la parte pública.
#[tauri::command]
pub async fn local_ssh_generate_key(
    name: String,
    comment: String,
    passphrase: Option<String>,
) -> AppResult<GeneratedKey> {
    let dir = ssh_dir()?;
    let passphrase = Zeroizing::new(passphrase.unwrap_or_default());
    tokio::task::spawn_blocking(move || generate_ed25519(&dir, name.trim(), comment.trim(), &passphrase))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("terview-keys-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn names() {
        assert!(check_key_name("id_ed25519_ana").is_ok());
        for bad in ["", "../x", "a/b", ".oculta", "-x", "x.pub", "con espacio"] {
            assert!(check_key_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn generate_list_and_no_overwrite() {
        let d = tmpdir("gen");
        let k = generate_ed25519(&d, "id_prueba", "ana@terview", "").unwrap();
        assert!(k.public_line.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"), "{}", k.public_line);
        assert!(k.public_line.ends_with(" ana@terview"));
        let private = fs::read_to_string(&k.private_path).unwrap();
        assert!(private.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        // La privada se puede volver a leer y corresponde a la pública.
        let parsed = PrivateKey::from_openssh(&private).unwrap();
        assert_eq!(parsed.public_key().to_openssh().unwrap(), k.public_line);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&k.private_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let dmode = fs::metadata(&d).unwrap().permissions().mode() & 0o777;
            assert_eq!(dmode, 0o700);
        }
        assert!(generate_ed25519(&d, "id_prueba", "", "").is_err());
        let list = list_public_keys(&d);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].line, k.public_line);
        assert_eq!(list[0].private_path.as_deref(), Some(k.private_path.as_str()));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn generate_with_passphrase() {
        let d = tmpdir("frase");
        let k = generate_ed25519(&d, "id_cifrada", "", "una frase larga").unwrap();
        let parsed = PrivateKey::from_openssh(fs::read_to_string(&k.private_path).unwrap()).unwrap();
        assert!(parsed.is_encrypted());
        let plain = parsed.decrypt("una frase larga").unwrap();
        assert_eq!(plain.public_key().to_openssh().unwrap(), k.public_line);
        let _ = fs::remove_dir_all(&d);
    }
}
