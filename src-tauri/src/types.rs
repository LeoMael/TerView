//! Tipos compartidos entre el motor y la interfaz.
//!
//! CONTRATO: cada tipo aquí tiene su espejo exacto en `src/api/types.ts`.
//! Si cambias uno, cambia el otro. Todos se serializan en camelCase.

use serde::{Deserialize, Serialize};

// ───────────────────────── Eventos globales (app.emit) ─────────────────────────

/// Payload: `Vec<TransferJob>` con los trabajos que cambiaron (máx. cada ~200 ms).
pub const EV_TRANSFER_UPDATE: &str = "transfer://update";
/// Payload: `Vec<String>` con ids de trabajos eliminados de la lista.
pub const EV_TRANSFER_REMOVED: &str = "transfer://removed";
/// Payload: `TerminalExit`.
pub const EV_TERMINAL_EXIT: &str = "terminal://exit";
/// Payload: `SessionClosed`. Se emite cuando una conexión SSH se cierra o se cae
/// (si la reconexión automática se rindió o está desactivada).
pub const EV_SESSION_CLOSED: &str = "session://closed";
/// Payload: `SessionReconnecting`. La conexión se cayó y se está reintentando (mismo sessionId).
pub const EV_SESSION_RECONNECTING: &str = "session://reconnecting";
/// Payload: `SessionInfo`. La reconexión funcionó: mismo sessionId, conexión nueva.
/// Terminales y canales SFTP anteriores murieron: hay que reabrirlos.
pub const EV_SESSION_RECONNECTED: &str = "session://reconnected";
/// Payload: `VaultStatus` (storage::vault). La bóveda se bloqueó, desbloqueó, creó o quitó.
/// Llega a todas las ventanas (también a las de editor aparte).
pub const EV_VAULT_STATE: &str = "vault://state";

// ───────────────────────── Servidores y proyectos ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    /// Vacío al crear; el motor asigna un UUID.
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Ruta a la llave privada (si auth = key). Acepta `~/`.
    pub key_path: Option<String>,
    /// Carpeta a abrir al conectar (si no, el home del usuario).
    pub default_path: Option<String>,
    /// Color de acento (hex) para reconocerlo en pestañas.
    pub color: Option<String>,
    /// Terminales persistentes (tmux) de este servidor. None = usar el ajuste general.
    #[serde(default)]
    pub tmux: Option<TmuxMode>,
    /// De dónde sale la contraseña de sudo (la guardada va en la bóveda o el llavero, nunca aquí).
    #[serde(default)]
    pub sudo_mode: SudoMode,
}

/// De dónde sale la contraseña de sudo de un servidor.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SudoMode {
    /// Pedirla cada vez (solo vive en memoria durante la conexión).
    #[default]
    Ask,
    /// Usar la contraseña de conexión guardada (solo si se entra con contraseña).
    Login,
    /// Usar la guardada aparte (id "<id>:sudo"); útil al entrar con llave SSH.
    Saved,
}

/// Cuándo abrir las terminales dentro de tmux (sobreviven a cortes de red y al cierre de la app).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TmuxMode {
    /// Usar tmux si el servidor lo tiene; si no, terminal normal sin avisos.
    #[default]
    Auto,
    /// Usar tmux siempre; si no está instalado se abre una terminal normal y se avisa.
    Always,
    /// Nunca usar tmux.
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub server_id: String,
    pub path: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Vacío al crear; el motor asigna un UUID.
    pub id: String,
    pub name: String,
    pub server_ids: Vec<String>,
    pub bookmarks: Vec<Bookmark>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesData {
    pub servers: Vec<ServerProfile>,
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "dark" | "light" | "system"
    pub theme: String,
    pub terminal_font_size: u16,
    pub terminal_font_family: String,
    /// Transferencias simultáneas (1..=8).
    pub transfer_concurrency: u8,
    pub show_hidden_files: bool,
    pub confirm_delete: bool,
    /// Tamaño máximo para abrir en el editor.
    pub editor_max_bytes: u64,
    /// Tamaños de paneles guardados por la interfaz (porcentajes), clave libre.
    pub layout: std::collections::HashMap<String, Vec<f64>>,
    /// Intervalo de la señal de vida SSH (s). Se da por caída tras 3 sin respuesta (5..=120).
    pub keepalive_secs: u16,
    /// Reintentar solo cuando se cae la conexión.
    pub auto_reconnect: bool,
    /// Intentos de reconexión automática (1..=20).
    pub reconnect_attempts: u8,
    pub editor_font_size: u16,
    pub editor_font_family: String,
    /// Mantener ~/.ssh/config sincronizado con los servidores guardados.
    pub ssh_config_sync: bool,
    /// Si el destino ya existe al transferir: "overwrite" | "skip" | "newer" (solo si el origen es más nuevo) | "ask" (preguntar).
    pub transfer_conflict: String,
    /// Terminales persistentes (tmux) por defecto. Cada servidor puede cambiarlo.
    pub terminal_tmux: TmuxMode,
    /// Bloquear TerView tras estos minutos sin uso (0 = nunca). Solo con bóveda: 5/10/15/30/60.
    pub lock_minutes: u32,
    /// El usuario dijo «Ahora no» a crear el PIN: no se vuelve a preguntar al iniciar.
    pub vault_prompt_dismissed: bool,
    /// Escáner de vulnerabilidades (fuentes, límite de imágenes, usuarios elegidos por servidor).
    pub vulnscan: crate::vulnscan::VulnScanSettings,
    /// Asistente de IA opcional (URL base y modelo; el token va en la bóveda o el llavero).
    pub ai: crate::ai::AiSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            terminal_font_size: 14,
            terminal_font_family: "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', monospace".into(),
            transfer_concurrency: 4,
            show_hidden_files: false,
            confirm_delete: true,
            editor_max_bytes: 5 * 1024 * 1024,
            layout: Default::default(),
            keepalive_secs: 10,
            auto_reconnect: true,
            reconnect_attempts: 5,
            editor_font_size: 14,
            editor_font_family: "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', monospace".into(),
            ssh_config_sync: false,
            transfer_conflict: "overwrite".into(),
            terminal_tmux: TmuxMode::Auto,
            lock_minutes: 15,
            vault_prompt_dismissed: false,
            vulnscan: Default::default(),
            ai: Default::default(),
        }
    }
}

// ───────────────────────── SSH ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    /// p. ej. "ssh-ed25519"
    pub algorithm: String,
    /// p. ej. "SHA256:abc..."
    pub fingerprint: String,
    /// Llave pública en formato OpenSSH; se devuelve tal cual en `ssh_trust_host`.
    pub key_openssh: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Unix ms
    pub connected_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReconnecting {
    pub session_id: String,
    /// Intento actual (1-based).
    pub attempt: u8,
    pub max_attempts: u8,
    /// Segundos hasta el próximo intento.
    pub next_retry_secs: u32,
    pub reason: String,
    /// Espera a que se desbloquee TerView para usar la contraseña guardada (no gasta intentos).
    #[serde(default)]
    pub waiting_unlock: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosed {
    pub session_id: String,
    pub reason: String,
}

// ───────────────────────── Terminal ─────────────────────────

/// Petición de abrir la terminal dentro de una sesión tmux (parámetro de `term_open`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxOpen {
    /// Nombre estable de la sesión tmux (`terview-…`). Si ya existe, se engancha a ella.
    pub name: String,
    /// Antes de engancharse, volcar el historial de la sesión (terminal recién creada en la interfaz).
    #[serde(default)]
    pub replay: bool,
}

/// Resultado de `term_open`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermOpened {
    pub term_id: String,
    /// Nombre de la sesión tmux si la terminal es persistente; None = shell normal.
    pub tmux: Option<String>,
    /// Se pidió tmux pero no está instalado en el servidor.
    pub tmux_missing: bool,
    /// Se pidió tmux y no se pudo usar: motivo en español (no instalado, versión antigua, error).
    pub tmux_problem: Option<String>,
}

/// Una sesión tmux de TerView que sigue viva en el servidor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    /// Creación y última actividad (segundos desde epoch).
    pub created: Option<u64>,
    pub activity: Option<u64>,
    /// Clientes enganchados ahora (0 = nadie la está mirando).
    pub attached: u32,
    pub windows: u32,
    /// Programa en primer plano (p. ej. "bash", "vim").
    pub command: String,
    /// Carpeta actual del programa.
    pub path: String,
}

/// Resultado de `term_tmux_list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxList {
    pub installed: bool,
    /// Salida de `tmux -V` (p. ej. "tmux 3.4").
    pub version: Option<String>,
    pub sessions: Vec<TmuxSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub term_id: String,
    pub code: Option<u32>,
}

// ───────────────────────── SFTP ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Ruta absoluta en el servidor.
    pub path: String,
    pub kind: FileKind,
    /// Si es symlink: true si apunta a una carpeta.
    pub is_dir_link: bool,
    pub size: u64,
    /// Unix segundos.
    pub modified: Option<u64>,
    /// Bits de permisos (p. ej. 0o755).
    pub permissions: Option<u32>,
    /// "drwxr-xr-x"
    pub permissions_str: String,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteText {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub modified: Option<u64>,
}

// ───────────────────────── Transferencias ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    Done,
    /// No se transfirió por la política de conflictos (ya existía / no era más nuevo).
    Skipped,
    Error,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: String,
    /// Todos los archivos de una misma acción (p. ej. arrastrar una carpeta) comparten batch.
    pub batch_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    /// Nombre a mostrar (ruta relativa dentro del lote, p. ej. "fotos/viaje/a.jpg").
    pub name: String,
    pub size: u64,
    pub transferred: u64,
    pub status: TransferStatus,
    pub error: Option<String>,
    /// Bytes por segundo (media reciente).
    pub speed: f64,
    /// Unix ms
    pub created_at: u64,
    pub finished_at: Option<u64>,
}

// ───────────────────────── ~/.ssh/config ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigExport {
    pub path: String,
    /// Servidores escritos en el bloque de TerView.
    pub count: usize,
}

// ───────────────────────── Biblioteca de comandos ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnippetScope {
    Global,
    Project,
    Server,
}

/// Comando guardado por el usuario ("Mis comandos"). Los del catálogo base viven en la interfaz.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// Vacío al crear; el motor asigna un UUID.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Plantilla con variables `{{nombre}}` o `{{nombre:defecto}}`.
    pub command: String,
    /// Categoría libre (p. ej. "Podman", "Mis scripts").
    pub category: String,
    pub scope: SnippetScope,
    /// id de proyecto o servidor si scope != global.
    pub scope_id: Option<String>,
    pub dangerous: bool,
    pub sudo: bool,
    pub read_only: bool,
}

/// Resultado de ejecutar un comando aparte (canal exec).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    /// true si la salida superó el límite y se recortó.
    pub truncated: bool,
    /// true si se cortó por tiempo.
    pub timed_out: bool,
}
