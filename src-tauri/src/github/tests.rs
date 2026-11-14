//! Tests del módulo GitHub: cifrado, parseo y validaciones. Los de red van con `#[ignore]`
//! (`cargo test --lib github -- --ignored`) y solo hacen lecturas públicas sin token.

use reqwest::StatusCode;
use reqwest::header::{HeaderMap, HeaderValue};

use super::api;
use super::config::{self, DeployRecipe};
use super::crypto::{self, KdfParams};
use super::http::{self, Resp};
use super::localkey;
use super::share::{self, Source};
use crate::error::AppError;

/// Parámetros ligeros para que los tests en modo debug no tarden.
const FAST: KdfParams = KdfParams {
    m_kib: 256,
    t: 1,
    p: 1,
};

// ───────── Cifrado ─────────

#[test]
fn crypto_roundtrip() {
    let msg = r#"{"servers":[{"name":"web ñ"}]}"#.as_bytes();
    let env = crypto::encrypt_with(msg, "frase de prueba", FAST).unwrap();
    assert_eq!(env.format, crypto::FORMAT);
    assert_ne!(env.data.as_bytes(), msg);
    let back = crypto::decrypt(&env, "frase de prueba").unwrap();
    assert_eq!(back, msg);
    // El sobre sobrevive a JSON.
    let json = serde_json::to_string(&env).unwrap();
    let env2: crypto::Envelope = serde_json::from_str(&json).unwrap();
    assert_eq!(crypto::decrypt(&env2, "frase de prueba").unwrap(), msg);
}

#[test]
fn crypto_wrong_passphrase_fails() {
    let env = crypto::encrypt_with(b"hola", "correcta-123", FAST).unwrap();
    let err = crypto::decrypt(&env, "incorrecta-123").unwrap_err();
    assert!(matches!(err, AppError::AuthFailed(_)), "{err:?}");
}

#[test]
fn crypto_random_salt_and_nonce() {
    let a = crypto::encrypt_with(b"x", "12345678", FAST).unwrap();
    let b = crypto::encrypt_with(b"x", "12345678", FAST).unwrap();
    assert_ne!(a.kdf.salt, b.kdf.salt);
    assert_ne!(a.nonce, b.nonce);
    assert_ne!(a.data, b.data);
}

#[test]
fn crypto_tampered_header_fails() {
    let mut env = crypto::encrypt_with(b"hola", "correcta-123", FAST).unwrap();
    env.kdf.params.t = 2; // cambia la cabecera autenticada
    assert!(crypto::decrypt(&env, "correcta-123").is_err());
    let mut env = crypto::encrypt_with(b"hola", "correcta-123", FAST).unwrap();
    env.kdf.params.m_kib = 10 * 1024 * 1024; // fuera de rango: ni lo intenta
    assert!(matches!(
        crypto::decrypt(&env, "correcta-123"),
        Err(AppError::Invalid(_))
    ));
}

#[test]
fn crypto_short_passphrase_rejected() {
    assert!(matches!(
        crypto::encrypt_with(b"x", "corta", FAST),
        Err(AppError::Invalid(_))
    ));
}

#[test]
fn crypto_default_params_roundtrip() {
    // Parámetros reales (64 MiB). Más lento en debug, pero comprueba que valen.
    let env = crypto::encrypt(b"datos", "frase-real-1").unwrap();
    assert_eq!(env.kdf.params, crypto::DEFAULT_KDF);
    assert_eq!(crypto::decrypt(&env, "frase-real-1").unwrap(), b"datos");
}

// ───────── Errores HTTP ─────────

fn resp(code: u16, headers: &[(&'static str, &str)], body: &str) -> Resp {
    let mut h = HeaderMap::new();
    for (k, v) in headers {
        h.insert(*k, HeaderValue::from_str(v).unwrap());
    }
    Resp {
        status: StatusCode::from_u16(code).unwrap(),
        headers: h,
        body: body.as_bytes().to_vec(),
    }
}

#[test]
fn http_errors_in_spanish() {
    let e = http::status_error(&resp(401, &[], r#"{"message":"Bad credentials"}"#));
    assert!(
        matches!(&e, AppError::AuthFailed(m) if m.contains("Token no válido o caducado")),
        "{e}"
    );

    let e = http::status_error(&resp(
        403,
        &[
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", "1700000000"),
        ],
        r#"{"message":"API rate limit exceeded"}"#,
    ));
    let m = e.to_string();
    assert!(
        m.contains("límite de peticiones") && m.contains("Se reinicia a las"),
        "{m}"
    );

    let e = http::status_error(&resp(
        403,
        &[("retry-after", "60")],
        r#"{"message":"secondary rate limit"}"#,
    ));
    assert!(e.to_string().contains("60 s"), "{e}");

    let e = http::status_error(&resp(
        403,
        &[("x-ratelimit-remaining", "10")],
        r#"{"message":"Resource not accessible"}"#,
    ));
    assert!(
        matches!(&e, AppError::AuthFailed(m) if m.contains("permisos")),
        "{e}"
    );

    assert!(matches!(
        http::status_error(&resp(404, &[], "{}")),
        AppError::NotFound(_)
    ));

    let e = http::status_error(&resp(
        422,
        &[],
        r#"{"message":"Validation Failed","errors":[{"message":"key is already in use"}]}"#,
    ));
    assert!(e.to_string().contains("key is already in use"), "{e}");

    assert!(matches!(
        http::status_error(&resp(502, &[], "")),
        AppError::Network(_)
    ));
}

#[test]
fn only_github_hosts_allowed() {
    assert!(http::is_allowed_host("api.github.com"));
    assert!(http::is_allowed_host("RAW.githubusercontent.com"));
    assert!(!http::is_allowed_host("example.com"));
    assert!(!http::is_allowed_host("api.github.com.evil.io"));
}

#[tokio::test]
async fn rejects_foreign_urls() {
    let r = http::get_url(None, "https://example.com/x.json", 1024).await;
    assert!(matches!(r, Err(AppError::Invalid(_))));
    let r = http::get_url(None, "http://raw.githubusercontent.com/a/b/c", 1024).await;
    assert!(matches!(r, Err(AppError::Invalid(_))));
}

// ───────── Parseo de la API ─────────

#[test]
fn parse_repos_and_runs() {
    let repos = r#"[{"full_name":"ana/web","name":"web","owner":{"login":"ana"},"private":true,
        "archived":false,"fork":false,"default_branch":"main","ssh_url":"git@github.com:ana/web.git",
        "clone_url":"https://github.com/ana/web.git","html_url":"https://github.com/ana/web",
        "description":null,"pushed_at":"2026-01-01T00:00:00Z","extra":1}]"#;
    let r = api::parse_repos(repos.as_bytes()).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].owner, "ana");
    assert!(r[0].private);
    assert_eq!(r[0].default_branch, "main");

    let runs = r#"{"total_count":1,"workflow_runs":[{"id":7,"name":"CI","display_title":"fix",
        "workflow_id":3,"run_number":12,"status":"completed","conclusion":"failure","head_branch":"main",
        "event":"push","html_url":"https://github.com/ana/web/actions/runs/7",
        "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:01:00Z"}]}"#;
    let r = api::parse_runs(runs.as_bytes()).unwrap();
    assert_eq!(r[0].conclusion.as_deref(), Some("failure"));
    assert_eq!(r[0].workflow_id, 3);
    // Se serializa en camelCase para la interfaz.
    let v = serde_json::to_value(&r[0]).unwrap();
    assert!(v.get("htmlUrl").is_some() && v.get("runNumber").is_some());
}

#[test]
fn scopes_and_token_kind() {
    assert_eq!(
        api::parse_scopes(Some("repo, gist,  read:public_key")).unwrap(),
        vec!["repo", "gist", "read:public_key"]
    );
    assert_eq!(api::parse_scopes(Some("")).unwrap(), Vec::<String>::new());
    assert!(api::parse_scopes(None).is_none());
    assert_eq!(api::token_kind("ghp_abc"), "classic");
    assert_eq!(api::token_kind("github_pat_abc"), "fine-grained");
}

#[test]
fn name_validation() {
    assert!(api::check_repo("LeoMael", "my.repo_x-1").is_ok());
    assert!(api::check_repo("a/b", "x").is_err());
    assert!(api::check_repo("ana", "..").is_err());
    assert!(api::check_repo("ana", "a b").is_err());
    assert!(api::valid_gist_id("aa5a315d61ae9438b18d"));
    assert!(!api::valid_gist_id("../x"));
}

// ───────── Llaves públicas locales ─────────

const ED: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ana@pc";

#[test]
fn public_key_line_parse() {
    let (line, ty, comment) = localkey::parse_public_key_line(&format!("\n# c\n{ED}\n")).unwrap();
    assert_eq!(line, ED);
    assert_eq!(ty, "ssh-ed25519");
    assert_eq!(comment, "ana@pc");
    assert!(localkey::parse_public_key_line("-----BEGIN OPENSSH PRIVATE KEY-----\nabc").is_err());
    assert!(localkey::parse_public_key_line("hola mundo").is_err());
    assert!(localkey::parse_public_key_line("ssh-ed25519 ;rm -rf").is_err());
}

#[test]
fn read_pub_only_reads_pub_files() {
    let dir = std::env::temp_dir().join(format!("tv-gh-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let pubf = dir.join("id_ed25519.pub");
    std::fs::write(&pubf, format!("{ED}\n")).unwrap();
    let priv_f = dir.join("id_ed25519");
    std::fs::write(&priv_f, "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
    let fake = dir.join("trampa.pub");
    std::fs::write(&fake, "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();

    assert_eq!(localkey::read_pub(&pubf).unwrap().line, ED);
    assert!(localkey::read_pub(&priv_f).is_err());
    assert!(localkey::read_pub(&fake).is_err());
    #[cfg(unix)]
    {
        // Un enlace .pub que apunta a la llave privada tampoco vale.
        let link = dir.join("enlace.pub");
        std::os::unix::fs::symlink(&priv_f, &link).unwrap();
        assert!(localkey::read_pub(&link).is_err());
    }
    let list = localkey::list_pub(&dir);
    assert_eq!(list.len(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

// ───────── Compartir comandos ─────────

#[test]
fn resolve_sources() {
    assert_eq!(
        share::resolve("aa5a315d61ae9438b18d").unwrap(),
        Source::Gist("aa5a315d61ae9438b18d".into())
    );
    assert_eq!(
        share::resolve("https://gist.github.com/ana/AA5a315d61ae9438b18d").unwrap(),
        Source::Gist("aa5a315d61ae9438b18d".into())
    );
    assert_eq!(
        share::resolve("https://github.com/ana/cmds/blob/main/dir/x.json").unwrap(),
        Source::Raw("https://raw.githubusercontent.com/ana/cmds/main/dir/x.json".into())
    );
    assert_eq!(
        share::resolve("https://raw.githubusercontent.com/ana/cmds/main/x.json?token=1").unwrap(),
        Source::Raw("https://raw.githubusercontent.com/ana/cmds/main/x.json".into())
    );
    assert!(share::resolve("https://example.com/x.json").is_err());
    assert!(share::resolve("http://gist.github.com/aa5a").is_err());
    assert!(share::resolve("file:///etc/passwd").is_err());
}

#[test]
fn parse_collections() {
    let list = r#"[{"name":"Uso","command":"df -h","category":"Disco","readOnly":true},
                  {"name":"","command":"x"}, {"foo":1},
                  {"id":"abc","name":"Reiniciar","command":"reboot","scope":"server","scopeId":"s1","dangerous":true,"sudo":true}]"#;
    let s = share::parse_collection(list).unwrap();
    assert_eq!(s.len(), 2);
    assert!(s.iter().all(|x| x.id.is_empty() && x.scope_id.is_none()));
    assert!(s[0].read_only);
    assert_eq!(s[1].category, "Importados");
    assert!(s[1].dangerous && s[1].sudo);

    let wrapped = share::to_collection(&s).unwrap();
    assert!(wrapped.contains(share::FORMAT));
    let again = share::parse_collection(&wrapped).unwrap();
    assert_eq!(again.len(), 2);
    assert_eq!(again[0].command, "df -h");

    assert!(share::parse_collection("{}").is_err());
    assert!(share::parse_collection("no json").is_err());
    assert!(share::parse_collection("[]").is_err());
}

// ───────── Sincronización y recetas ─────────

#[test]
fn forbidden_keys_detected() {
    let ok = serde_json::json!({"servers":[{"auth":"password","name":"a"}]});
    assert!(super::find_forbidden(&ok).is_none());
    let bad = serde_json::json!({"servers":[{"name":"a","Password":"x"}]});
    assert_eq!(super::find_forbidden(&bad).as_deref(), Some("Password"));
    let bad = serde_json::json!({"x":{"private_key":"x"}});
    assert!(super::find_forbidden(&bad).is_some());
}

/// La copia en Gist lleva los servidores tal cual: con «Contraseña de sudo: Guardar» solo viaja el
/// modo, nunca la contraseña (va en la bóveda o el llavero con id "<id>:sudo").
#[test]
fn synced_server_carries_sudo_mode_but_no_secret() {
    let srv: crate::types::ServerProfile = serde_json::from_value(serde_json::json!({
        "id": "s1", "name": "web", "host": "h", "port": 22, "username": "u", "auth": "key",
        "keyPath": "~/.ssh/id_ed25519", "defaultPath": null, "color": null, "sudoMode": "saved"
    }))
    .unwrap();
    let v = serde_json::to_value(&srv).unwrap();
    assert_eq!(v["sudoMode"], "saved");
    let payload = serde_json::json!({ "format": "sshorus-config", "servers": [v] });
    assert!(super::find_forbidden(&payload).is_none());
    let text = payload.to_string();
    assert!(!text.contains(":sudo") && !text.to_lowercase().contains("password"), "{text}");
    // Perfiles viejos (sin el campo) siguen leyéndose: «Pedir cada vez».
    let old: crate::types::ServerProfile = serde_json::from_value(serde_json::json!({
        "id": "s2", "name": "a", "host": "h", "port": 22, "username": "u", "auth": "password",
        "keyPath": null, "defaultPath": null, "color": null
    }))
    .unwrap();
    assert_eq!(old.sudo_mode, crate::types::SudoMode::Ask);
}

fn recipe(name: &str) -> DeployRecipe {
    DeployRecipe {
        id: String::new(),
        name: name.into(),
        server_id: "srv".into(),
        project_id: None,
        repo: Some("ana/web".into()),
        path: " ~/apps/web ".into(),
        branch: "main".into(),
        commands: "podman compose up -d --build\r\n".into(),
        deploy_key: None,
        last_run_at: None,
        last_ok: None,
    }
}

#[test]
fn recipes_store_roundtrip() {
    let dir = std::env::temp_dir().join(format!("tv-gh-{}", uuid::Uuid::new_v4()));
    let p = dir.join("github.json");
    let saved = config::save_recipe_at(&p, recipe("Web")).unwrap();
    assert!(!saved.id.is_empty());
    assert_eq!(saved.path, "~/apps/web");
    assert_eq!(saved.commands, "podman compose up -d --build");
    let mut edited = saved.clone();
    edited.branch = "release/v2".into();
    config::save_recipe_at(&p, edited).unwrap();
    let cfg = config::load_from(&p);
    assert_eq!(cfg.recipes.len(), 1);
    assert_eq!(cfg.recipes[0].branch, "release/v2");
    config::delete_recipe_at(&p, &saved.id).unwrap();
    assert!(config::load_from(&p).recipes.is_empty());

    let mut bad = recipe("x");
    bad.branch = "--upload-pack=evil".into();
    assert!(config::save_recipe_at(&p, bad).is_err());
    let mut bad = recipe("x");
    bad.repo = Some("no-slash".into());
    assert!(config::save_recipe_at(&p, bad).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}

// ───────── Red (lectura pública sin token) ─────────

#[tokio::test]
#[ignore]
async fn live_public_user_keys() {
    let keys = api::user_keys(None, "LeoMael").await.unwrap();
    for k in &keys {
        assert!(localkey::parse_public_key_line(&k.key).is_ok(), "{}", k.key);
    }
    eprintln!("LeoMael tiene {} llaves públicas", keys.len());
    let err = api::user_keys(None, "este-usuario-no-existe-tv-0000000000000")
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}

#[tokio::test]
#[ignore]
async fn live_bad_token_is_401() {
    let err = api::account("ghp_000000000000000000000000000000000000")
        .await
        .unwrap_err();
    assert!(
        matches!(&err, AppError::AuthFailed(m) if m.contains("Token no válido")),
        "{err:?}"
    );
}
