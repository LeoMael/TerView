//! Tests de la bóveda de contraseñas y de mover secretos entre ella y el llavero.
//! Los que usan el llavero real (servicio "sshorus-test") van con `#[ignore]`:
//! `cargo test --lib storage::vault -- --ignored --test-threads=1`

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use super::*;
use crate::storage::secrets::{self, Keyring, MoveReport, SystemKeyring};

/// Parámetros ligeros para que los tests no tarden.
const FAST: KdfParams = KdfParams {
    m_kib: 256,
    t: 1,
    p: 1,
};
const PIN: &str = "123456";

/// Llave del equipo en memoria (compartida entre las instancias de un mismo «equipo»).
#[derive(Clone, Default)]
struct FakeDevice(Arc<Mutex<Option<Vec<u8>>>>);

impl FakeDevice {
    fn key(&self) -> Option<Vec<u8>> {
        self.0.lock().unwrap().clone()
    }
    fn put(&self, k: Option<Vec<u8>>) {
        *self.0.lock().unwrap() = k;
    }
}

impl DeviceKeyStore for FakeDevice {
    fn load(&self) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
        Ok(self.key().map(Zeroizing::new))
    }
    fn save(&self, key: &[u8]) -> AppResult<()> {
        self.put(Some(key.to_vec()));
        Ok(())
    }
    fn delete(&self) -> AppResult<()> {
        self.put(None);
        Ok(())
    }
}

/// Carpeta temporal propia (se borra al final) y la llave de «este equipo».
struct TempDir(PathBuf, FakeDevice);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("sshorus-vault-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p, FakeDevice::default())
    }
    fn vault_path(&self) -> PathBuf {
        self.0.join(FILE_NAME)
    }
    fn vault(&self) -> Vault {
        Vault::new(Some(self.vault_path()), Box::new(self.1.clone()))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn get(v: &Vault, id: &str) -> AppResult<Option<String>> {
    v.get(id).expect("la bóveda debería estar activa")
}

/// Estado sin esperas y con PIN de 6 números.
fn status(enabled: bool, locked: bool) -> VaultStatus {
    VaultStatus { enabled, locked, retry_after_secs: 0, pin_kind: PinKind::Pin6 }
}

// ───────── Ida y vuelta, PIN, bloqueo ─────────

#[test]
fn roundtrip_and_reopen() {
    let dir = TempDir::new();
    let v = dir.vault();
    assert_eq!(v.status(), status(false, false));
    assert!(v.get("a").is_none(), "sin bóveda se usa el llavero");

    v.create(PIN, map(&[("srv-1", "clave ñ 1"), ("github-token", "ghp_x")]), FAST).unwrap();
    assert!(v.status().enabled && !v.status().locked);
    assert_eq!(get(&v, "srv-1").unwrap().as_deref(), Some("clave ñ 1"));
    assert_eq!(get(&v, "nada").unwrap(), None);

    // Guardar y borrar escriben el archivo al momento.
    v.set("srv-2", "otra").unwrap().unwrap();
    v.delete("github-token").unwrap().unwrap();

    // En claro no aparece nada del contenido.
    let raw = fs::read_to_string(dir.vault_path()).unwrap();
    for s in ["clave", "srv-1", "srv-2", "otra"] {
        assert!(!raw.contains(s), "«{s}» no debe verse en el archivo");
    }

    // Otra instancia (como al reiniciar la app): empieza bloqueada.
    let v2 = dir.vault();
    assert_eq!(v2.status(), status(true, true));
    v2.unlock(PIN).unwrap();
    assert_eq!(v2.ids().unwrap(), vec!["srv-1".to_string(), "srv-2".to_string()]);
    assert_eq!(get(&v2, "srv-2").unwrap().as_deref(), Some("otra"));
    assert_eq!(get(&v2, "github-token").unwrap(), None);
}

#[test]
fn wrong_pin_fails() {
    let dir = TempDir::new();
    dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
    let v = dir.vault();
    let err = v.unlock("654321").unwrap_err();
    assert!(matches!(err, AppError::AuthFailed(_)), "{err:?}");
    assert!(v.status().locked);
    assert!(matches!(get(&v, "a"), Err(AppError::Locked)));
    v.unlock(PIN).unwrap();
    assert_eq!(get(&v, "a").unwrap().as_deref(), Some("1"));
}

#[test]
fn locked_vault_refuses_everything() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("a", "1")]), FAST).unwrap();
    assert!(v.lock());
    assert!(!v.lock(), "bloquear dos veces no cambia nada");
    assert!(matches!(get(&v, "a"), Err(AppError::Locked)));
    assert!(matches!(v.set("a", "2"), Some(Err(AppError::Locked))));
    assert!(matches!(v.delete("a"), Some(Err(AppError::Locked))));
    assert!(matches!(v.ids(), Err(AppError::Locked)));
    // El archivo no cambió: sigue dando el valor de antes.
    v.unlock(PIN).unwrap();
    assert_eq!(get(&v, "a").unwrap().as_deref(), Some("1"));
}

#[test]
fn change_pin_reencrypts() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("a", "1")]), FAST).unwrap();
    let before = fs::read_to_string(dir.vault_path()).unwrap();

    assert!(matches!(v.change_pin("000000", "654321", FAST), Err(AppError::AuthFailed(_))));
    assert!(matches!(v.change_pin(PIN, "12345", FAST), Err(AppError::Invalid(_))));
    assert!(matches!(v.change_pin(PIN, "una frase larga", FAST), Err(AppError::Invalid(_))));
    v.change_pin(PIN, "654321", FAST).unwrap();
    assert!(!v.status().locked, "sigue desbloqueada");
    assert_eq!(get(&v, "a").unwrap().as_deref(), Some("1"));

    let after: Envelope = serde_json::from_str(&fs::read_to_string(dir.vault_path()).unwrap()).unwrap();
    let old: Envelope = serde_json::from_str(&before).unwrap();
    assert_ne!(after.kdf.salt, old.kdf.salt, "sal nueva");

    let v2 = dir.vault();
    assert!(matches!(v2.unlock(PIN), Err(AppError::AuthFailed(_))));
    v2.unlock("654321").unwrap();
    assert_eq!(get(&v2, "a").unwrap().as_deref(), Some("1"));
}

#[test]
fn pin_rules() {
    // Válidos: exactamente 6 números.
    for ok in ["123456", "000000", "987654"] {
        assert!(check_new_pin(ok).is_ok(), "{ok}");
    }
    // Inválidos: más corto, más largo, letras, espacios, signos o números no ASCII.
    for bad in ["", "12345", "1234567", "12345a", "12 456", " 123456", "123456 ", "+12345", "١٢٣٤٥٦", "      ", "una frase larga"] {
        assert!(matches!(check_new_pin(bad), Err(AppError::Invalid(_))), "«{bad}»");
    }
    let dir = TempDir::new();
    assert!(matches!(dir.vault().create("123", BTreeMap::new(), FAST), Err(AppError::Invalid(_))));
    assert!(matches!(dir.vault().create("abcdef", BTreeMap::new(), FAST), Err(AppError::Invalid(_))));
    assert!(!dir.vault_path().exists());
    assert!(dir.1.key().is_none(), "ni siquiera se crea la llave del equipo");
    // El enlace con el llavero también lo comprueba.
    let kr = FakeKeyring::default();
    assert!(matches!(secrets::enable_vault(&dir.vault(), &kr, &[], "frase", FAST), Err(AppError::Invalid(_))));
}

#[test]
fn new_vault_is_pin6_in_authenticated_header() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("a", "1")]), FAST).unwrap();
    assert_eq!(v.status().pin_kind, PinKind::Pin6);
    let env: Envelope = serde_json::from_str(&fs::read_to_string(dir.vault_path()).unwrap()).unwrap();
    assert_eq!(env.kind.as_deref(), Some("pin6"));
    let v2 = dir.vault();
    assert_eq!(v2.status(), VaultStatus { pin_kind: PinKind::Pin6, ..status(true, true) });

    // Cambiar o quitar la etiqueta rompe la cabecera autenticada: no abre ni con el PIN.
    for edit in [
        (|j: &mut serde_json::Value| j["kind"] = "text".into()) as fn(&mut serde_json::Value),
        |j| {
            j.as_object_mut().unwrap().remove("kind");
        },
        |j| j["kind"] = "pin6/x".into(),
    ] {
        let dir = TempDir::new();
        dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
        tamper(&dir, edit);
        let v = dir.vault();
        let r = v.unlock(PIN);
        assert!(matches!(r, Err(AppError::AuthFailed(_)) | Err(AppError::Invalid(_))), "{r:?}");
        assert!(v.status().locked);
    }
}

// ───────── Bóvedas antiguas (PIN o contraseña de texto, sin etiqueta) ─────────

/// Escribe una bóveda como las de antes: sin `kind` y con un secreto de texto libre.
fn write_legacy(dir: &TempDir, pin: &str, secrets: &[(&str, &str)]) {
    let dk = cipher::random::<32>().unwrap();
    dir.1.put(Some(dk.to_vec()));
    let salt = cipher::new_salt_b64().unwrap();
    let key = cipher::derive_key_keyed_b64(pin.as_bytes(), &salt, FAST, &dk).unwrap();
    let json = serde_json::to_vec(&serde_json::json!({ "secrets": map(secrets) })).unwrap();
    let env = cipher::seal(FORMAT, VERSION, &key, FAST, &salt, &json).unwrap();
    assert!(env.kind.is_none());
    fs::write(dir.vault_path(), serde_json::to_vec(&env).unwrap()).unwrap();
}

#[test]
fn legacy_text_vault_still_opens() {
    let dir = TempDir::new();
    let old = "mi contraseña maestra";
    write_legacy(&dir, old, &[("srv-1", "p1")]);

    let v = dir.vault();
    let st = v.status();
    assert!(st.enabled && st.locked);
    assert_eq!(st.pin_kind, PinKind::Text, "se pide con un campo de texto");
    assert!(matches!(v.unlock("123456"), Err(AppError::AuthFailed(_))));
    v.unlock(old).unwrap();
    assert_eq!(get(&v, "srv-1").unwrap().as_deref(), Some("p1"));

    // Guardar algo la mantiene de tipo texto (y se sigue abriendo con lo mismo).
    v.set("srv-2", "p2").unwrap().unwrap();
    let env: Envelope = serde_json::from_str(&fs::read_to_string(dir.vault_path()).unwrap()).unwrap();
    assert_eq!(env.kind.as_deref(), Some("text"));
    let v2 = dir.vault();
    assert_eq!(v2.status().pin_kind, PinKind::Text);
    v2.unlock(old).unwrap();
    assert_eq!(get(&v2, "srv-2").unwrap().as_deref(), Some("p2"));

    // Al cambiar el PIN, el nuevo es de 6 números (texto no vale) y la bóveda pasa a "pin6".
    assert!(matches!(v2.change_pin(old, "otra frase", FAST), Err(AppError::Invalid(_))));
    v2.change_pin(old, "246810", FAST).unwrap();
    assert_eq!(v2.status().pin_kind, PinKind::Pin6);
    let v3 = dir.vault();
    assert_eq!(v3.status().pin_kind, PinKind::Pin6);
    assert!(matches!(v3.unlock(old), Err(AppError::AuthFailed(_))));
    v3.unlock("246810").unwrap();
    assert_eq!(get(&v3, "srv-1").unwrap().as_deref(), Some("p1"));
}

#[test]
fn legacy_text_vault_can_be_disabled_with_its_text() {
    let dir = TempDir::new();
    write_legacy(&dir, "frase vieja", &[("s1", "p1"), ("s1:sudo", "ps")]);
    let v = dir.vault();
    let kr = FakeKeyring::default();
    secrets::disable_vault(&v, &kr, "frase vieja").unwrap();
    assert_eq!(*kr.data.borrow(), map(&[("s1", "p1"), ("s1:sudo", "ps")]));
    assert_eq!(v.status(), status(false, false));
}

#[test]
fn check_pin_counts_as_attempt() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("a", "1")]), FAST).unwrap();
    v.check_pin(PIN).unwrap();
    assert!(!v.status().locked, "comprobar no bloquea ni desbloquea");
    for _ in 0..5 {
        assert!(matches!(v.check_pin("999999"), Err(AppError::AuthFailed(_))));
    }
    assert!(matches!(v.check_pin("999999"), Err(AppError::AuthFailed(_))));
    assert!(v.status().retry_after_secs > 0, "misma espera que al desbloquear");
    assert!(matches!(v.check_pin(PIN), Err(AppError::Invalid(_))));
    // Sin bóveda no hay PIN que comprobar.
    let other = TempDir::new();
    assert!(matches!(other.vault().check_pin(PIN), Err(AppError::Invalid(_))));
}

#[test]
fn create_twice_fails() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, BTreeMap::new(), FAST).unwrap();
    assert!(v.create(PIN, BTreeMap::new(), FAST).is_err());
    // Un archivo que ya existe tampoco se pisa.
    assert!(dir.vault().create(PIN, BTreeMap::new(), FAST).is_err());
}

// ───────── Archivo dañado o manipulado ─────────

fn tamper(dir: &TempDir, f: impl FnOnce(&mut serde_json::Value)) {
    let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.vault_path()).unwrap()).unwrap();
    f(&mut v);
    fs::write(dir.vault_path(), serde_json::to_vec(&v).unwrap()).unwrap();
}

#[test]
fn damaged_file_fails_cleanly() {
    let dir = TempDir::new();
    dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();

    fs::write(dir.vault_path(), b"{ esto no es json").unwrap();
    let v = dir.vault();
    assert!(matches!(v.unlock(PIN), Err(AppError::Invalid(_))));
    assert!(v.status().locked);
    // Nunca se borra ni se aparta el archivo por estar dañado.
    assert_eq!(fs::read(dir.vault_path()).unwrap(), b"{ esto no es json");
}

#[test]
fn tampered_header_or_data_fails() {
    type Edit = fn(&mut serde_json::Value);
    let cases: &[(&str, Edit)] = &[
        ("pasadas", |v| v["kdf"]["t"] = 2.into()),
        ("memoria", |v| v["kdf"]["mKib"] = 512.into()),
        ("sal", |v| v["kdf"]["salt"] = "AAAAAAAAAAAAAAAAAAAAAA==".into()),
        ("formato", |v| v["format"] = "sshorus-sync".into()),
        ("versión", |v| v["version"] = 2.into()),
        ("memoria enorme", |v| v["kdf"]["mKib"] = (10u64 * 1024 * 1024).into()),
        ("nonce", |v| v["nonce"] = "AAAA".into()),
        ("datos", |v| {
            let d = v["data"].as_str().unwrap().to_string();
            let mut b = d.into_bytes();
            b[4] = if b[4] == b'A' { b'B' } else { b'A' };
            v["data"] = String::from_utf8(b).unwrap().into();
        }),
    ];
    for (name, edit) in cases {
        let dir = TempDir::new();
        dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
        tamper(&dir, *edit);
        let v = dir.vault();
        let r = v.unlock(PIN);
        assert!(
            matches!(r, Err(AppError::Invalid(_)) | Err(AppError::AuthFailed(_))),
            "{name}: {r:?}"
        );
        assert!(v.status().locked, "{name}");
        assert!(dir.vault_path().exists(), "{name}: el archivo no se toca");
    }
}

// ───────── Espera tras fallos ─────────

#[test]
fn growing_delay_after_failures() {
    assert_eq!(delay_after(0), Duration::ZERO);
    assert_eq!(delay_after(5), Duration::ZERO, "5 fallos libres");
    assert_eq!(delay_after(6), Duration::from_secs(30));
    assert_eq!(delay_after(7), Duration::from_secs(60));
    assert_eq!(delay_after(9), Duration::from_secs(240));
    assert_eq!(delay_after(10), Duration::from_secs(480));
    assert_eq!(delay_after(11), Duration::from_secs(900), "máximo 15 min");
    assert_eq!(delay_after(500), Duration::from_secs(900));

    let dir = TempDir::new();
    dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
    let v = dir.vault();
    for _ in 0..5 {
        assert!(matches!(v.unlock("999999"), Err(AppError::AuthFailed(_))));
        assert_eq!(v.status().retry_after_secs, 0);
    }
    assert!(matches!(v.unlock("999999"), Err(AppError::AuthFailed(_))));
    let wait = v.status().retry_after_secs;
    assert!((29..=30).contains(&wait), "{wait}");
    // Mientras tanto ni el PIN correcto se prueba (y no se borra nada).
    assert!(matches!(v.unlock(PIN), Err(AppError::Invalid(_))));
    assert!(dir.vault_path().exists());

    // Reiniciar la app no borra la espera: está en disco.
    assert!(dir.0.join(ATTEMPTS_FILE).exists());
    let v2 = dir.vault();
    assert!(v2.status().retry_after_secs >= 29);
    assert!(matches!(v2.unlock(PIN), Err(AppError::Invalid(_))));

    // «Olvidé mi PIN» quita la espera y el archivo de intentos.
    v2.remove().unwrap();
    assert_eq!(v2.status().retry_after_secs, 0);
    assert!(!dir.0.join(ATTEMPTS_FILE).exists());
}

#[test]
fn success_resets_failures() {
    let dir = TempDir::new();
    dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
    let v = dir.vault();
    for _ in 0..4 {
        let _ = v.unlock("999999");
    }
    v.unlock(PIN).unwrap();
    assert!(!dir.0.join(ATTEMPTS_FILE).exists());
    v.lock();
    // Vuelve a tener 5 fallos libres.
    for _ in 0..5 {
        let _ = v.unlock("999999");
    }
    assert_eq!(v.status().retry_after_secs, 0);
}

// ───────── Llave del equipo ─────────

#[test]
fn device_key_is_created_and_required() {
    let dir = TempDir::new();
    dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
    let key = dir.1.key().expect("se guarda una llave del equipo");
    assert_eq!(key.len(), 32);

    // Sin la llave del equipo (otro PC, llavero borrado): no abre ni con el PIN correcto,
    // y no cuenta como fallo de PIN.
    dir.1.put(None);
    let v = dir.vault();
    let err = v.unlock(PIN).unwrap_err();
    assert!(matches!(&err, AppError::Invalid(m) if m.contains("llave de este equipo")), "{err:?}");
    assert!(!dir.0.join(ATTEMPTS_FILE).exists());

    // PIN correcto con OTRA llave del equipo: tampoco.
    dir.1.put(Some(vec![7u8; 32]));
    assert!(matches!(v.unlock(PIN), Err(AppError::AuthFailed(_))));

    // Con la suya, sí.
    dir.1.put(Some(key));
    v.unlock(PIN).unwrap();
    assert_eq!(get(&v, "a").unwrap().as_deref(), Some("1"));
}

#[test]
fn copied_file_is_useless_on_another_device() {
    let dir = TempDir::new();
    dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
    // «Otro PC»: mismo archivo, llavero distinto (con su propia bóveda creada antes).
    let other = TempDir::new();
    other.vault().create("135790", BTreeMap::new(), FAST).unwrap();
    fs::copy(dir.vault_path(), other.vault_path()).unwrap();
    assert!(matches!(other.vault().unlock(PIN), Err(AppError::AuthFailed(_))));
}

#[test]
fn reset_and_disable_delete_device_key() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, BTreeMap::new(), FAST).unwrap();
    assert!(dir.1.key().is_some());
    v.remove().unwrap();
    assert!(dir.1.key().is_none(), "«Olvidé mi PIN» la borra");

    v.create(PIN, map(&[("s1", "p1")]), FAST).unwrap();
    let kr = FakeKeyring::default();
    secrets::disable_vault(&v, &kr, PIN).unwrap();
    assert!(dir.1.key().is_none(), "desactivar la borra");
}

#[test]
fn change_pin_keeps_device_binding() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("a", "1")]), FAST).unwrap();
    v.change_pin(PIN, "654321", FAST).unwrap();
    dir.1.put(Some(vec![1u8; 32]));
    assert!(matches!(dir.vault().unlock("654321"), Err(AppError::AuthFailed(_))));
}

// ───────── «Olvidé mi PIN» ─────────

#[test]
fn reset_removes_vault_and_falls_back_to_keyring() {
    let dir = TempDir::new();
    dir.vault().create(PIN, map(&[("a", "1")]), FAST).unwrap();
    let v = dir.vault();
    assert!(v.status().locked);
    v.remove().unwrap();
    assert!(!dir.vault_path().exists());
    assert_eq!(v.status(), status(false, false));
    assert!(v.get("a").is_none(), "vuelve al llavero");
    assert!(v.set("a", "x").is_none());
    // Se puede crear otra con un PIN nuevo; la anterior se perdió.
    v.create("135790", BTreeMap::new(), FAST).unwrap();
    assert_eq!(get(&v, "a").unwrap(), None);
    // Borrar sin archivo no es error.
    v.remove().unwrap();
    v.remove().unwrap();
}

// ───────── Permisos ─────────

#[cfg(unix)]
#[test]
fn file_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("a", "1")]), FAST).unwrap();
    let mode = fs::metadata(dir.vault_path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    v.set("b", "2").unwrap().unwrap();
    v.change_pin(PIN, "999999", FAST).unwrap();
    let mode = fs::metadata(dir.vault_path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn calibration_stays_in_range() {
    let p = calibrate();
    let start = std::time::Instant::now();
    cipher::derive_key(PIN.as_bytes(), &[1u8; cipher::SALT_LEN], p).unwrap();
    eprintln!("calibrado: {p:?}, derivar tarda {:?}", start.elapsed());
    assert!(p.m_kib == 64 * 1024 || p.m_kib == 128 * 1024, "{p:?}");
    assert!((3..=20).contains(&p.t), "{p:?}");
    assert_eq!(p.p, 1);
}

// ───────── Mover secretos: llavero de mentira ─────────

#[derive(Default)]
struct FakeKeyring {
    data: RefCell<BTreeMap<String, String>>,
    fail_get: bool,
    fail_set: bool,
    fail_delete: bool,
}

impl Keyring for FakeKeyring {
    fn get(&self, user: &str) -> AppResult<Option<String>> {
        if self.fail_get {
            return Err(AppError::Keyring("se negó el acceso".into()));
        }
        Ok(self.data.borrow().get(user).cloned())
    }
    fn set(&self, user: &str, secret: &str) -> AppResult<()> {
        if self.fail_set {
            return Err(AppError::Keyring("se negó el acceso".into()));
        }
        self.data.borrow_mut().insert(user.into(), secret.into());
        Ok(())
    }
    fn delete(&self, user: &str) -> AppResult<()> {
        if self.fail_delete {
            return Err(AppError::Keyring("se negó el acceso".into()));
        }
        self.data.borrow_mut().remove(user);
        Ok(())
    }
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn enable_moves_secrets_from_keyring() {
    let dir = TempDir::new();
    let v = dir.vault();
    let kr = FakeKeyring::default();
    kr.data.borrow_mut().extend(map(&[
        ("s1", "p1"),
        ("s2", "p2"),
        ("s2:sudo", "sudo2"),
        ("s3:sudo", "sudo3"),
        ("x:sudo", "de otro"),
        ("github-token", "ghp"),
        ("mcp-token", "mcp"),
        ("ai-token", "sk-ia"),
        ("otra-app", "x"),
    ]));
    let r = secrets::enable_vault(&v, &kr, &ids(&["s1", "s2", "s3"]), PIN, FAST).unwrap();
    assert_eq!(r, MoveReport { moved: 7, left_in_keyring: 0 });
    // En el llavero solo queda lo que no es de un servidor conocido.
    assert_eq!(
        kr.data.borrow().keys().cloned().collect::<Vec<_>>(),
        vec!["otra-app".to_string(), "x:sudo".to_string()]
    );
    let v2 = dir.vault();
    v2.unlock(PIN).unwrap();
    assert_eq!(get(&v2, "s1").unwrap().as_deref(), Some("p1"));
    assert_eq!(get(&v2, "s2:sudo").unwrap().as_deref(), Some("sudo2"));
    assert_eq!(get(&v2, "s3:sudo").unwrap().as_deref(), Some("sudo3"));
    assert_eq!(get(&v2, "s1:sudo").unwrap(), None);
    assert_eq!(get(&v2, "github-token").unwrap().as_deref(), Some("ghp"));
    assert_eq!(get(&v2, "mcp-token").unwrap().as_deref(), Some("mcp"));
    assert_eq!(get(&v2, "ai-token").unwrap().as_deref(), Some("sk-ia"));
    assert_eq!(get(&v2, "s3").unwrap(), None);
}

#[test]
fn enable_aborts_without_losing_anything_if_keyring_fails() {
    let dir = TempDir::new();
    let v = dir.vault();
    let kr = FakeKeyring { fail_get: true, ..Default::default() };
    kr.data.borrow_mut().insert("s1".into(), "p1".into());
    assert!(secrets::enable_vault(&v, &kr, &ids(&["s1"]), PIN, FAST).is_err());
    assert!(!dir.vault_path().exists(), "no se crea la bóveda");
    assert!(!v.is_enabled());
    assert_eq!(kr.data.borrow().get("s1").map(String::as_str), Some("p1"));
}

#[test]
fn enable_keeps_copies_if_keyring_cannot_delete() {
    let dir = TempDir::new();
    let v = dir.vault();
    let kr = FakeKeyring { fail_delete: true, ..Default::default() };
    kr.data.borrow_mut().insert("s1".into(), "p1".into());
    let r = secrets::enable_vault(&v, &kr, &ids(&["s1"]), PIN, FAST).unwrap();
    assert_eq!(r, MoveReport { moved: 1, left_in_keyring: 1 });
    assert_eq!(get(&v, "s1").unwrap().as_deref(), Some("p1"));
}

#[test]
fn disable_returns_secrets_to_keyring() {
    let dir = TempDir::new();
    let v = dir.vault();
    let all = map(&[
        ("s1", "p1"),
        ("s1:sudo", "ps1"),
        ("github-token", "ghp"),
        ("mcp-token", "mcp"),
        ("ai-token", "sk-ia"),
    ]);
    v.create(PIN, all.clone(), FAST).unwrap();
    v.lock();
    let kr = FakeKeyring::default();

    // PIN incorrecto: nada cambia.
    assert!(matches!(secrets::disable_vault(&v, &kr, "000000"), Err(AppError::AuthFailed(_))));
    assert!(dir.vault_path().exists());
    assert!(kr.data.borrow().is_empty());

    let r = secrets::disable_vault(&v, &kr, PIN).unwrap();
    assert_eq!(r.moved, 5);
    assert!(!dir.vault_path().exists());
    assert!(!v.is_enabled());
    assert_eq!(*kr.data.borrow(), all);
}

#[test]
fn disable_keeps_vault_if_keyring_fails() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("s1", "p1")]), FAST).unwrap();
    let kr = FakeKeyring { fail_set: true, ..Default::default() };
    assert!(matches!(secrets::disable_vault(&v, &kr, PIN), Err(AppError::Keyring(_))));
    assert!(dir.vault_path().exists());
    assert!(v.is_enabled());
    assert_eq!(get(&v, "s1").unwrap().as_deref(), Some("p1"));
}

#[test]
fn forgot_pin_drops_sudo_secrets_too() {
    let dir = TempDir::new();
    let v = dir.vault();
    let kr = FakeKeyring::default();
    kr.data.borrow_mut().extend(map(&[("s1", "p1"), ("s1:sudo", "ps1")]));
    secrets::enable_vault(&v, &kr, &ids(&["s1"]), PIN, FAST).unwrap();
    assert!(kr.data.borrow().is_empty());
    v.lock();
    v.remove().unwrap();
    // Sin bóveda se lee del llavero: ya no hay nada, ni de conexión ni de sudo.
    for id in ["s1", "s1:sudo"] {
        assert_eq!(secrets::get_with(&v, &kr, id).unwrap(), None, "{id}");
    }
}

// ───────── Secretos de un servidor (conexión + sudo) ─────────

#[test]
fn sudo_ids_and_kinds() {
    assert_eq!(secrets::sudo_id("abc"), "abc:sudo");
    assert_eq!(secrets::SecretKind::Login.id("abc"), "abc");
    assert_eq!(secrets::SecretKind::Sudo.id("abc"), "abc:sudo");
    assert_eq!(secrets::server_secret_ids("abc"), ["abc".to_string(), "abc:sudo".to_string()]);
}

#[test]
fn delete_and_copy_server_secrets_in_keyring() {
    let dir = TempDir::new();
    let v = dir.vault(); // sin bóveda: llavero
    let kr = FakeKeyring::default();
    kr.data.borrow_mut().extend(map(&[("s1", "p1"), ("s1:sudo", "ps1"), ("s2", "p2"), ("s2:sudo", "ps2")]));

    secrets::copy_server_secrets_with(&v, &kr, "s1", "c1").unwrap();
    assert_eq!(secrets::get_with(&v, &kr, "c1").unwrap().as_deref(), Some("p1"));
    assert_eq!(secrets::get_with(&v, &kr, "c1:sudo").unwrap().as_deref(), Some("ps1"));

    secrets::delete_server_secrets_with(&v, &kr, "s1").unwrap();
    let left: Vec<String> = kr.data.borrow().keys().cloned().collect();
    assert_eq!(left, ["c1", "c1:sudo", "s2", "s2:sudo"].map(String::from).to_vec());
    // Borrar lo que no existe no es error.
    secrets::delete_server_secrets_with(&v, &kr, "s1").unwrap();
}

#[test]
fn delete_and_copy_server_secrets_in_vault() {
    let dir = TempDir::new();
    let v = dir.vault();
    v.create(PIN, map(&[("s1", "p1"), ("s1:sudo", "ps1"), ("s2:sudo", "ps2")]), FAST).unwrap();
    let kr = FakeKeyring::default();

    // Solo sudo guardado (servidor con llave): se copia igual.
    secrets::copy_server_secrets_with(&v, &kr, "s2", "c2").unwrap();
    assert_eq!(get(&v, "c2").unwrap(), None);
    assert_eq!(get(&v, "c2:sudo").unwrap().as_deref(), Some("ps2"));

    secrets::delete_server_secrets_with(&v, &kr, "s1").unwrap();
    assert_eq!(v.ids().unwrap(), vec!["c2:sudo".to_string(), "s2:sudo".to_string()]);
    assert!(kr.data.borrow().is_empty(), "con bóveda no se toca el llavero");

    // Queda escrito en el archivo.
    let v2 = dir.vault();
    v2.unlock(PIN).unwrap();
    assert_eq!(get(&v2, "s1:sudo").unwrap(), None);
    assert_eq!(get(&v2, "c2:sudo").unwrap().as_deref(), Some("ps2"));

    // Bloqueada: no se puede borrar nada (y se avisa).
    v2.lock();
    assert!(matches!(secrets::delete_server_secrets_with(&v2, &kr, "s2"), Err(AppError::Locked)));
}

// ───────── Mover secretos: llavero real ("sshorus-test") ─────────

/// `cargo test --lib storage::vault -- --ignored --test-threads=1`
#[test]
#[ignore]
fn migration_with_real_keyring() {
    let kr = SystemKeyring("sshorus-test");
    let a = format!("test-{}", uuid::Uuid::new_v4());
    let b = format!("test-{}", uuid::Uuid::new_v4());
    if let Err(e) = kr.set(&a, "pa ñ") {
        eprintln!("Llavero no disponible, se omite: {e}");
        return;
    }
    kr.set(&b, "pb").unwrap();
    // Si hubiera un token de pruebas viejo, se limpia (no es de este test).
    let _ = kr.delete(secrets::GITHUB_TOKEN_USER);

    let dir = TempDir::new();
    // También la llave del equipo en el llavero real.
    let v = Vault::new(Some(dir.vault_path()), Box::new(secrets::KeyringDeviceKey("sshorus-test")));
    let r = secrets::enable_vault(&v, &kr, &[a.clone(), b.clone()], PIN, FAST).unwrap();
    assert!(kr.get(DEVICE_KEY_USER).unwrap().is_some(), "llave del equipo en el llavero");
    v.lock();
    v.unlock(PIN).unwrap();
    assert_eq!(r, MoveReport { moved: 2, left_in_keyring: 0 });
    assert_eq!(kr.get(&a).unwrap(), None, "ya no está en el llavero");
    assert_eq!(get(&v, &a).unwrap().as_deref(), Some("pa ñ"));

    v.lock();
    let r = secrets::disable_vault(&v, &kr, PIN).unwrap();
    assert_eq!(r.moved, 2);
    assert!(!dir.vault_path().exists());
    assert_eq!(kr.get(DEVICE_KEY_USER).unwrap(), None, "la llave del equipo se borra");
    assert_eq!(kr.get(&a).unwrap().as_deref(), Some("pa ñ"));
    assert_eq!(kr.get(&b).unwrap().as_deref(), Some("pb"));

    let users: BTreeSet<&str> = [a.as_str(), b.as_str()].into();
    for u in users {
        kr.delete(u).unwrap();
    }
}
