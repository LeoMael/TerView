//! Secretos en el llavero del sistema (servicio "terview", usuario = id del servidor).
//!
//! Usa `keyring` 4 (modo `v1`): el almacén por defecto de la plataforma (Secret Service en
//! Linux, Keychain en macOS, Credential Manager en Windows) se inicializa una sola vez,
//! de forma perezosa, en la primera llamada.
//!
//! Las llamadas pueden bloquear (D-Bus): desde código async conviene usar `spawn_blocking`.

use keyring::{Entry, Error as KrError};

use crate::error::{AppError, AppResult};

/// Servicio usado en el llavero real.
pub const SERVICE: &str = "terview";

pub fn get_secret(profile_id: &str) -> AppResult<Option<String>> {
    get_secret_in(SERVICE, profile_id)
}

pub fn set_secret(profile_id: &str, secret: &str) -> AppResult<()> {
    set_secret_in(SERVICE, profile_id, secret)
}

/// Borra el secreto. Si no existía, no es error.
pub fn delete_secret(profile_id: &str) -> AppResult<()> {
    delete_secret_in(SERVICE, profile_id)
}

// ───────── Token de GitHub (servicio "terview", usuario "github-token") ─────────

/// Usuario del llavero donde se guarda el token personal de GitHub.
pub const GITHUB_TOKEN_USER: &str = "github-token";

/// Token de GitHub guardado (None si no hay cuenta conectada).
pub fn get_github_token() -> AppResult<Option<String>> {
    get_secret_in(SERVICE, GITHUB_TOKEN_USER)
}

/// Guarda (o reemplaza) el token de GitHub. Solo en el llavero: nunca en archivos ni en logs.
pub fn set_github_token(token: &str) -> AppResult<()> {
    set_secret_in(SERVICE, GITHUB_TOKEN_USER, token)
}

/// Borra el token de GitHub ("Desconectar"). Si no existía, no es error.
pub fn delete_github_token() -> AppResult<()> {
    delete_secret_in(SERVICE, GITHUB_TOKEN_USER)
}

// ───────── Implementación parametrizada por servicio (los tests usan "terview-test") ─────────

fn entry(service: &str, user: &str) -> AppResult<Entry> {
    if user.trim().is_empty() {
        return Err(AppError::Invalid("Falta el id del servidor para el llavero".into()));
    }
    Entry::new(service, user).map_err(map_err)
}

pub(crate) fn get_secret_in(service: &str, user: &str) -> AppResult<Option<String>> {
    let e = entry(service, user)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(KrError::NoEntry) => Ok(None),
        // Varias entradas iguales (p. ej. creadas por otra app): usamos la primera legible.
        Err(KrError::Ambiguous(entries)) => {
            for c in entries {
                if let Ok(s) = c.get_password() {
                    return Ok(Some(s));
                }
            }
            Ok(None)
        }
        Err(err) => Err(map_err(err)),
    }
}

pub(crate) fn set_secret_in(service: &str, user: &str, secret: &str) -> AppResult<()> {
    let e = entry(service, user)?;
    match e.set_password(secret) {
        Ok(()) => Ok(()),
        Err(KrError::Ambiguous(entries)) => {
            // Limpiamos duplicados y volvemos a guardar.
            for c in entries {
                let _ = c.delete_credential();
            }
            e.set_password(secret).map_err(map_err)
        }
        Err(err) => Err(map_err(err)),
    }
}

pub(crate) fn delete_secret_in(service: &str, user: &str) -> AppResult<()> {
    let e = entry(service, user)?;
    match e.delete_credential() {
        Ok(()) | Err(KrError::NoEntry) => Ok(()),
        Err(KrError::Ambiguous(entries)) => {
            for c in entries {
                match c.delete_credential() {
                    Ok(()) | Err(KrError::NoEntry) => {}
                    Err(err) => return Err(map_err(err)),
                }
            }
            Ok(())
        }
        Err(err) => Err(map_err(err)),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
const UNAVAILABLE: &str = "no hay un llavero del sistema disponible. Instala o activa GNOME Keyring, \
KWallet u otro servicio compatible con Secret Service (o no marques «guardar en el llavero»).";
#[cfg(windows)]
const UNAVAILABLE: &str = "el Administrador de credenciales de Windows no está disponible \
(o no marques «guardar en el llavero»).";
#[cfg(target_os = "macos")]
const UNAVAILABLE: &str = "el llavero de macOS no está disponible (o no marques «guardar en el llavero»).";

fn map_err(err: KrError) -> AppError {
    let msg = match err {
        KrError::NoDefaultStore => UNAVAILABLE.to_string(),
        KrError::NoStorageAccess(e) => {
            format!("el llavero está bloqueado o se negó el acceso ({e}). Desbloquéalo e inténtalo de nuevo.")
        }
        KrError::PlatformFailure(e) => {
            let detail = e.to_string();
            if looks_unavailable(&detail) {
                UNAVAILABLE.to_string()
            } else {
                format!("error del llavero: {detail}")
            }
        }
        KrError::BadEncoding(_) => "el secreto guardado no es texto válido".to_string(),
        KrError::TooLong(attr, max) => format!("«{attr}» es demasiado largo (máx. {max})"),
        KrError::Invalid(attr, why) => format!("dato inválido «{attr}»: {why}"),
        other => other.to_string(),
    };
    AppError::Keyring(msg)
}

fn looks_unavailable(detail: &str) -> bool {
    let d = detail.to_ascii_lowercase();
    d.contains("serviceunknown")
        || d.contains("not provided by any .service")
        || d.contains("dbus_session_bus_address")
        || d.contains("no such file or directory")
        || d.contains("connection refused")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SERVICE: &str = "terview-test";

    /// Usa el llavero real del sistema con el servicio "terview-test".
    /// `cargo test --lib storage -- --ignored --test-threads=1`
    #[test]
    #[ignore]
    fn keyring_roundtrip() {
        let user = format!("test-{}", uuid::Uuid::new_v4());
        match get_secret_in(TEST_SERVICE, &user) {
            Ok(None) => {}
            Ok(Some(_)) => panic!("no debería existir"),
            Err(AppError::Keyring(m)) => {
                eprintln!("Llavero no disponible, se omite: {m}");
                return;
            }
            Err(e) => panic!("{e}"),
        }
        set_secret_in(TEST_SERVICE, &user, "s3cr3t ñ").unwrap();
        assert_eq!(get_secret_in(TEST_SERVICE, &user).unwrap().as_deref(), Some("s3cr3t ñ"));
        set_secret_in(TEST_SERVICE, &user, "otra").unwrap();
        assert_eq!(get_secret_in(TEST_SERVICE, &user).unwrap().as_deref(), Some("otra"));
        delete_secret_in(TEST_SERVICE, &user).unwrap();
        assert_eq!(get_secret_in(TEST_SERVICE, &user).unwrap(), None);
        // Borrar dos veces no es error.
        delete_secret_in(TEST_SERVICE, &user).unwrap();
    }

    #[test]
    fn empty_user_is_invalid() {
        assert!(matches!(get_secret_in(TEST_SERVICE, " "), Err(AppError::Invalid(_))));
    }
}
