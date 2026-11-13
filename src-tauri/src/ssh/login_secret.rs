//! Contraseña con la que se autenticó cada sesión (servidores que entran con contraseña).
//!
//! Para el ajuste de sudo «La de la conexión»: si el usuario escribió la contraseña al conectar SIN
//! guardarla, sudo también la puede usar mientras viva la sesión. Solo en memoria (`Zeroizing`): se borra
//! al cerrar o perder la sesión (`SessionStore::remove`) y al bloquear TerView con el PIN (`forget_all`).
//! Nunca va a registros ni al servidor MCP; solo sale por `profiles_sudo_password` (interfaz, modo
//! «La de la conexión»), igual que la contraseña de sudo en memoria de la interfaz.
//!
//! No se guarda si la contraseña venía de la bóveda o se acaba de guardar en ella: esa ya se lee de la
//! bóveda (y así no queda en memoria con TerView bloqueado).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use zeroize::Zeroizing;

static LOGIN: LazyLock<Mutex<HashMap<String, Zeroizing<String>>>> = LazyLock::new(Default::default);

fn with<T>(f: impl FnOnce(&mut HashMap<String, Zeroizing<String>>) -> T) -> T {
    let mut m = LOGIN.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut m)
}

/// Recuerda la contraseña con la que se autenticó la sesión.
pub fn remember(session_id: &str, password: &str) {
    if password.is_empty() {
        return;
    }
    with(|m| m.insert(session_id.to_string(), Zeroizing::new(password.to_string())));
}

/// Contraseña de la sesión, si se recordó.
pub fn get(session_id: &str) -> Option<Zeroizing<String>> {
    with(|m| m.get(session_id).cloned())
}

/// La olvida (sesión cerrada o perdida).
pub fn forget(session_id: &str) {
    with(|m| m.remove(session_id));
}

/// Olvida todas (al bloquear TerView).
pub fn forget_all() {
    with(|m| m.clear());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_get_forget() {
        remember("ls-a", "secreto");
        remember("ls-b", "otra");
        remember("ls-c", "");
        assert_eq!(get("ls-a").as_deref().map(String::as_str), Some("secreto"));
        assert!(get("ls-c").is_none());
        forget("ls-a");
        assert!(get("ls-a").is_none());
        assert_eq!(get("ls-b").as_deref().map(String::as_str), Some("otra"));
        forget("ls-b");
    }
}
