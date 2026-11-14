//! Cifrado de la configuración sincronizada: AES-256-GCM con clave derivada por Argon2id.
//!
//! La parte común (sobre JSON, cabecera autenticada como AAD, límites) vive en
//! `storage::cipher` y la comparte la bóveda de contraseñas. Aquí solo queda lo propio de la
//! copia sincronizada: formato "sshorus-sync", frase mínima y mensajes.

use crate::error::{AppError, AppResult};
use crate::storage::cipher::{self, EnvError};

pub use crate::storage::cipher::{Envelope, KdfParams};

pub const FORMAT: &str = "sshorus-sync";
pub const VERSION: u32 = 1;
/// Frase mínima aceptada al cifrar.
pub const MIN_PASSPHRASE: usize = 8;

/// 64 MiB, 3 pasadas, 1 hilo (por encima de las recomendaciones de OWASP para Argon2id).
pub const DEFAULT_KDF: KdfParams = KdfParams {
    m_kib: 64 * 1024,
    t: 3,
    p: 1,
};

pub fn encrypt(plaintext: &[u8], passphrase: &str) -> AppResult<Envelope> {
    encrypt_with(plaintext, passphrase, DEFAULT_KDF)
}

pub fn encrypt_with(plaintext: &[u8], passphrase: &str, params: KdfParams) -> AppResult<Envelope> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(AppError::Invalid(format!(
            "La frase de paso debe tener al menos {MIN_PASSPHRASE} caracteres"
        )));
    }
    let salt_b64 = cipher::new_salt_b64()?;
    let key = cipher::derive_key_b64(passphrase.as_bytes(), &salt_b64, params)?;
    cipher::seal(FORMAT, VERSION, &key, params, &salt_b64, plaintext)
}

fn env_error(e: EnvError) -> AppError {
    match e {
        EnvError::WrongFormat => {
            AppError::Invalid("el archivo no es una copia de configuración de SSHorus".into())
        }
        EnvError::Unsupported => AppError::Invalid(
            "la copia se hizo con una versión de SSHorus más nueva; actualiza la app".into(),
        ),
        EnvError::OutOfRange => AppError::Invalid("parámetros de cifrado fuera de rango".into()),
        EnvError::Damaged => AppError::Invalid("la copia cifrada está dañada".into()),
        EnvError::BadKey => {
            AppError::AuthFailed("la frase de paso no es correcta (o la copia está dañada)".into())
        }
    }
}

pub fn decrypt(env: &Envelope, passphrase: &str) -> AppResult<Vec<u8>> {
    let (params, salt) = cipher::check(env, FORMAT, VERSION).map_err(env_error)?;
    let key = cipher::derive_key(passphrase.as_bytes(), &salt, params)?;
    let mut plain = cipher::open(env, FORMAT, VERSION, &key).map_err(env_error)?;
    Ok(std::mem::take(&mut *plain))
}
