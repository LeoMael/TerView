use std::fs;
use std::path::PathBuf;

use super::*;

/// Carpeta temporal propia que se borra al final.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("terview-storage-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn server(name: &str) -> ServerProfile {
    ServerProfile {
        id: String::new(),
        name: name.into(),
        host: "example.com".into(),
        port: 22,
        username: "root".into(),
        auth: AuthMethod::Password,
        key_path: None,
        default_path: None,
        color: None,
        tmux: None,
    }
}

fn project(name: &str, server_ids: Vec<String>, bookmarks: Vec<Bookmark>) -> Project {
    Project { id: String::new(), name: name.into(), server_ids, bookmarks, color: Some("#f97316".into()) }
}

#[test]
fn roundtrip_servers_and_projects() {
    let t = TempDir::new();
    let path = t.file("cfg/profiles.json");
    let store = ProfileStore::load_from(&path);
    assert!(store.data().servers.is_empty());

    let a = store.save_server(server("  web-prod ")).unwrap();
    assert_eq!(a.name, "web-prod");
    assert!(uuid::Uuid::parse_str(&a.id).is_ok());
    let b = store.save_server(server("db")).unwrap();
    assert_ne!(a.id, b.id);

    // Actualizar mantiene el id.
    let mut a2 = a.clone();
    a2.port = 2222;
    a2.default_path = Some("  ".into());
    let a2 = store.save_server(a2).unwrap();
    assert_eq!(a2.id, a.id);
    assert_eq!(a2.default_path, None);

    let p = store
        .save_project(project(
            "Cliente X",
            vec![a.id.clone(), a.id.clone(), "fantasma".into()],
            vec![Bookmark { server_id: b.id.clone(), path: "/var/www".into(), label: Some("web".into()) }],
        ))
        .unwrap();
    // Duplicados y desconocidos fuera; el servidor del marcador se añade.
    assert_eq!(p.server_ids, vec![a.id.clone(), b.id.clone()]);

    let reloaded = ProfileStore::load_from(&path);
    let d = reloaded.data();
    assert_eq!(d.servers.len(), 2);
    assert_eq!(reloaded.get_server(&a.id).unwrap().port, 2222);
    assert_eq!(d.projects.len(), 1);
    assert_eq!(d.projects[0].bookmarks[0].path, "/var/www");
    assert!(matches!(reloaded.get_server("nope"), Err(AppError::NotFound(_))));
}

#[cfg(unix)]
#[test]
fn file_permissions_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let t = TempDir::new();
    let dir = t.file("conf");
    let path = dir.join("profiles.json");
    let store = ProfileStore::load_from(&path);
    store.save_server(server("x")).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    // No quedan temporales.
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
}

#[test]
fn validation() {
    let t = TempDir::new();
    let store = ProfileStore::load_from(t.file("profiles.json"));
    let bad = |f: &dyn Fn(&mut ServerProfile)| {
        let mut s = server("ok");
        f(&mut s);
        matches!(store.save_server(s), Err(AppError::Invalid(_)))
    };
    assert!(bad(&|s| s.name = "  ".into()));
    assert!(bad(&|s| s.host = "".into()));
    assert!(bad(&|s| s.host = "a b".into()));
    assert!(bad(&|s| s.username = "".into()));
    assert!(bad(&|s| s.port = 0));
    assert!(bad(&|s| s.auth = AuthMethod::Key));
    assert!(bad(&|s| {
        s.auth = AuthMethod::Key;
        s.key_path = Some(" ".into());
    }));
    let mut k = server("k");
    k.auth = AuthMethod::Key;
    k.key_path = Some("~/.ssh/id_ed25519".into());
    assert!(store.save_server(k).is_ok());
    // Nada inválido llegó a guardarse.
    assert_eq!(store.data().servers.len(), 1);

    assert!(matches!(store.save_project(project(" ", vec![], vec![])), Err(AppError::Invalid(_))));
}

#[test]
fn delete_server_cascades() {
    let t = TempDir::new();
    let path = t.file("profiles.json");
    let store = ProfileStore::load_from(&path);
    let a = store.save_server(server("a")).unwrap();
    let b = store.save_server(server("b")).unwrap();
    store
        .save_project(project(
            "p",
            vec![a.id.clone(), b.id.clone()],
            vec![
                Bookmark { server_id: a.id.clone(), path: "/a".into(), label: None },
                Bookmark { server_id: b.id.clone(), path: "/b".into(), label: None },
            ],
        ))
        .unwrap();

    store.delete_server(&a.id).unwrap();
    let d = ProfileStore::load_from(&path).data();
    assert_eq!(d.servers.len(), 1);
    assert_eq!(d.projects[0].server_ids, vec![b.id.clone()]);
    assert_eq!(d.projects[0].bookmarks.len(), 1);
    assert_eq!(d.projects[0].bookmarks[0].server_id, b.id);

    assert!(matches!(store.delete_server(&a.id), Err(AppError::NotFound(_))));
    let pid = d.projects[0].id.clone();
    store.delete_project(&pid).unwrap();
    assert!(store.data().projects.is_empty());
    assert!(matches!(store.delete_project(&pid), Err(AppError::NotFound(_))));
}

#[test]
fn corrupt_file_is_backed_up() {
    let t = TempDir::new();
    let path = t.file("profiles.json");
    fs::write(&path, b"{ esto no es json").unwrap();
    let store = ProfileStore::load_from(&path);
    assert!(store.data().servers.is_empty());
    assert!(!path.exists());
    let backups: Vec<_> = fs::read_dir(&t.0)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("profiles.json.bak-"))
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read(t.0.join(&backups[0])).unwrap(), b"{ esto no es json");
    // Sigue funcionando.
    store.save_server(server("x")).unwrap();
    assert_eq!(ProfileStore::load_from(&path).data().servers.len(), 1);
}

#[test]
fn repairs_loaded_data() {
    let t = TempDir::new();
    let path = t.file("profiles.json");
    fs::write(
        &path,
        r#"{"servers":[
            {"id":"","name":"a","host":"h","port":22,"username":"u","auth":"agent","keyPath":null,"defaultPath":null,"color":null},
            {"id":"x","name":"b","host":"h","port":22,"username":"u","auth":"password","keyPath":null,"defaultPath":null,"color":null}
          ],
          "projects":[{"id":"p","name":"P","serverIds":["x","gone"],"bookmarks":[{"serverId":"gone","path":"/","label":null}],"color":null}]}"#,
    )
    .unwrap();
    let d = ProfileStore::load_from(&path).data();
    assert!(!d.servers[0].id.is_empty());
    assert_eq!(d.projects[0].server_ids, vec!["x".to_string()]);
    assert!(d.projects[0].bookmarks.is_empty());
}

#[test]
fn settings_defaults_clamp_and_roundtrip() {
    let t = TempDir::new();
    let path = t.file("settings.json");
    let store = SettingsStore::load_from(&path);
    assert_eq!(store.get().transfer_concurrency, Settings::default().transfer_concurrency);

    let mut s = store.get();
    s.transfer_concurrency = 50;
    s.theme = "neon".into();
    s.show_hidden_files = true;
    s.layout.insert("main".into(), vec![20.0, 80.0]);
    let saved = store.save(s).unwrap();
    assert_eq!(saved.transfer_concurrency, 8);
    assert_eq!(saved.theme, "dark");

    let mut s = saved.clone();
    s.transfer_concurrency = 0;
    assert_eq!(store.save(s).unwrap().transfer_concurrency, 1);

    let reloaded = SettingsStore::load_from(&path).get();
    assert_eq!(reloaded.transfer_concurrency, 1);
    assert!(reloaded.show_hidden_files);
    assert_eq!(reloaded.layout.get("main"), Some(&vec![20.0, 80.0]));
}

#[test]
fn settings_partial_and_corrupt() {
    let t = TempDir::new();
    let path = t.file("settings.json");
    // Campos faltantes → valores por defecto; valores fuera de rango → acotados.
    fs::write(&path, r#"{"theme":"light","transferConcurrency":99}"#).unwrap();
    let s = SettingsStore::load_from(&path).get();
    assert_eq!(s.theme, "light");
    assert_eq!(s.transfer_concurrency, 8);
    assert_eq!(s.terminal_font_size, Settings::default().terminal_font_size);

    fs::write(&path, b"[1,2").unwrap();
    let s = SettingsStore::load_from(&path).get();
    assert_eq!(s.theme, "dark");
    assert!(!path.exists());
}

#[test]
fn duplicate_server_unique_name_and_projects() {
    let t = TempDir::new();
    let store = ProfileStore::load_from(t.file("profiles.json"));
    let a = store.save_server(server("web")).unwrap();
    let b = store.save_server(server("db")).unwrap();
    let p = store.save_project(project("P", vec![a.id.clone()], vec![])).unwrap();

    let c1 = store.duplicate_server(&a.id).unwrap();
    assert_eq!(c1.name, "web (copia)");
    assert_ne!(c1.id, a.id);
    assert_eq!((c1.host.as_str(), c1.port, c1.username.as_str()), ("example.com", 22, "root"));
    let c2 = store.duplicate_server(&a.id).unwrap();
    assert_eq!(c2.name, "web (copia 2)");

    let d = store.data();
    // Las copias quedan justo debajo del original.
    let names: Vec<&str> = d.servers.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["web", "web (copia 2)", "web (copia)", "db"]);
    let proj = d.projects.iter().find(|x| x.id == p.id).unwrap();
    assert_eq!(proj.server_ids, vec![a.id.clone(), c1.id.clone(), c2.id.clone()]);
    assert!(!proj.server_ids.contains(&b.id));

    // Persistido en disco.
    let reloaded = ProfileStore::load_from(t.file("profiles.json"));
    assert_eq!(reloaded.data().servers.len(), 4);
    assert!(matches!(store.duplicate_server("nope"), Err(AppError::NotFound(_))));
}
