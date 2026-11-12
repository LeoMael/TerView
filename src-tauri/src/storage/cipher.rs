//! Cifrado común: AES-256-GCM con llave derivada por Argon2id, en un sobre JSON.
//!
//! Lo usan la copia sincronizada (`github::crypto`, formato "terview-sync") y la bóveda de
//! contraseñas (`storage::vault`, formato "terview-vault").
//!
//! El sobre (`Envelope`) lleva todo lo necesario para descifrar salvo la frase o el PIN:
//! parámetros de Argon2id, sal, nonce y el texto cifrado (base64). La cabecera va autenticada
//! como datos asociados (AAD): si alguien cambia el formato, los parámetros, la sal o la
//! etiqueta `kind`, el descifrado falla.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64ct::{Base64, Encoding};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
const ALG: &str = "argon2id";
const CIPHER: &str = "aes-256-gcm";

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

// Límites al descifrar: un sobre manipulado no debe poder pedir 100 GB de memoria.
const MAX_M_KIB: u32 = 1024 * 1024;
pub const MAX_T: u32 = 20;
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
    /// Etiqueta corta opcional, en claro pero autenticada (la bóveda guarda aquí el tipo de PIN:
    /// "pin6" o "text"). Los sobres sin ella (copias sincronizadas, bóvedas antiguas) no la
    /// escriben y su cabecera autenticada es la de siempre.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub nonce: String,
    pub data: String,
}

/// Largo máximo de `Envelope::kind`.
const MAX_KIND: usize = 16;

fn kind_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= MAX_KIND && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Por qué no se pudo abrir un sobre. Cada usuario lo traduce a su propio mensaje.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvError {
    /// No es un sobre de este formato.
    WrongFormat,
    /// Versión, algoritmo o cifrado desconocidos (hecho con una versión más nueva).
    Unsupported,
    /// Parámetros de Argon2id fuera de rango (sobre manipulado).
    OutOfRange,
    /// Base64 o longitudes incorrectas.
    Damaged,
    /// La llave no abre el sobre: frase/PIN incorrecto o datos alterados.
    BadKey,
}

/// Bytes aleatorios del sistema.
pub fn random<const N: usize>() -> AppResult<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b)
        .map_err(|e| AppError::Io(format!("no se pudo generar azar seguro: {e}")))?;
    Ok(b)
}

/// Sal nueva en base64 (así se guarda y así entra en la cabecera autenticada).
pub fn new_salt_b64() -> AppResult<String> {
    Ok(Base64::encode_string(&random::<SALT_LEN>()?))
}

/// Deriva la llave de 32 bytes. La llave se borra de la memoria al soltarla.
pub fn derive_key(secret: &[u8], salt: &[u8], p: KdfParams) -> AppResult<Zeroizing<[u8; 32]>> {
    derive(secret, salt, p, None)
}

/// Igual que `derive_key` pero con una segunda llave secreta (el «secreto» K de Argon2, pensado
/// justo para esto). Sin esa llave, ni con la frase correcta sale la misma llave.
pub fn derive_key_keyed(
    secret: &[u8],
    salt: &[u8],
    p: KdfParams,
    pepper: &[u8],
) -> AppResult<Zeroizing<[u8; 32]>> {
    derive(secret, salt, p, Some(pepper))
}

fn derive(secret: &[u8], salt: &[u8], p: KdfParams, pepper: Option<&[u8]>) -> AppResult<Zeroizing<[u8; 32]>> {
    let params = Params::new(p.m_kib, p.t, p.p, Some(32))
        .map_err(|e| AppError::Invalid(format!("parámetros de cifrado no válidos: {e}")))?;
    let argon = match pepper {
        Some(k) => Argon2::new_with_secret(k, Algorithm::Argon2id, Version::V0x13, params)
            .map_err(|e| AppError::Invalid(format!("llave del equipo no válida: {e}")))?,
        None => Argon2::new(Algorithm::Argon2id, Version::V0x13, params),
    };
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(secret, salt, key.as_mut())
        .map_err(|e| AppError::Invalid(format!("no se pudo derivar la clave: {e}")))?;
    Ok(key)
}

/// Igual que `derive_key` pero con la sal en base64 (como va en el sobre).
pub fn derive_key_b64(secret: &[u8], salt_b64: &str, p: KdfParams) -> AppResult<Zeroizing<[u8; 32]>> {
    let salt = Base64::decode_vec(salt_b64)
        .map_err(|_| AppError::Invalid("la sal del cifrado está dañada".into()))?;
    derive_key(secret, &salt, p)
}

/// Igual que `derive_key_keyed` pero con la sal en base64.
pub fn derive_key_keyed_b64(
    secret: &[u8],
    salt_b64: &str,
    p: KdfParams,
    pepper: &[u8],
) -> AppResult<Zeroizing<[u8; 32]>> {
    let salt = Base64::decode_vec(salt_b64)
        .map_err(|_| AppError::Invalid("la sal del cifrado está dañada".into()))?;
    derive_key_keyed(secret, &salt, p, pepper)
}

/// Datos asociados: cabecera canónica (todo menos el nonce y el texto cifrado). Sin `kind`
/// queda igual que antes de existir, así que los sobres antiguos se siguen abriendo.
fn aad(format: &str, version: u32, p: KdfParams, salt_b64: &str, kind: Option<&str>) -> String {
    let mut s = format!(
        "{format}/{version}/{ALG}/{}/{}/{}/{salt_b64}/{CIPHER}",
        p.m_kib, p.t, p.p
    );
    if let Some(k) = kind {
        s.push_str("/kind=");
        s.push_str(k);
    }
    s
}

/// Cifra `plaintext` con una llave ya derivada (nonce nuevo cada vez).
pub fn seal(
    format: &str,
    version: u32,
    key: &[u8; 32],
    params: KdfParams,
    salt_b64: &str,
    plaintext: &[u8],
) -> AppResult<Envelope> {
    seal_with_kind(format, version, key, params, salt_b64, None, plaintext)
}

/// Igual que `seal`, con una etiqueta `kind` autenticada en la cabecera.
pub fn seal_with_kind(
    format: &str,
    version: u32,
    key: &[u8; 32],
    params: KdfParams,
    salt_b64: &str,
    kind: Option<&str>,
    plaintext: &[u8],
) -> AppResult<Envelope> {
    if kind.is_some_and(|k| !kind_ok(k)) {
        return Err(AppError::Invalid("etiqueta de cifrado no válida".into()));
    }
    let nonce = random::<NONCE_LEN>()?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Invalid("clave inválida".into()))?;
    let header = aad(format, version, params, salt_b64, kind);
    let ct = cipher
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: plaintext,
                aad: header.as_bytes(),
            },
        )
        .map_err(|_| AppError::Invalid("no se pudo cifrar".into()))?;
    Ok(Envelope {
        format: format.into(),
        version,
        kdf: KdfInfo {
            alg: ALG.into(),
            params,
            salt: salt_b64.into(),
        },
        cipher: CIPHER.into(),
        kind: kind.map(str::to_string),
        nonce: Base64::encode_string(&nonce),
        data: Base64::encode_string(&ct),
    })
}

/// Comprueba la cabecera (formato, versión, algoritmos, rangos y base64) sin derivar nada.
/// Devuelve los parámetros y la sal ya decodificada.
pub fn check(env: &Envelope, format: &str, version: u32) -> Result<(KdfParams, Vec<u8>), EnvError> {
    if env.format != format {
        return Err(EnvError::WrongFormat);
    }
    if env.version != version || env.kdf.alg != ALG || env.cipher != CIPHER {
        return Err(EnvError::Unsupported);
    }
    if env.kind.as_deref().is_some_and(|k| !kind_ok(k)) {
        return Err(EnvError::Damaged);
    }
    let p = env.kdf.params;
    if p.m_kib > MAX_M_KIB || p.t > MAX_T || p.p > MAX_P || p.t == 0 || p.p == 0 {
        return Err(EnvError::OutOfRange);
    }
    let salt = Base64::decode_vec(&env.kdf.salt).map_err(|_| EnvError::Damaged)?;
    if salt.len() < 8 {
        return Err(EnvError::Damaged);
    }
    // Nonce y datos también se validan aquí: un archivo dañado falla antes de gastar en Argon2.
    let nonce_ok = Base64::decode_vec(&env.nonce).is_ok_and(|n| n.len() == NONCE_LEN);
    if !nonce_ok || Base64::decode_vec(&env.data).is_err() {
        return Err(EnvError::Damaged);
    }
    Ok((p, salt))
}

/// Descifra con una llave ya derivada. Llama antes a `check` (aquí se repite, es barato).
pub fn open(
    env: &Envelope,
    format: &str,
    version: u32,
    key: &[u8; 32],
) -> Result<Zeroizing<Vec<u8>>, EnvError> {
    let (p, _) = check(env, format, version)?;
    let nonce: [u8; NONCE_LEN] = Base64::decode_vec(&env.nonce)
        .map_err(|_| EnvError::Damaged)?
        .try_into()
        .map_err(|_| EnvError::Damaged)?;
    let ct = Base64::decode_vec(&env.data).map_err(|_| EnvError::Damaged)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| EnvError::BadKey)?;
    let header = aad(format, version, p, &env.kdf.salt, env.kind.as_deref());
    cipher
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &ct,
                aad: header.as_bytes(),
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| EnvError::BadKey)
}
