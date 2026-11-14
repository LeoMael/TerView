//! Secretos guardados: contraseña o frase de cada servidor (usuario = id del servidor), su
//! contraseña de sudo (usuario = "<id>:sudo") y el token de GitHub (usuario "github-token").
//!
//! Dónde se guardan:
//! - Con la bóveda activa (`storage::vault`): en `vault.json`, cifrados con el PIN. Si está
//!   bloqueada, todas las funciones devuelven `AppError::Locked`.
//! - Sin bóveda: en el llavero del sistema (servicio "sshorus"), como siempre.
//!
//! El llavero usa `keyring` 4 (modo `v1`): el almacén por defecto de la plataforma (Secret
//! Service en Linux, Keychain en macOS, Credential Manager en Windows) se inicializa una sola
//! vez, de forma perezosa, en la primera llamada.
//!
//! Las llamadas pueden bloquear (D-Bus): desde código async conviene usar `spawn_blocking`.

use std::collections::{BTreeMap, BTreeSet};

use keyring::{Entry, Error as KrError};
use serde::{Deserialize, Serialize};

use base64ct::{Base64, Encoding};
use zeroize::Zeroizing;

use super::cipher::KdfParams;
use super::vault::{DeviceKeyStore, Vault, DEVICE_KEY_USER};
use crate::error::{AppError, AppResult};

/// Servicio usado en el llavero real.
pub const SERVICE: &str = "sshorus";

fn check_user(user: &str) -> AppResult<()> {
    if user.trim().is_empty() {
        return Err(AppError::Invalid("Falta el id del servidor para el llavero".into()));
    }
    Ok(())
}

pub fn get_secret(profile_id: &str) -> AppResult<Option<String>> {
    get_with(Vault::global(), &SystemKeyring(SERVICE), profile_id)
}

pub fn set_secret(profile_id: &str, secret: &str) -> AppResult<()> {
    set_with(Vault::global(), &SystemKeyring(SERVICE), profile_id, secret)
}

/// Borra el secreto. Si no existía, no es error.
pub fn delete_secret(profile_id: &str) -> AppResult<()> {
    delete_with(Vault::global(), &SystemKeyring(SERVICE), profile_id)
}

/// Lee de la bóveda si existe; si no, del llavero.
pub(crate) fn get_with(vault: &Vault, kr: &dyn Keyring, id: &str) -> AppResult<Option<String>> {
    check_user(id)?;
    match vault.get(id) {
        Some(r) => r,
        None => kr.get(id),
    }
}

pub(crate) fn set_with(vault: &Vault, kr: &dyn Keyring, id: &str, secret: &str) -> AppResult<()> {
    check_user(id)?;
    match vault.set(id, secret) {
        Some(r) => r,
        None => kr.set(id, secret),
    }
}

pub(crate) fn delete_with(vault: &Vault, kr: &dyn Keyring, id: &str) -> AppResult<()> {
    check_user(id)?;
    match vault.delete(id) {
        Some(r) => r,
        None => kr.delete(id),
    }
}

// ───────── Secretos de un servidor: contraseña de conexión y contraseña de sudo ─────────

/// Final del id de la contraseña de sudo de un servidor ("<id>:sudo").
pub const SUDO_SUFFIX: &str = ":sudo";

/// Id (en la bóveda o el llavero) de la contraseña de sudo guardada de un servidor.
pub fn sudo_id(profile_id: &str) -> String {
    format!("{profile_id}{SUDO_SUFFIX}")
}

/// Qué secreto de un servidor: el de conexión (contraseña o frase de la llave) o el de sudo.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    #[default]
    Login,
    Sudo,
}

impl SecretKind {
    /// Id donde se guarda ese secreto del servidor.
    pub fn id(self, profile_id: &str) -> String {
        match self {
            SecretKind::Login => profile_id.to_string(),
            SecretKind::Sudo => sudo_id(profile_id),
        }
    }
}

/// Todos los ids de secretos de un servidor.
pub fn server_secret_ids(profile_id: &str) -> [String; 2] {
    [profile_id.to_string(), sudo_id(profile_id)]
}

/// Borra los secretos de un servidor (conexión y sudo). Intenta todos; devuelve el primer error.
pub(crate) fn delete_server_secrets_with(vault: &Vault, kr: &dyn Keyring, profile_id: &str) -> AppResult<()> {
    let mut first = Ok(());
    for id in server_secret_ids(profile_id) {
        let r = delete_with(vault, kr, &id);
        if first.is_ok() {
            first = r;
        }
    }
    first
}

/// Copia los secretos de un servidor (conexión y sudo) a otro (al duplicar).
pub(crate) fn copy_server_secrets_with(vault: &Vault, kr: &dyn Keyring, from: &str, to: &str) -> AppResult<()> {
    for kind in [SecretKind::Login, SecretKind::Sudo] {
        if let Some(secret) = get_with(vault, kr, &kind.id(from))?.map(Zeroizing::new) {
            set_with(vault, kr, &kind.id(to), &secret)?;
        }
    }
    Ok(())
}

pub fn delete_server_secrets(profile_id: &str) -> AppResult<()> {
    delete_server_secrets_with(Vault::global(), &SystemKeyring(SERVICE), profile_id)
}

pub fn copy_server_secrets(from: &str, to: &str) -> AppResult<()> {
    copy_server_secrets_with(Vault::global(), &SystemKeyring(SERVICE), from, to)
}

/// Error si la bóveda está bloqueada (para cachés que no pasan por `get_secret`).
pub fn ensure_unlocked() -> AppResult<()> {
    let st = Vault::global().status();
    if st.locked {
        return Err(AppError::Locked);
    }
    Ok(())
}

// ───────── Token de GitHub (usuario "github-token") ─────────

/// Usuario del llavero (o id en la bóveda) donde se guarda el token personal de GitHub.
pub const GITHUB_TOKEN_USER: &str = "github-token";

/// Token de GitHub guardado (None si no hay cuenta conectada).
pub fn get_github_token() -> AppResult<Option<String>> {
    get_secret(GITHUB_TOKEN_USER)
}

/// Guarda (o reemplaza) el token de GitHub. Solo en la bóveda o el llavero: nunca en archivos
/// sin cifrar ni en logs.
pub fn set_github_token(token: &str) -> AppResult<()> {
    set_secret(GITHUB_TOKEN_USER, token)
}

/// Borra el token de GitHub ("Desconectar"). Si no existía, no es error.
pub fn delete_github_token() -> AppResult<()> {
    delete_secret(GITHUB_TOKEN_USER)
}

// ───────── Token del servidor MCP (usuario "mcp-token") ─────────

/// Usuario del llavero (o id en la bóveda) del token que usan los asistentes de IA (módulo `mcp`).
pub const MCP_TOKEN_USER: &str = "mcp-token";

// ───────── Mover secretos entre el llavero y la bóveda ─────────

/// Dónde se leen y escriben los secretos fuera de la bóveda (el llavero; en tests, memoria).
pub(crate) trait Keyring {
    fn get(&self, user: &str) -> AppResult<Option<String>>;
    fn set(&self, user: &str, secret: &str) -> AppResult<()>;
    fn delete(&self, user: &str) -> AppResult<()>;
}

/// El llavero del sistema con un servicio concreto ("sshorus"; "sshorus-test" en pruebas).
pub(crate) struct SystemKeyring(pub &'static str);

impl Keyring for SystemKeyring {
    fn get(&self, user: &str) -> AppResult<Option<String>> {
        get_secret_in(self.0, user)
    }
    fn set(&self, user: &str, secret: &str) -> AppResult<()> {
        set_secret_in(self.0, user, secret)
    }
    fn delete(&self, user: &str) -> AppResult<()> {
        delete_secret_in(self.0, user)
    }
}

/// La llave de este equipo de la bóveda, en el llavero del sistema (usuario `vault-device-key`,
/// en base64). Va siempre al llavero, nunca a la bóveda.
pub(crate) struct KeyringDeviceKey(pub &'static str);

impl DeviceKeyStore for KeyringDeviceKey {
    fn load(&self) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
        let Some(text) = get_secret_in(self.0, DEVICE_KEY_USER)?.map(Zeroizing::new) else {
            return Ok(None);
        };
        Base64::decode_vec(text.trim())
            .map(|k| Some(Zeroizing::new(k)))
            .map_err(|_| AppError::Invalid("la llave de este equipo en el llavero está dañada".into()))
    }
    fn save(&self, key: &[u8]) -> AppResult<()> {
        let text = Zeroizing::new(Base64::encode_string(key));
        set_secret_in(self.0, DEVICE_KEY_USER, &text)
    }
    fn delete(&self) -> AppResult<()> {
        delete_secret_in(self.0, DEVICE_KEY_USER)
    }
}

/// Resultado de mover secretos.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    /// Secretos movidos.
    pub moved: u32,
    /// Al activar: copias que no se pudieron borrar del llavero (siguen allí, no se perdió nada).
    pub left_in_keyring: u32,
}

/// El llavero no existe en este sistema (no hay nada que leer).
fn keyring_unavailable(e: &AppError) -> bool {
    matches!(e, AppError::Keyring(m) if m == UNAVAILABLE)
}

/// Crea la bóveda y mueve a ella los secretos del llavero de esos servidores (contraseña de
/// conexión y de sudo), el token de GitHub, el del servidor MCP (`mcp-token`) y el de la IA que
/// explica informes (`ai-token`).
///
/// Orden seguro: 1) leer todo del llavero (si algo falla, no se crea nada); 2) escribir la
/// bóveda y comprobar que se descifra; 3) solo entonces borrar las copias del llavero. Si se corta
/// a mitad, los secretos siguen en el llavero, en la bóveda o en ambos: nunca se pierden.
pub(crate) fn enable_vault(
    vault: &Vault,
    kr: &dyn Keyring,
    ids: &[String],
    pin: &str,
    params: KdfParams,
) -> AppResult<MoveReport> {
    super::vault::check_new_pin(pin)?;
    let users: BTreeSet<String> = ids
        .iter()
        .map(String::as_str)
        .filter(|u| !u.trim().is_empty())
        .flat_map(server_secret_ids)
        .chain([
            GITHUB_TOKEN_USER.to_string(),
            MCP_TOKEN_USER.to_string(),
            crate::ai::AI_TOKEN_USER.to_string(),
        ])
        .collect();
    let mut found = BTreeMap::new();
    for u in users {
        match kr.get(&u) {
            Ok(Some(s)) if !s.is_empty() => {
                found.insert(u, s);
            }
            Ok(_) => {}
            // Sin llavero en el sistema no puede haber nada guardado en él.
            Err(e) if keyring_unavailable(&e) => break,
            Err(e) => return Err(e),
        }
    }
    let ids: Vec<String> = found.keys().cloned().collect();
    vault.create(pin, found, params)?;
    let mut report = MoveReport {
        moved: ids.len() as u32,
        left_in_keyring: 0,
    };
    for id in &ids {
        if let Err(e) = kr.delete(id) {
            log::warn!("bóveda: no se pudo borrar del llavero la copia de {id}: {e}");
            report.left_in_keyring += 1;
        }
    }
    Ok(report)
}

/// Desactiva la bóveda: comprueba el PIN, devuelve los secretos al llavero, comprueba que están y
/// solo entonces borra `vault.json`. Si algo falla, la bóveda sigue igual.
pub(crate) fn disable_vault(vault: &Vault, kr: &dyn Keyring, pin: &str) -> AppResult<MoveReport> {
    let secrets = vault.export_with_pin(pin)?;
    let mut written: Vec<&str> = Vec::new();
    let undo = |written: &[&str]| {
        for id in written {
            let _ = kr.delete(id);
        }
    };
    for (id, s) in &secrets {
        if let Err(e) = kr.set(id, s) {
            undo(&written);
            return Err(e);
        }
        written.push(id);
    }
    for (id, s) in &secrets {
        let ok = matches!(kr.get(id), Ok(Some(v)) if v == **s);
        if !ok {
            undo(&written);
            return Err(AppError::Keyring(
                "no se pudo comprobar que las contraseñas quedaron en el llavero; la bóveda sigue activa"
                    .into(),
            ));
        }
    }
    vault.remove()?;
    Ok(MoveReport {
        moved: secrets.len() as u32,
        left_in_keyring: 0,
    })
}

// ───────── Implementación parametrizada por servicio (los tests usan "sshorus-test") ─────────

fn entry(service: &str, user: &str) -> AppResult<Entry> {
    check_user(user)?;
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

    const TEST_SERVICE: &str = "sshorus-test";

    /// Usa el llavero real del sistema con el servicio "sshorus-test".
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
