//! Servidores, proyectos, ajustes (JSON en ~/.config/terview/) y secretos (llavero).
//! DUEÑO: agente Almacenamiento.
//!
//! API usada por otros módulos (NO cambiar firmas):
//!   ProfileStore::load(), ProfileStore::get_server(id)
//!   SettingsStore::load(), SettingsStore::get()
//!   secrets::get_secret / set_secret / delete_secret

pub(crate) mod cipher;
pub(crate) mod fsutil;
pub mod lock;
pub mod secrets;
pub mod vault;
pub mod ssh_config;
#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::types::{AuthMethod, Bookmark, Project, ProfilesData, ServerProfile, Settings, SshConfigExport};

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Recorta y convierte "" en None.
fn clean_opt(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn read_lock<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    // Un pánico con el candado tomado no deja datos a medias (siempre se reemplaza entero).
    l.read().unwrap_or_else(|p| p.into_inner())
}

fn write_lock<T>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|p| p.into_inner())
}

fn no_config_dir() -> AppError {
    AppError::Io("no se encontró la carpeta de configuración del usuario".into())
}

// ───────────────────────── Servidores y proyectos ─────────────────────────

pub struct ProfileStore {
    /// None si el sistema no tiene carpeta de configuración (solo en memoria).
    path: Option<PathBuf>,
    data: RwLock<ProfilesData>,
}

impl ProfileStore {
    /// Lee ~/.config/terview/profiles.json (o vacío si no existe). Nunca falla: registra el error.
    pub fn load() -> Self {
        match fsutil::config_dir() {
            Some(dir) => Self::load_from(dir.join("profiles.json")),
            None => {
                log::error!("No hay carpeta de configuración: los servidores no se guardarán");
                ProfileStore { path: None, data: RwLock::new(ProfilesData::default()) }
            }
        }
    }

    /// Igual que `load` pero con una ruta concreta (tests).
    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mut data: ProfilesData = fsutil::read_json_or_default(&path);
        repair(&mut data);
        ProfileStore { path: Some(path), data: RwLock::new(data) }
    }

    pub fn data(&self) -> ProfilesData {
        read_lock(&self.data).clone()
    }

    pub fn get_server(&self, id: &str) -> AppResult<ServerProfile> {
        read_lock(&self.data)
            .servers
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("servidor {id}")))
    }

    /// Aplica `f` sobre una copia; si todo va bien la guarda en disco y la publica.
    /// Si falla la validación o el disco, nada cambia.
    fn mutate<R>(&self, f: impl FnOnce(&mut ProfilesData) -> AppResult<R>) -> AppResult<R> {
        let mut guard = write_lock(&self.data);
        let mut next = guard.clone();
        let out = f(&mut next)?;
        match &self.path {
            Some(p) => fsutil::write_json_atomic(p, &next)?,
            None => return Err(no_config_dir()),
        }
        *guard = next;
        Ok(out)
    }

    /// Crea (id vacío → UUID nuevo) o actualiza un servidor. Devuelve el servidor guardado.
    pub fn save_server(&self, server: ServerProfile) -> AppResult<ServerProfile> {
        let mut server = validate_server(server)?;
        self.mutate(|d| {
            if server.id.is_empty() {
                server.id = new_id();
                d.servers.push(server.clone());
            } else if let Some(existing) = d.servers.iter_mut().find(|s| s.id == server.id) {
                *existing = server.clone();
            } else {
                // Id desconocido (p. ej. importado): lo conservamos.
                d.servers.push(server.clone());
            }
            Ok(server)
        })
    }

    /// Borra el servidor y sus referencias en proyectos. (El secreto lo borra el comando.)
    pub fn delete_server(&self, id: &str) -> AppResult<()> {
        self.mutate(|d| {
            let before = d.servers.len();
            d.servers.retain(|s| s.id != id);
            if d.servers.len() == before {
                return Err(AppError::NotFound(format!("servidor {id}")));
            }
            for p in &mut d.projects {
                p.server_ids.retain(|s| s != id);
                p.bookmarks.retain(|b| b.server_id != id);
            }
            Ok(())
        })
    }

    /// Copia un servidor con nombre "<nombre> (copia)" (único) e id nuevo, justo debajo del original.
    /// La copia se añade también a los proyectos del original. (El secreto lo copia el comando.)
    pub fn duplicate_server(&self, id: &str) -> AppResult<ServerProfile> {
        self.mutate(|d| {
            let idx = d
                .servers
                .iter()
                .position(|s| s.id == id)
                .ok_or_else(|| AppError::NotFound(format!("servidor {id}")))?;
            let src = d.servers[idx].clone();
            let names: HashSet<&str> = d.servers.iter().map(|s| s.name.as_str()).collect();
            let mut name = format!("{} (copia)", src.name);
            let mut n = 2;
            while names.contains(name.as_str()) {
                name = format!("{} (copia {n})", src.name);
                n += 1;
            }
            let copy = ServerProfile { id: new_id(), name, ..src };
            d.servers.insert(idx + 1, copy.clone());
            for p in &mut d.projects {
                if p.server_ids.iter().any(|s| s == id) {
                    p.server_ids.push(copy.id.clone());
                }
            }
            Ok(copy)
        })
    }

    pub fn save_project(&self, project: Project) -> AppResult<Project> {
        self.mutate(|d| {
            let known: HashSet<&str> = d.servers.iter().map(|s| s.id.as_str()).collect();
            let mut project = validate_project(project, &known)?;
            if project.id.is_empty() {
                project.id = new_id();
                d.projects.push(project.clone());
            } else if let Some(existing) = d.projects.iter_mut().find(|p| p.id == project.id) {
                *existing = project.clone();
            } else {
                d.projects.push(project.clone());
            }
            Ok(project)
        })
    }

    pub fn delete_project(&self, id: &str) -> AppResult<()> {
        self.mutate(|d| {
            let before = d.projects.len();
            d.projects.retain(|p| p.id != id);
            if d.projects.len() == before {
                return Err(AppError::NotFound(format!("proyecto {id}")));
            }
            Ok(())
        })
    }
}

fn validate_server(mut s: ServerProfile) -> AppResult<ServerProfile> {
    s.id = s.id.trim().to_string();
    s.name = s.name.trim().to_string();
    s.host = s.host.trim().to_string();
    s.username = s.username.trim().to_string();
    s.key_path = clean_opt(s.key_path);
    s.default_path = clean_opt(s.default_path);
    s.color = clean_opt(s.color);

    if s.name.is_empty() {
        return Err(AppError::Invalid("El nombre no puede estar vacío".into()));
    }
    if s.host.is_empty() {
        return Err(AppError::Invalid("El host no puede estar vacío".into()));
    }
    if s.host.chars().any(char::is_whitespace) {
        return Err(AppError::Invalid("El host no puede contener espacios".into()));
    }
    if s.username.is_empty() {
        return Err(AppError::Invalid("El usuario no puede estar vacío".into()));
    }
    if s.port == 0 {
        return Err(AppError::Invalid("El puerto debe estar entre 1 y 65535".into()));
    }
    match s.auth {
        AuthMethod::Key if s.key_path.is_none() => {
            return Err(AppError::Invalid("Indica la ruta de la llave SSH".into()));
        }
        AuthMethod::Key => {}
        // La ruta de llave solo tiene sentido con auth = key.
        AuthMethod::Password | AuthMethod::Agent => s.key_path = None,
    }
    Ok(s)
}

fn validate_project(mut p: Project, known_servers: &HashSet<&str>) -> AppResult<Project> {
    p.id = p.id.trim().to_string();
    p.name = p.name.trim().to_string();
    p.color = clean_opt(p.color);
    if p.name.is_empty() {
        return Err(AppError::Invalid("El nombre del proyecto no puede estar vacío".into()));
    }
    // Solo servidores existentes, sin duplicados, en el orden dado.
    let mut seen = HashSet::new();
    p.server_ids.retain(|id| known_servers.contains(id.as_str()) && seen.insert(id.clone()));
    // Marcadores válidos; su servidor pasa a formar parte del proyecto.
    let bookmarks: Vec<Bookmark> = p
        .bookmarks
        .into_iter()
        .filter_map(|mut b| {
            b.path = b.path.trim().to_string();
            b.label = clean_opt(b.label);
            (known_servers.contains(b.server_id.as_str()) && !b.path.is_empty()).then_some(b)
        })
        .collect();
    for b in &bookmarks {
        if seen.insert(b.server_id.clone()) {
            p.server_ids.push(b.server_id.clone());
        }
    }
    p.bookmarks = bookmarks;
    Ok(p)
}

/// Arregla datos leídos de disco: ids vacíos/duplicados y referencias colgantes.
fn repair(d: &mut ProfilesData) {
    let mut ids = HashSet::new();
    for s in &mut d.servers {
        if s.id.trim().is_empty() || !ids.insert(s.id.clone()) {
            s.id = new_id();
            ids.insert(s.id.clone());
        }
    }
    let mut pids = HashSet::new();
    for p in &mut d.projects {
        if p.id.trim().is_empty() || !pids.insert(p.id.clone()) {
            p.id = new_id();
            pids.insert(p.id.clone());
        }
        p.server_ids.retain(|id| ids.contains(id));
        p.bookmarks.retain(|b| ids.contains(&b.server_id));
    }
}

// ───────────────────────── Ajustes ─────────────────────────

pub struct SettingsStore {
    path: Option<PathBuf>,
    data: RwLock<Settings>,
}

impl SettingsStore {
    /// Lee ~/.config/terview/settings.json (o valores por defecto).
    pub fn load() -> Self {
        match fsutil::config_dir() {
            Some(dir) => Self::load_from(dir.join("settings.json")),
            None => {
                log::error!("No hay carpeta de configuración: los ajustes no se guardarán");
                SettingsStore { path: None, data: RwLock::new(Settings::default()) }
            }
        }
    }

    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let s: Settings = fsutil::read_json_or_default(&path);
        SettingsStore { path: Some(path), data: RwLock::new(sanitize_settings(s)) }
    }

    pub fn get(&self) -> Settings {
        read_lock(&self.data).clone()
    }

    /// Sanea, guarda en disco y devuelve los ajustes efectivos.
    pub fn save(&self, settings: Settings) -> AppResult<Settings> {
        let s = sanitize_settings(settings);
        let mut guard = write_lock(&self.data);
        match &self.path {
            Some(p) => fsutil::write_json_atomic(p, &s)?,
            None => return Err(no_config_dir()),
        }
        *guard = s.clone();
        Ok(s)
    }
}

fn sanitize_settings(mut s: Settings) -> Settings {
    let def = Settings::default();
    if !matches!(s.theme.as_str(), "dark" | "light" | "system") {
        s.theme = def.theme;
    }
    s.terminal_font_size = s.terminal_font_size.clamp(8, 40);
    if s.terminal_font_family.trim().is_empty() {
        s.terminal_font_family = def.terminal_font_family;
    }
    s.transfer_concurrency = s.transfer_concurrency.clamp(1, 8);
    s.editor_max_bytes = s.editor_max_bytes.clamp(64 * 1024, 200 * 1024 * 1024);
    s.layout.retain(|_, v| v.iter().all(|x| x.is_finite()));
    if !lock::LOCK_MINUTES.contains(&s.lock_minutes) {
        s.lock_minutes = def.lock_minutes;
    }
    s
}

// ───────────────────────── Comandos ─────────────────────────

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("tarea interna interrumpida: {e}")))?
}

#[tauri::command]
pub async fn profiles_load(store: State<'_, ProfileStore>) -> AppResult<ProfilesData> {
    Ok(store.data())
}

/// Crea o actualiza. Si `server.id` está vacío se asigna uno nuevo.
/// `secret`: Some(x) guarda x en el llavero (contraseña o frase de la llave); None no lo toca.
/// Some("") borra el secreto guardado. Si el llavero falla, el servidor queda guardado igual
/// y se devuelve el error `Keyring`.
#[tauri::command]
pub async fn profiles_save_server(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    server: ServerProfile,
    secret: Option<String>,
) -> AppResult<ServerProfile> {
    let saved = store.save_server(server)?;
    sync_ssh_config(&app).await;
    if let Some(secret) = secret {
        let id = saved.id.clone();
        blocking(move || {
            if secret.is_empty() {
                secrets::delete_secret(&id)
            } else {
                secrets::set_secret(&id, &secret)
            }
        })
        .await?;
    }
    Ok(saved)
}

/// Borra el servidor, su secreto y sus referencias en proyectos.
#[tauri::command]
pub async fn profiles_delete_server(app: AppHandle, store: State<'_, ProfileStore>, id: String) -> AppResult<()> {
    store.delete_server(&id)?;
    sync_ssh_config(&app).await;
    // El servidor ya no existe: si el llavero no está disponible solo lo registramos.
    if let Err(e) = blocking(move || secrets::delete_secret(&id)).await {
        log::warn!("No se pudo borrar el secreto del servidor: {e}");
    }
    Ok(())
}

#[tauri::command]
pub async fn profiles_save_project(store: State<'_, ProfileStore>, project: Project) -> AppResult<Project> {
    store.save_project(project)
}

#[tauri::command]
pub async fn profiles_delete_project(store: State<'_, ProfileStore>, id: String) -> AppResult<()> {
    store.delete_project(&id)
}

#[tauri::command]
pub async fn profiles_has_secret(id: String) -> AppResult<bool> {
    blocking(move || secrets::get_secret(&id).map(|s| s.is_some())).await
}

/// Some(x) guarda, None borra.
#[tauri::command]
pub async fn profiles_set_secret(id: String, secret: Option<String>) -> AppResult<()> {
    blocking(move || match secret {
        Some(s) if !s.is_empty() => secrets::set_secret(&id, &s),
        _ => secrets::delete_secret(&id),
    })
    .await
}

#[tauri::command]
pub async fn settings_load(store: State<'_, SettingsStore>) -> AppResult<Settings> {
    Ok(store.get())
}

#[tauri::command]
pub async fn settings_save(app: AppHandle, store: State<'_, SettingsStore>, settings: Settings) -> AppResult<Settings> {
    let was_synced = store.get().ssh_config_sync;
    let saved = store.save(settings)?;
    // Al activar «Mantener sincronizado» exportamos ya.
    if saved.ssh_config_sync && !was_synced {
        sync_ssh_config(&app).await;
    }
    Ok(saved)
}

// ───────── Nuevos (ronda 2) — DUEÑO: agente Almacenamiento ─────────

/// Exporta a ~/.ssh/config si «Mantener sincronizado» está activo. Nunca falla: registra el error.
async fn sync_ssh_config(app: &AppHandle) {
    if !app.state::<SettingsStore>().get().ssh_config_sync {
        return;
    }
    let app = app.clone();
    let r = blocking(move || {
        let env = ssh_config::SshEnv::user()?;
        let store = app.state::<ProfileStore>();
        ssh_config::export_with(&env, || store.data().servers)
    })
    .await;
    if let Err(e) = r {
        log::error!("No se pudo sincronizar ~/.ssh/config: {e}");
    }
}

/// Copia un servidor (nombre "… (copia)") y su secreto del llavero. Devuelve la copia.
#[tauri::command]
pub async fn profiles_duplicate_server(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    id: String,
) -> AppResult<ServerProfile> {
    let copy = store.duplicate_server(&id)?;
    sync_ssh_config(&app).await;
    let new_id = copy.id.clone();
    // La copia ya existe: si el llavero falla solo lo registramos (se pedirá la contraseña al conectar).
    let r = blocking(move || match secrets::get_secret(&id)? {
        Some(secret) => secrets::set_secret(&new_id, &secret),
        None => Ok(()),
    })
    .await;
    if let Err(e) = r {
        log::warn!("No se pudo copiar el secreto del servidor duplicado: {e}");
    }
    Ok(copy)
}

/// Escribe/actualiza el bloque marcado de TerView en ~/.ssh/config.
#[tauri::command]
pub async fn profiles_export_ssh_config(app: AppHandle) -> AppResult<SshConfigExport> {
    blocking(move || {
        let env = ssh_config::SshEnv::user()?;
        let store = app.state::<ProfileStore>();
        ssh_config::export_with(&env, || store.data().servers)
    })
    .await
}

/// Lee ~/.ssh/config y devuelve servidores candidatos (id "", sin guardar), omitiendo los ya existentes.
#[tauri::command]
pub async fn profiles_import_ssh_config(store: State<'_, ProfileStore>) -> AppResult<Vec<ServerProfile>> {
    let existing = store.data().servers;
    blocking(move || {
        let env = ssh_config::SshEnv::user()?;
        ssh_config::import(&env, &existing)
    })
    .await
}
