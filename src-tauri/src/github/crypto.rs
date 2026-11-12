//! Cifrado de la configuración sincronizada: AES-256-GCM con clave derivada por Argon2id.
//!
//! El sobre (`Envelope`) es JSON y lleva todo lo necesario para descifrar salvo la frase:
//! parámetros de Argon2id, sal, nonce y el texto cifrado (base64). La cabecera va autenticada
//! como datos asociados (AAD): si alguien cambia los parámetros o la sal, el descifrado falla.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64ct::{Base64, Encoding};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const FORMAT: &str = "terview-sync";
pub const VERSION: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// Frase mínima aceptada al cifrar.
pub const MIN_PASSPHRASE: usize = 8;

/// Parámetros de Argon2id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    /// Memoria en KiB.
    pub m_kib: u32,
    /// Iteraciones.
    pub t: u32,
    /// Paralelismo.
    pub p: u32,
}

/// 64 MiB, 3 pasadas, 1 hilo (por encima de las recomendaciones de OWASP para Argon2id).
pub const DEFAULT_KDF: KdfParams = KdfParams {
    m_kib: 64 * 1024,
    t: 3,
    p: 1,
};

// Límites al descifrar: un sobre manipulado no debe poder pedir 100 GB de memoria.
const MAX_M_KIB: u32 = 1024 * 1024;
const MAX_T: u32 = 20;
const MAX_P: u32 = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfInfo {
    pub alg: String,
    #[serde(flatten)]
    pub params: KdfParams,
    pub salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub format: String,
    pub version: u32,
    pub kdf: KdfInfo,
    pub cipher: String,
    pub nonce: String,
    pub data: String,
}

fn random<const N: usize>() -> AppResult<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b)
        .map_err(|e| AppError::Io(format!("no se pudo generar azar seguro: {e}")))?;
    Ok(b)
}

fn derive_key(passphrase: &str, salt: &[u8], p: KdfParams) -> AppResult<[u8; 32]> {
    let params = Params::new(p.m_kib, p.t, p.p, Some(32))
        .map_err(|e| AppError::Invalid(format!("parámetros de cifrado no válidos: {e}")))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Invalid(format!("no se pudo derivar la clave: {e}")))?;
    Ok(key)
}

/// Datos asociados: cabecera canónica (todo menos el nonce y el texto cifrado).
fn aad(p: KdfParams, salt_b64: &str) -> String {
    format!(
        "{FORMAT}/{VERSION}/argon2id/{}/{}/{}/{salt_b64}/aes-256-gcm",
        p.m_kib, p.t, p.p
    )
}

fn wipe(key: &mut [u8; 32]) {
    key.fill(0);
    std::hint::black_box(key);
}

pub fn encrypt(plaintext: &[u8], passphrase: &str) -> AppResult<Envelope> {
    encrypt_with(plaintext, passphrase, DEFAULT_KDF)
}

pub fn encrypt_with(plaintext: &[u8], passphrase: &str, params: KdfParams) -> AppResult<Envelope> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(AppError::Invalid(format!(
            "La frase de paso debe tener al menos {MIN_PASSPHRASE} caracteres"
        )));
    }
    let salt = random::<SALT_LEN>()?;
    let nonce = random::<NONCE_LEN>()?;
    let salt_b64 = Base64::encode_string(&salt);
    let mut key = derive_key(passphrase, &salt, params)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| AppError::Invalid("clave inválida".into()));
    wipe(&mut key);
    let header = aad(params, &salt_b64);
    let ct = cipher?
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: plaintext,
                aad: header.as_bytes(),
            },
        )
        .map_err(|_| AppError::Invalid("no se pudo cifrar".into()))?;
    Ok(Envelope {
        format: FORMAT.into(),
        version: VERSION,
        kdf: KdfInfo {
            alg: "argon2id".into(),
            params,
            salt: salt_b64,
        },
        cipher: "aes-256-gcm".into(),
        nonce: Base64::encode_string(&nonce),
        data: Base64::encode_string(&ct),
    })
}

pub fn decrypt(env: &Envelope, passphrase: &str) -> AppResult<Vec<u8>> {
    if env.format != FORMAT {
        return Err(AppError::Invalid(
            "el archivo no es una copia de configuración de TerView".into(),
        ));
    }
    if env.version != VERSION || env.kdf.alg != "argon2id" || env.cipher != "aes-256-gcm" {
        return Err(AppError::Invalid(
            "la copia se hizo con una versión de TerView más nueva; actualiza la app".into(),
        ));
    }
    let p = env.kdf.params;
    if p.m_kib > MAX_M_KIB || p.t > MAX_T || p.p > MAX_P || p.t == 0 || p.p == 0 {
        return Err(AppError::Invalid(
            "parámetros de cifrado fuera de rango".into(),
        ));
    }
    let bad = || AppError::Invalid("la copia cifrada está dañada".into());
    let salt = Base64::decode_vec(&env.kdf.salt).map_err(|_| bad())?;
    let nonce: [u8; NONCE_LEN] = Base64::decode_vec(&env.nonce)
        .map_err(|_| bad())?
        .try_into()
        .map_err(|_| bad())?;
    let ct = Base64::decode_vec(&env.data).map_err(|_| bad())?;
    if salt.len() < 8 {
        return Err(bad());
    }
    let mut key = derive_key(passphrase, &salt, p)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| AppError::Invalid("clave inválida".into()));
    wipe(&mut key);
    let header = aad(p, &env.kdf.salt);
    cipher?
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &ct,
                aad: header.as_bytes(),
            },
        )
        .map_err(|_| {
            AppError::AuthFailed("la frase de paso no es correcta (o la copia está dañada)".into())
        })
}
