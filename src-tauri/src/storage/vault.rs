//! Bóveda de contraseñas: las contraseñas y frases guardadas (de conexión y de sudo, y el token de
//! GitHub) cifradas con una llave que sale del PIN del usuario Y de una llave de este equipo.
//!
//! - Archivo: `vault.json` en la carpeta de configuración (escritura atómica, permisos 0600).
//!   Es un sobre de `storage::cipher` (AES-256-GCM + Argon2id) con formato "terview-vault".
//!   Dentro, cifrado: `{ "secrets": { "<id>": "<secreto>", … } }`.
//! - El PIN es de 6 números (`check_new_pin`). El tipo va en la cabecera autenticada del sobre
//!   (`kind`: "pin6"); las bóvedas creadas antes, con un PIN o contraseña libre, no la llevan y se
//!   tratan como "text" (se abren con un campo de texto normal) hasta que se cambia el PIN.
//!   Con la llave del equipo, 6 números bastan contra la copia del archivo: sin ella no se puede
//!   probar ningún PIN, y las esperas tras fallos frenan a quien está delante del PC.
//! - Llave del equipo: 32 bytes al azar guardados en el llavero del sistema (usuario
//!   `vault-device-key`). Entra en Argon2id como su «secreto» (K), así que la llave de la bóveda
//!   sale del PIN y de ella juntos: quien se lleve solo `vault.json` no puede probar PIN fuera de
//!   este equipo. Si falta (otro PC, llavero borrado), la bóveda no se puede abrir: solo queda
//!   «Olvidé mi PIN». Desactivar la bóveda y «Olvidé mi PIN» también la borran.
//! - Estados: `Disabled` (no hay bóveda: los secretos van al llavero del sistema), `Locked`
//!   (hay bóveda pero no se escribió el PIN) y `Unlocked` (llave y secretos en memoria).
//! - Al bloquear se sueltan la llave y los secretos; `Zeroizing` los pisa con ceros.
//! - La llave se queda en memoria mientras está desbloqueada para poder guardar secretos nuevos
//!   sin volver a pedir el PIN (cada guardado usa un nonce nuevo).
//! - Fallos de PIN: 5 libres; luego hay que esperar 30 s, el doble con cada fallo, hasta 15 min.
//!   El contador y la hora del próximo intento se guardan en `vault-attempts.json` (reiniciar la
//!   app no los borra). Nunca se borra nada por fallar.
//!
//! Independiente de Tauri: `storage::lock` pone los comandos, el bloqueo por inactividad y los
//! avisos a las ventanas.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};


use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::cipher::{self, EnvError, Envelope, KdfParams};
use super::fsutil;
use crate::error::{AppError, AppResult};

pub const FILE_NAME: &str = "vault.json";
/// Fallos de PIN y hora del próximo intento permitido (en la misma carpeta).
pub const ATTEMPTS_FILE: &str = "vault-attempts.json";
/// Usuario del llavero donde va la llave de este equipo.
pub const DEVICE_KEY_USER: &str = "vault-device-key";
const DEVICE_KEY_LEN: usize = 32;
pub const FORMAT: &str = "terview-vault";
pub const VERSION: u32 = 1;
/// Números del PIN.
pub const PIN_LEN: usize = 6;
/// Largo máximo de lo que se acepta al desbloquear (las bóvedas antiguas de tipo texto).
const MAX_UNLOCK_LEN: usize = 256;

/// Memoria de Argon2id: 64 MiB (como la copia sincronizada); 128 MiB en equipos rápidos.
const BASE_M_KIB: u32 = 64 * 1024;
const MAX_M_KIB: u32 = 128 * 1024;
/// Pasadas mínimas y máximas al calibrar.
const MIN_T: u32 = 3;
const MAX_T: u32 = 20;
/// Con más pasadas que esto, mejor más memoria (frena más a quien adivina con tarjetas gráficas).
const PREFER_MORE_MEMORY_FROM_T: f64 = 10.0;
/// Tiempo buscado para derivar la llave al desbloquear.
const TARGET: Duration = Duration::from_millis(750);

/// Parámetros si no se puede medir: los de la copia sincronizada.
pub const FALLBACK_KDF: KdfParams = KdfParams {
    m_kib: BASE_M_KIB,
    t: MIN_T,
    p: 1,
};

/// Mide Argon2id en este equipo y elige memoria y pasadas para que desbloquear tarde unos
/// 0,75 s: 64 MiB (128 MiB si el equipo es rápido) y entre 3 y 20 pasadas. Los parámetros quedan
/// guardados en el archivo, así que desbloquear siempre usa los mismos.
pub fn calibrate() -> KdfParams {
    let probe = KdfParams {
        m_kib: BASE_M_KIB,
        t: 2,
        p: 1,
    };
    let start = Instant::now();
    if cipher::derive_key(b"calibrar", &[0u8; cipher::SALT_LEN], probe).is_err() {
        return FALLBACK_KDF;
    }
    // Dos pasadas para que el tiempo de reservar la memoria no pese tanto.
    let mut per_pass = start.elapsed().as_secs_f64() / 2.0;
    if per_pass <= 0.0 {
        return FALLBACK_KDF;
    }
    let target = TARGET.as_secs_f64();
    let mut m_kib = BASE_M_KIB;
    while target / per_pass > PREFER_MORE_MEMORY_FROM_T && m_kib < MAX_M_KIB {
        m_kib *= 2;
        per_pass *= 2.0;
    }
    let t = (target / per_pass).round() as u32;
    KdfParams {
        m_kib,
        t: t.clamp(MIN_T, MAX_T),
        p: 1,
    }
}

/// Tipo de PIN de la bóveda (va en la cabecera autenticada del archivo).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub enum PinKind {
    /// 6 números (todas las bóvedas nuevas y tras cambiar el PIN).
    #[default]
    #[serde(rename = "pin6")]
    Pin6,
    /// Texto libre: bóvedas creadas antes de que el PIN fuera de 6 números.
    #[serde(rename = "text")]
    Text,
}

impl PinKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PinKind::Pin6 => "pin6",
            PinKind::Text => "text",
        }
    }

    /// Lee la etiqueta del sobre. Sin etiqueta (bóveda antigua) o desconocida: texto libre, que
    /// acepta cualquier cosa al desbloquear.
    fn from_envelope(env: &Envelope) -> Self {
        match env.kind.as_deref() {
            Some("pin6") => PinKind::Pin6,
            _ => PinKind::Text,
        }
    }
}

/// Lo que ve la interfaz.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// Hay bóveda (si no, los secretos van al llavero del sistema).
    pub enabled: bool,
    /// Hay bóveda y falta el PIN.
    pub locked: bool,
    /// Segundos que faltan para poder volver a probar un PIN (0 = ya).
    pub retry_after_secs: u32,
    /// Cómo pedir el PIN al desbloquear (sin bóveda: "pin6", el de las nuevas).
    pub pin_kind: PinKind,
}

type Secrets = BTreeMap<String, Zeroizing<String>>;

/// Contenido cifrado del archivo.
#[derive(Serialize, Deserialize, Default)]
struct Contents {
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

/// Igual que `Contents` pero prestado (sin copiar los secretos al escribir).
#[derive(Serialize)]
struct ContentsRef<'a> {
    secrets: BTreeMap<&'a str, &'a str>,
}

/// Bóveda abierta: solo existe mientras está desbloqueada.
struct Open {
    key: Zeroizing<[u8; 32]>,
    params: KdfParams,
    salt_b64: String,
    kind: PinKind,
    secrets: Secrets,
}

enum State {
    Disabled,
    Locked,
    Unlocked(Open),
}

/// Dónde vive la llave de este equipo (el llavero del sistema; en tests, memoria).
pub trait DeviceKeyStore: Send + Sync {
    fn load(&self) -> AppResult<Option<Zeroizing<Vec<u8>>>>;
    fn save(&self, key: &[u8]) -> AppResult<()>;
    fn delete(&self) -> AppResult<()>;
}

/// Fallos seguidos de PIN (se guarda en disco).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Attempts {
    fails: u32,
    /// Hora (unix, s) a partir de la cual se puede volver a probar.
    not_before: u64,
}

/// Fallos permitidos sin esperar.
const FREE_FAILS: u32 = 5;
const FIRST_DELAY_SECS: u64 = 30;
const MAX_DELAY_SECS: u64 = 15 * 60;

/// Espera tras `fails` fallos seguidos: 5 libres; luego 30 s, 1 min, 2 min… hasta 15 min.
pub fn delay_after(fails: u32) -> Duration {
    if fails <= FREE_FAILS {
        return Duration::ZERO;
    }
    let exp = (fails - FREE_FAILS - 1).min(10);
    Duration::from_secs((FIRST_DELAY_SECS << exp).min(MAX_DELAY_SECS))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn missing_device_key() -> AppError {
    AppError::Invalid(
        "falta la llave de este equipo en el llavero del sistema (¿la bóveda viene de otro PC o se \
         borró el llavero?). Sin ella no se puede abrir: usa «Olvidé mi PIN» para empezar de cero"
            .into(),
    )
}

pub struct Vault {
    /// None si el sistema no tiene carpeta de configuración (bóveda imposible).
    path: Option<PathBuf>,
    attempts_path: Option<PathBuf>,
    device: Box<dyn DeviceKeyStore>,
    state: Mutex<State>,
    /// Tipo de PIN del archivo (se sabe sin desbloquear: va en la cabecera).
    pin_kind: Mutex<PinKind>,
    attempts: Mutex<Attempts>,
    /// Una operación larga a la vez (crear, desbloquear, cambiar PIN, desactivar, olvidar).
    ops: Mutex<()>,
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn env_error(e: EnvError) -> AppError {
    match e {
        EnvError::WrongFormat | EnvError::Damaged => AppError::Invalid(
            "el archivo de la bóveda (vault.json) está dañado. Si no tienes copia, usa «Olvidé mi PIN»"
                .into(),
        ),
        EnvError::Unsupported => AppError::Invalid(
            "la bóveda se creó con una versión de TerView más nueva; actualiza la app".into(),
        ),
        EnvError::OutOfRange => {
            AppError::Invalid("la bóveda tiene parámetros de cifrado fuera de rango".into())
        }
        EnvError::BadKey => AppError::AuthFailed("el PIN no es correcto".into()),
    }
}

/// Comprueba un PIN nuevo: exactamente 6 números (0-9).
pub fn check_new_pin(pin: &str) -> AppResult<()> {
    if pin.len() == PIN_LEN && pin.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("El PIN debe tener {PIN_LEN} números")))
    }
}

fn read_envelope(path: &Path) -> AppResult<Envelope> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::NotFound(
                "la bóveda (vault.json): se borró mientras TerView estaba abierto".into(),
            ));
        }
        Err(e) => return Err(AppError::Io(format!("no se pudo leer {}: {e}", path.display()))),
    };
    serde_json::from_slice(&bytes).map_err(|_| env_error(EnvError::Damaged))
}

/// Cifra y escribe los secretos (atómico, 0600).
fn write_file(path: &Path, open: &Open, secrets: &Secrets) -> AppResult<()> {
    let plain: BTreeMap<&str, &str> = secrets.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    // Se reserva de antemano para que el texto en claro no deje copias al crecer.
    let cap = 32 + secrets.iter().map(|(k, v)| k.len() + 2 * v.len() + 8).sum::<usize>();
    let mut json = Zeroizing::new(Vec::with_capacity(cap));
    serde_json::to_writer(&mut *json, &ContentsRef { secrets: plain })?;
    let env = cipher::seal_with_kind(
        FORMAT,
        VERSION,
        &open.key,
        open.params,
        &open.salt_b64,
        Some(open.kind.as_str()),
        &json,
    )?;
    fsutil::write_json_atomic(path, &env)
}

/// Descifra el archivo con una llave ya derivada.
fn open_with_key(env: &Envelope, key: &[u8; 32]) -> AppResult<Secrets> {
    let plain = cipher::open(env, FORMAT, VERSION, key).map_err(env_error)?;
    let c: Contents = serde_json::from_slice(&plain).map_err(|_| env_error(EnvError::Damaged))?;
    Ok(c.secrets.into_iter().map(|(k, v)| (k, Zeroizing::new(v))).collect())
}

/// Lee el archivo, deriva la llave desde el PIN y la llave del equipo, y descifra.
fn open_with_pin(path: &Path, pin: &str, device: &dyn DeviceKeyStore) -> AppResult<Open> {
    if pin.is_empty() || pin.len() > MAX_UNLOCK_LEN {
        return Err(AppError::AuthFailed("el PIN no es correcto".into()));
    }
    let env = read_envelope(path)?;
    let (params, salt) = cipher::check(&env, FORMAT, VERSION).map_err(env_error)?;
    let dk = load_device_key(device)?;
    let key = cipher::derive_key_keyed(pin.as_bytes(), &salt, params, &dk)?;
    let secrets = open_with_key(&env, &key)?;
    Ok(Open {
        key,
        params,
        kind: PinKind::from_envelope(&env),
        salt_b64: env.kdf.salt,
        secrets,
    })
}

fn load_device_key(device: &dyn DeviceKeyStore) -> AppResult<Zeroizing<Vec<u8>>> {
    match device.load()? {
        Some(k) if k.len() == DEVICE_KEY_LEN => Ok(k),
        Some(_) => Err(AppError::Invalid(
            "la llave de este equipo en el llavero está dañada: usa «Olvidé mi PIN» para empezar de cero"
                .into(),
        )),
        None => Err(missing_device_key()),
    }
}

/// Escribe y comprueba que lo escrito se vuelve a abrir con la misma llave y da lo mismo.
fn write_verified(path: &Path, open: &Open) -> AppResult<()> {
    write_file(path, open, &open.secrets)?;
    let back = open_with_key(&read_envelope(path)?, &open.key)?;
    if back != open.secrets {
        return Err(AppError::Io(
            "la bóveda escrita no coincide al volver a leerla".into(),
        ));
    }
    Ok(())
}

impl Vault {
    /// Bóveda en esa ruta: bloqueada si el archivo existe, desactivada si no. Los fallos de PIN
    /// se leen de `vault-attempts.json` en la misma carpeta.
    pub fn new(path: Option<PathBuf>, device: Box<dyn DeviceKeyStore>) -> Self {
        let state = match &path {
            Some(p) if p.exists() => State::Locked,
            _ => State::Disabled,
        };
        // El tipo de PIN se lee de la cabecera; si el archivo está dañado, texto libre (al
        // desbloquear se verá el error).
        let pin_kind = match (&state, &path) {
            (State::Locked, Some(p)) => read_envelope(p).map_or(PinKind::Text, |e| PinKind::from_envelope(&e)),
            _ => PinKind::Pin6,
        };
        let attempts_path = path.as_ref().map(|p| p.with_file_name(ATTEMPTS_FILE));
        let attempts = attempts_path
            .as_deref()
            .filter(|p| p.exists())
            .map(fsutil::read_json_or_default::<Attempts>)
            .unwrap_or_default();
        Vault {
            path,
            attempts_path,
            device,
            state: Mutex::new(state),
            pin_kind: Mutex::new(pin_kind),
            attempts: Mutex::new(attempts),
            ops: Mutex::new(()),
        }
    }

    /// La bóveda de la app (`~/.config/terview/vault.json`, llave del equipo en el llavero).
    pub fn global() -> &'static Vault {
        static G: OnceLock<Vault> = OnceLock::new();
        G.get_or_init(|| {
            Vault::new(
                fsutil::config_dir().map(|d| d.join(FILE_NAME)),
                Box::new(super::secrets::KeyringDeviceKey(super::secrets::SERVICE)),
            )
        })
    }

    fn path(&self) -> AppResult<&Path> {
        self.path
            .as_deref()
            .ok_or_else(|| AppError::Io("no se encontró la carpeta de configuración del usuario".into()))
    }

    pub fn status(&self) -> VaultStatus {
        let (enabled, locked) = match &*guard(&self.state) {
            State::Disabled => (false, false),
            State::Locked => (true, true),
            State::Unlocked(_) => (true, false),
        };
        VaultStatus {
            enabled,
            locked,
            retry_after_secs: self.retry_after().map_or(0, |d| d.as_secs_f64().ceil() as u32),
            pin_kind: if enabled { *guard(&self.pin_kind) } else { PinKind::Pin6 },
        }
    }

    pub fn is_enabled(&self) -> bool {
        !matches!(*guard(&self.state), State::Disabled)
    }

    // ───────── Secretos (None = bóveda desactivada: usar el llavero) ─────────

    pub fn get(&self, id: &str) -> Option<AppResult<Option<String>>> {
        match &*guard(&self.state) {
            State::Disabled => None,
            State::Locked => Some(Err(AppError::Locked)),
            State::Unlocked(o) => Some(Ok(o.secrets.get(id).map(|s| s.to_string()))),
        }
    }

    pub fn set(&self, id: &str, secret: &str) -> Option<AppResult<()>> {
        self.modify(|m| {
            m.insert(id.to_string(), Zeroizing::new(secret.to_string()));
        })
    }

    pub fn delete(&self, id: &str) -> Option<AppResult<()>> {
        self.modify(|m| {
            m.remove(id);
        })
    }

    /// Cambia una copia de los secretos, la escribe y solo entonces la publica.
    fn modify(&self, f: impl FnOnce(&mut Secrets)) -> Option<AppResult<()>> {
        let mut st = guard(&self.state);
        let open = match &mut *st {
            State::Disabled => return None,
            State::Locked => return Some(Err(AppError::Locked)),
            State::Unlocked(o) => o,
        };
        let mut next = open.secrets.clone();
        f(&mut next);
        if next == open.secrets {
            return Some(Ok(()));
        }
        let r = self.path().and_then(|p| write_file(p, open, &next));
        if r.is_ok() {
            open.secrets = next;
        }
        Some(r)
    }

    /// Ids con secreto (solo desbloqueada).
    #[cfg(test)]
    pub fn ids(&self) -> AppResult<Vec<String>> {
        match &*guard(&self.state) {
            State::Disabled => Ok(Vec::new()),
            State::Locked => Err(AppError::Locked),
            State::Unlocked(o) => Ok(o.secrets.keys().cloned().collect()),
        }
    }

    // ───────── Bloqueo ─────────

    /// Bloquea: suelta (y pisa con ceros) la llave y los secretos. Devuelve si cambió algo.
    pub fn lock(&self) -> bool {
        let mut st = guard(&self.state);
        if matches!(*st, State::Unlocked(_)) {
            *st = State::Locked;
            true
        } else {
            false
        }
    }

    pub fn is_unlocked(&self) -> bool {
        matches!(*guard(&self.state), State::Unlocked(_))
    }

    fn retry_after(&self) -> Option<Duration> {
        let a = *guard(&self.attempts);
        let left = a.not_before.saturating_sub(unix_now());
        // Si el reloj fue hacia atrás, nunca más de la espera máxima.
        (left > 0).then(|| Duration::from_secs(left.min(MAX_DELAY_SECS)))
    }

    fn check_throttle(&self) -> AppResult<()> {
        if let Some(d) = self.retry_after() {
            let s = d.as_secs();
            let wait = if s >= 60 {
                format!("{} min {} s", s / 60, s % 60)
            } else {
                format!("{s} s")
            };
            return Err(AppError::Invalid(format!(
                "Demasiados intentos fallidos: espera {wait} antes de volver a probar"
            )));
        }
        Ok(())
    }

    /// Guarda el contador en disco (si falla, se registra y sigue valiendo en memoria).
    fn save_attempts(&self, a: Attempts) {
        let Some(p) = &self.attempts_path else { return };
        let r = if a == Attempts::default() {
            match fs::remove_file(p) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(AppError::from(e)),
                _ => Ok(()),
            }
        } else {
            fsutil::write_json_atomic(p, &a)
        };
        if let Err(e) = r {
            log::warn!("bóveda: no se pudo guardar el contador de intentos: {e}");
        }
    }

    /// Registra el resultado de probar un PIN.
    fn note_attempt<T>(&self, r: &AppResult<T>) {
        let mut a = guard(&self.attempts);
        match r {
            Ok(_) => *a = Attempts::default(),
            Err(AppError::AuthFailed(_)) => {
                a.fails = a.fails.saturating_add(1);
                let d = delay_after(a.fails);
                a.not_before = if d.is_zero() { 0 } else { unix_now() + d.as_secs() };
                log::warn!("bóveda: PIN incorrecto ({} fallos seguidos)", a.fails);
            }
            Err(_) => return,
        }
        self.save_attempts(*a);
    }

    /// Abre el archivo con el PIN (con la espera tras fallos).
    fn verify_pin(&self, pin: &str) -> AppResult<Open> {
        self.check_throttle()?;
        let r = open_with_pin(self.path()?, pin, &*self.device);
        self.note_attempt(&r);
        r
    }

    /// Desbloquea con el PIN. Si ya estaba desbloqueada no hace nada.
    pub fn unlock(&self, pin: &str) -> AppResult<()> {
        let _op = guard(&self.ops);
        match *guard(&self.state) {
            State::Disabled => return Err(AppError::Invalid("no hay ninguna bóveda creada".into())),
            State::Unlocked(_) => return Ok(()),
            State::Locked => {}
        }
        let open = self.verify_pin(pin)?;
        let mut st = guard(&self.state);
        if matches!(*st, State::Locked) {
            *st = State::Unlocked(open);
        }
        Ok(())
    }

    /// Comprueba el PIN sin cambiar nada (p. ej. antes de mostrar una contraseña guardada).
    /// Cuenta como intento: los fallos tienen la misma espera que al desbloquear.
    pub fn check_pin(&self, pin: &str) -> AppResult<()> {
        let _op = guard(&self.ops);
        if !self.is_enabled() {
            return Err(AppError::Invalid("no hay ninguna bóveda creada".into()));
        }
        self.verify_pin(pin).map(|_| ())
    }

    // ───────── Crear, cambiar PIN, desactivar, olvidar ─────────

    /// Crea la bóveda con esos secretos y la deja desbloqueada. Escribe el archivo y comprueba que
    /// se vuelve a abrir antes de dar nada por hecho; si algo falla, no queda archivo.
    pub fn create(&self, pin: &str, secrets: BTreeMap<String, String>, params: KdfParams) -> AppResult<()> {
        check_new_pin(pin)?;
        let _op = guard(&self.ops);
        let path = self.path()?.to_path_buf();
        if !matches!(*guard(&self.state), State::Disabled) || path.exists() {
            return Err(AppError::Invalid("ya hay una bóveda creada".into()));
        }
        // Llave nueva de este equipo, al llavero antes que nada (si no hay llavero, no se crea nada).
        let dk = Zeroizing::new(cipher::random::<DEVICE_KEY_LEN>()?);
        self.device.save(&dk[..]).map_err(|e| {
            let why = match e {
                AppError::Keyring(m) => m,
                other => other.to_string(),
            };
            AppError::Keyring(format!(
                "el PIN necesita el llavero del sistema para guardar la llave de este equipo: {why}"
            ))
        })?;
        let built = (|| {
            let salt_b64 = cipher::new_salt_b64()?;
            let key = cipher::derive_key_keyed_b64(pin.as_bytes(), &salt_b64, params, &dk[..])?;
            let open = Open {
                key,
                params,
                salt_b64,
                kind: PinKind::Pin6,
                secrets: secrets.into_iter().map(|(k, v)| (k, Zeroizing::new(v))).collect(),
            };
            write_verified(&path, &open)?;
            Ok(open)
        })();
        let open = match built {
            Ok(o) => o,
            Err(e) => {
                let _ = fs::remove_file(&path);
                let _ = self.device.delete();
                return Err(e);
            }
        };
        *guard(&self.pin_kind) = PinKind::Pin6;
        *guard(&self.state) = State::Unlocked(open);
        Ok(())
    }

    /// Cambia el PIN: vuelve a cifrar con sal y llave nuevas. Pide el PIN actual (de cualquier
    /// tipo); el nuevo es siempre de 6 números.
    pub fn change_pin(&self, old: &str, new: &str, params: KdfParams) -> AppResult<()> {
        check_new_pin(new)?;
        let _op = guard(&self.ops);
        if !self.is_enabled() {
            return Err(AppError::Invalid("no hay ninguna bóveda creada".into()));
        }
        let path = self.path()?.to_path_buf();
        let from_file = self.verify_pin(old)?;
        let dk = load_device_key(&*self.device)?;
        let salt_b64 = cipher::new_salt_b64()?;
        let key = cipher::derive_key_keyed_b64(new.as_bytes(), &salt_b64, params, &dk)?;
        // Con el estado tomado: así no se pierde un secreto guardado mientras tanto.
        let mut st = guard(&self.state);
        let secrets = match &*st {
            State::Unlocked(o) => o.secrets.clone(),
            _ => from_file.secrets,
        };
        let open = Open {
            key,
            params,
            salt_b64,
            kind: PinKind::Pin6,
            secrets,
        };
        write_verified(&path, &open)?;
        *guard(&self.pin_kind) = PinKind::Pin6;
        // Si se bloqueó mientras tanto, sigue bloqueada (el archivo ya tiene el PIN nuevo).
        if matches!(*st, State::Unlocked(_)) {
            *st = State::Unlocked(open);
        }
        Ok(())
    }

    /// Comprueba el PIN y devuelve todos los secretos (para devolverlos al llavero).
    pub fn export_with_pin(&self, pin: &str) -> AppResult<BTreeMap<String, Zeroizing<String>>> {
        let _op = guard(&self.ops);
        if !self.is_enabled() {
            return Err(AppError::Invalid("no hay ninguna bóveda creada".into()));
        }
        let from_file = self.verify_pin(pin)?;
        Ok(match &*guard(&self.state) {
            State::Unlocked(o) => o.secrets.clone(),
            _ => from_file.secrets,
        })
    }

    /// Borra el archivo y la llave del equipo, y vuelve al llavero del sistema. Se usa al
    /// desactivar (tras copiar los secretos al llavero) y en «Olvidé mi PIN» (se pierden).
    pub fn remove(&self) -> AppResult<()> {
        let _op = guard(&self.ops);
        let path = self.path()?;
        match fs::remove_file(path) {
            Ok(()) => fsutil::sync_dir(path.parent().unwrap_or(Path::new("."))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Io(format!("no se pudo borrar {}: {e}", path.display()))),
        }
        *guard(&self.state) = State::Disabled;
        *guard(&self.pin_kind) = PinKind::Pin6;
        // Sin bóveda la llave del equipo no sirve para nada (si el llavero no responde, se queda).
        if let Err(e) = self.device.delete() {
            log::warn!("bóveda: no se pudo borrar la llave del equipo del llavero: {e}");
        }
        *guard(&self.attempts) = Attempts::default();
        self.save_attempts(Attempts::default());
        Ok(())
    }
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
