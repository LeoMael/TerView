//! Conectar + autenticar. Independiente de la interfaz y del almacenamiento
//! para poder probarlo directamente contra un servidor de pruebas.
//! DUEÑO: agente SSH.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh::MethodKind;
use tokio::net::TcpStream;

use crate::error::{AppError, AppResult};
use crate::ssh::handler::{ClientHandler, HostKeyPolicy, HostKeyVerdict, SharedState};
use crate::ssh::{known_hosts, SshSession};
use crate::types::{AuthMethod, ServerProfile, SessionInfo};

/// Secretos disponibles para autenticar (ya resueltos desde el llavero o la interfaz).
#[derive(Default, Clone)]
pub struct Credentials {
    pub password: Option<String>,
    pub passphrase: Option<String>,
    /// Código 2FA/OTP para keyboard-interactive (de un solo uso: no se reutiliza al reconectar).
    pub otp: Option<String>,
}

/// Tiempo máximo para resolver DNS + abrir TCP.
const TCP_TIMEOUT: Duration = Duration::from_secs(15);
/// Tiempo máximo para la negociación SSH (banner, kex, huella).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Tiempo máximo para toda la autenticación.
const AUTH_TIMEOUT: Duration = Duration::from_secs(60);

// Mensajes exactos de `AuthFailed`: `ssh_connect` los usa para distinguirlos de otros rechazos.

/// Mensaje (exacto) de `AuthFailed` cuando el servidor rechaza la contraseña.
pub const WRONG_PASSWORD_MSG: &str = "usuario o contraseña incorrectos";
/// Mensaje (exacto) de `AuthFailed` cuando la frase de la llave es incorrecta.
pub const WRONG_PASSPHRASE_MSG: &str = "la frase de la llave privada es incorrecta";
/// Mensaje (exacto) de `AuthFailed` cuando el servidor rechaza el código 2FA/OTP.
pub const WRONG_OTP_MSG: &str = "el código de verificación es incorrecto o caducó";

/// Intervalo de la señal de vida por defecto (s). Caída detectada tras `KEEPALIVE_MAX` sin respuesta.
pub const DEFAULT_KEEPALIVE_SECS: u16 = 10;
/// Señales de vida sin respuesta antes de dar la conexión por perdida.
const KEEPALIVE_MAX: usize = 3;

/// Intervalo de la señal de vida a partir del ajuste `keepaliveSecs` (acotado a 5..=120 s).
pub fn keepalive_interval(secs: u16) -> Duration {
    Duration::from_secs(u64::from(secs.clamp(5, 120)))
}

/// Abre la conexión TCP, verifica la huella contra `~/.ssh/known_hosts` y autentica.
/// (`ssh_connect` usa `connect_policy` para quedarse además con el motivo de cierre.)
#[allow(dead_code)]
pub async fn connect(profile: &ServerProfile, creds: Credentials) -> AppResult<SshSession> {
    let path = known_hosts::default_path()?;
    connect_with(profile, creds, &path).await
}

/// Igual que `connect` pero con un known_hosts concreto (tests).
#[allow(dead_code)]
pub async fn connect_with(
    profile: &ServerProfile,
    creds: Credentials,
    known_hosts_path: &Path,
) -> AppResult<SshSession> {
    connect_policy(
        profile,
        creds,
        HostKeyPolicy::KnownHosts(known_hosts_path.to_path_buf()),
    )
    .await
    .map(|(s, _)| s)
}

fn client_config(keepalive: Duration) -> client::Config {
    client::Config {
        keepalive_interval: Some(keepalive),
        keepalive_max: KEEPALIVE_MAX,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    }
}

/// Conecta y devuelve también el estado compartido del manejador
/// (para conocer luego el motivo de desconexión). Señal de vida por defecto.
pub(crate) async fn connect_policy(
    profile: &ServerProfile,
    creds: Credentials,
    policy: HostKeyPolicy,
) -> AppResult<(SshSession, Arc<Mutex<SharedState>>)> {
    connect_full(
        profile,
        creds,
        policy,
        keepalive_interval(DEFAULT_KEEPALIVE_SECS),
    )
    .await
}

/// Conexión completa con un intervalo de señal de vida concreto.
pub(crate) async fn connect_full(
    profile: &ServerProfile,
    creds: Credentials,
    policy: HostKeyPolicy,
    keepalive: Duration,
) -> AppResult<(SshSession, Arc<Mutex<SharedState>>)> {
    let host = profile.host.trim().to_string();
    if host.is_empty() {
        return Err(AppError::Invalid("El servidor no tiene host configurado".into()));
    }
    if profile.username.trim().is_empty() {
        return Err(AppError::Invalid("El servidor no tiene usuario configurado".into()));
    }
    let port = if profile.port == 0 { 22 } else { profile.port };

    // Preparar la llave antes de abrir la red: errores de archivo/frase llegan antes.
    let key = match profile.auth {
        AuthMethod::Key => Some(load_key(profile, creds.passphrase.as_deref()).await?),
        AuthMethod::Password if creds.password.is_none() => return Err(AppError::NeedsPassword),
        _ => None,
    };

    let stream = tcp_connect(&host, port).await?;
    let handler = ClientHandler::new(&host, port, policy);
    let shared = handler.shared.clone();
    let config = Arc::new(client_config(keepalive));

    let mut handle =
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, client::connect_stream(config, stream, handler))
            .await
        {
            Err(_) => {
                return Err(AppError::Network(format!(
                    "{host}:{port} no completó la negociación SSH a tiempo"
                )));
            }
            Ok(Err(e)) => return Err(handshake_error(&shared, &host, port, e)),
            Ok(Ok(h)) => h,
        };

    let user = profile.username.trim().to_string();
    let mut ctx = AuthCtx {
        user: &user,
        password: creds.password.as_deref().filter(|p| !p.is_empty()),
        otp: creds.otp.as_deref().map(str::trim).filter(|p| !p.is_empty()),
        key: key.map(Arc::new),
        used_password: false,
        used_key: false,
        ki_rounds: 0,
    };
    let auth = authenticate(&mut handle, profile.auth, &mut ctx);
    let res = match tokio::time::timeout(AUTH_TIMEOUT, auth).await {
        Ok(r) => r,
        Err(_) => Err(AppError::Network(
            "El servidor tardó demasiado en responder a la autenticación".into(),
        )),
    };
    if let Err(e) = res {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "es")
            .await;
        return Err(e);
    }

    let info = SessionInfo {
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: profile.id.clone(),
        name: if profile.name.trim().is_empty() {
            format!("{user}@{host}")
        } else {
            profile.name.clone()
        },
        host,
        port,
        username: user,
        connected_at: now_ms(),
    };
    Ok((SshSession { info, handle }, shared))
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ───────────────────────── Red ─────────────────────────

async fn tcp_connect(host: &str, port: u16) -> AppResult<TcpStream> {
    let fut = async {
        let addrs: Vec<SocketAddr> = match tokio::net::lookup_host((host, port)).await {
            Ok(a) => a.collect(),
            Err(e) => {
                log::debug!("DNS {host}: {e}");
                return Err(AppError::Network(format!(
                    "No se encontró el servidor «{host}». Revisa el nombre o tu conexión a internet"
                )));
            }
        };
        if addrs.is_empty() {
            return Err(AppError::Network(format!(
                "No se encontró el servidor «{host}»"
            )));
        }
        let mut last: Option<std::io::Error> = None;
        for addr in &addrs {
            match TcpStream::connect(addr).await {
                Ok(s) => return Ok(s),
                Err(e) => last = Some(e),
            }
        }
        Err(io_connect_error(host, port, last))
    };
    match tokio::time::timeout(TCP_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(AppError::Network(format!(
            "Tiempo de espera agotado al conectar con {host}:{port} (el servidor no responde o un cortafuegos bloquea el puerto)"
        ))),
    }
}

fn io_connect_error(host: &str, port: u16, e: Option<std::io::Error>) -> AppError {
    use std::io::ErrorKind::*;
    let Some(e) = e else {
        return AppError::Network(format!("No se pudo conectar con {host}:{port}"));
    };
    let msg = match e.kind() {
        ConnectionRefused => format!(
            "{host} rechazó la conexión en el puerto {port} (¿está activo el servicio SSH y el puerto es correcto?)"
        ),
        TimedOut => format!("Tiempo de espera agotado al conectar con {host}:{port}"),
        HostUnreachable | NetworkUnreachable => {
            format!("No hay ruta hasta {host} (revisa tu red o VPN)")
        }
        PermissionDenied => format!("El sistema no permitió conectar con {host}:{port}"),
        _ => format!("No se pudo conectar con {host}:{port}: {e}"),
    };
    AppError::Network(msg)
}

fn handshake_error(
    shared: &Arc<Mutex<SharedState>>,
    host: &str,
    port: u16,
    e: russh::Error,
) -> AppError {
    let verdict = shared.lock().ok().and_then(|s| s.verdict.clone());
    match verdict {
        Some(HostKeyVerdict::Unknown(info)) => return AppError::HostKeyUnknown(info),
        Some(HostKeyVerdict::Changed(info)) => return AppError::HostKeyChanged(info),
        Some(HostKeyVerdict::Error(msg)) => return AppError::Io(msg),
        _ => {}
    }
    log::warn!("negociación SSH con {host}:{port} falló: {e:?}");
    match e {
        russh::Error::Version => AppError::Network(format!(
            "{host}:{port} no parece un servidor SSH"
        )),
        russh::Error::NoCommonAlgo { kind, .. } => AppError::Ssh(format!(
            "El servidor no tiene algoritmos compatibles ({kind:?})"
        )),
        russh::Error::HUP | russh::Error::Disconnect | russh::Error::IO(_) => {
            AppError::Network(format!(
                "{host}:{port} cerró la conexión durante la negociación SSH"
            ))
        }
        other => AppError::Ssh(format!("Falló la negociación SSH: {other}")),
    }
}

// ───────────────────────── Autenticación ─────────────────────────

fn methods_text(m: &russh::MethodSet) -> String {
    let v: Vec<&'static str> = m.iter().map(<&'static str>::from).collect();
    if v.is_empty() {
        "ninguno".into()
    } else {
        v.join(", ")
    }
}

/// Estado de la autenticación (puede encadenar varios métodos: "partial success").
struct AuthCtx<'a> {
    user: &'a str,
    password: Option<&'a str>,
    otp: Option<&'a str>,
    key: Option<Arc<russh::keys::PrivateKey>>,
    used_password: bool,
    used_key: bool,
    ki_rounds: u8,
}

/// Resultado de un método de autenticación aceptado.
enum Step {
    /// Autenticado.
    Done,
    /// El método se aceptó pero el servidor exige otro (p. ej. llave + código).
    Partial(russh::MethodSet),
}

fn second_method_error(remaining: &russh::MethodSet) -> AppError {
    AppError::AuthFailed(format!(
        "el servidor exige un segundo método de autenticación ({})",
        methods_text(remaining)
    ))
}

/// Autentica con el método del perfil y, si el servidor lo pide, con los siguientes.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    method: AuthMethod,
    ctx: &mut AuthCtx<'_>,
) -> AppResult<()> {
    let mut step = match method {
        AuthMethod::Password => auth_password(handle, ctx).await?,
        AuthMethod::Key => auth_key(handle, ctx).await?,
        AuthMethod::Agent => auth_agent(handle, ctx.user).await?,
    };
    for _ in 0..4 {
        match step {
            Step::Done => return Ok(()),
            Step::Partial(remaining) => step = next_method(handle, ctx, &remaining).await?,
        }
    }
    Err(AppError::AuthFailed(
        "el servidor no terminó la autenticación (demasiados pasos)".into(),
    ))
}

/// Tras un "partial success": elige el siguiente método que podemos ofrecer.
async fn next_method(
    handle: &mut Handle<ClientHandler>,
    ctx: &mut AuthCtx<'_>,
    remaining: &russh::MethodSet,
) -> AppResult<Step> {
    if remaining.contains(&MethodKind::KeyboardInteractive) && ctx.ki_rounds < 2 {
        return auth_keyboard_interactive(handle, ctx).await;
    }
    if remaining.contains(&MethodKind::Password) && !ctx.used_password {
        if ctx.password.is_none() {
            return Err(AppError::NeedsPassword);
        }
        return auth_password(handle, ctx).await;
    }
    if remaining.contains(&MethodKind::PublicKey) && !ctx.used_key && ctx.key.is_some() {
        return auth_key(handle, ctx).await;
    }
    Err(second_method_error(remaining))
}

async fn auth_password(handle: &mut Handle<ClientHandler>, ctx: &mut AuthCtx<'_>) -> AppResult<Step> {
    let Some(password) = ctx.password else {
        return Err(AppError::NeedsPassword);
    };
    ctx.used_password = true;
    let res = handle.authenticate_password(ctx.user, password).await?;
    let remaining = match res {
        AuthResult::Success => return Ok(Step::Done),
        AuthResult::Failure {
            remaining_methods,
            partial_success: true,
        } => return Ok(Step::Partial(remaining_methods)),
        AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };
    // Muchos servidores (PAM) solo aceptan keyboard-interactive para contraseñas.
    if remaining.contains(&MethodKind::KeyboardInteractive) && ctx.ki_rounds == 0 {
        return auth_keyboard_interactive(handle, ctx).await;
    }
    if !remaining.contains(&MethodKind::Password) && !remaining.is_empty() {
        return Err(AppError::AuthFailed(format!(
            "el servidor no acepta contraseña para este usuario (métodos permitidos: {})",
            methods_text(&remaining)
        )));
    }
    Err(AppError::AuthFailed(WRONG_PASSWORD_MSG.into()))
}

/// Qué pide una pregunta de keyboard-interactive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptKind {
    /// La contraseña de la cuenta.
    Password,
    /// Un código de segundo factor (OTP, token, verificación…).
    Code,
}

/// Palabras que indican un código de segundo factor (se comprueban antes que las de contraseña:
/// "One-time password" es un código).
const CODE_WORDS: &[&str] = &[
    "code",
    "código",
    "codigo",
    "verification",
    "verificación",
    "verificacion",
    "otp",
    "token",
    "one-time",
    "one time",
    "2fa",
    "two-factor",
    "two factor",
    "authenticator",
    "passcode",
];
const PASSWORD_WORDS: &[&str] = &[
    "password",
    "contraseña",
    "contrasena",
    "passphrase",
    "passwort",
    "mot de passe",
    "senha",
];

/// Clasifica una pregunta del servidor. Sin pistas en el texto: con eco apagado se trata
/// como contraseña; con eco (p. ej. "Passcode or option (1-3)") como un dato a pedir al usuario.
pub(crate) fn classify_prompt(prompt: &str, echo: bool) -> PromptKind {
    let p = prompt.to_lowercase();
    if CODE_WORDS.iter().any(|w| p.contains(w)) {
        PromptKind::Code
    } else if PASSWORD_WORDS.iter().any(|w| p.contains(w)) || !echo {
        PromptKind::Password
    } else {
        PromptKind::Code
    }
}

/// Texto de la pregunta para mostrar al usuario (`NeedsOtp`).
fn prompt_text(prompt: &str) -> String {
    let t = prompt.trim();
    if t.is_empty() {
        "Código de verificación".to_string()
    } else {
        t.to_string()
    }
}

/// keyboard-interactive en varias rondas: contraseña y/o código 2FA.
async fn auth_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    ctx: &mut AuthCtx<'_>,
) -> AppResult<Step> {
    ctx.ki_rounds += 1;
    let mut resp = handle
        .authenticate_keyboard_interactive_start(ctx.user, None::<String>)
        .await?;
    let mut sent_password = false;
    let mut sent_code = false;
    for _ in 0..10 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(Step::Done),
            KeyboardInteractiveAuthResponse::Failure {
                partial_success: true,
                remaining_methods,
            } => return Ok(Step::Partial(remaining_methods)),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                let msg = if sent_code {
                    WRONG_OTP_MSG
                } else if sent_password || ctx.used_password {
                    // (también si el método "password" ya la había rechazado)
                    WRONG_PASSWORD_MSG
                } else {
                    "el servidor rechazó la autenticación interactiva"
                };
                return Err(AppError::AuthFailed(msg.into()));
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let mut answers = Vec::with_capacity(prompts.len());
                let (mut asked_password, mut asked_code) = (false, false);
                for p in &prompts {
                    match classify_prompt(&p.prompt, p.echo) {
                        PromptKind::Password => {
                            // Volver a pedirla en otra ronda = la anterior era incorrecta.
                            if sent_password {
                                return Err(AppError::AuthFailed(WRONG_PASSWORD_MSG.into()));
                            }
                            let Some(pw) = ctx.password else {
                                return Err(AppError::NeedsPassword);
                            };
                            asked_password = true;
                            answers.push(pw.to_string());
                        }
                        PromptKind::Code => {
                            if sent_code {
                                return Err(AppError::AuthFailed(WRONG_OTP_MSG.into()));
                            }
                            let Some(otp) = ctx.otp else {
                                return Err(AppError::NeedsOtp(prompt_text(&p.prompt)));
                            };
                            asked_code = true;
                            answers.push(otp.to_string());
                        }
                    }
                }
                sent_password |= asked_password;
                sent_code |= asked_code;
                resp = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
    Err(AppError::AuthFailed(
        "el servidor no terminó la autenticación interactiva".into(),
    ))
}

/// Expande `~` / `~/` al home del usuario.
pub fn expand_tilde(p: &str) -> PathBuf {
    let p = p.trim();
    let Some(home) = dirs::home_dir() else {
        return PathBuf::from(p);
    };
    if p == "~" {
        return home;
    }
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(p),
    }
}

async fn load_key(
    profile: &ServerProfile,
    passphrase: Option<&str>,
) -> AppResult<russh::keys::PrivateKey> {
    let raw = profile
        .key_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Invalid("No se indicó la ruta de la llave privada".into()))?;
    let path = expand_tilde(raw);
    let passphrase = passphrase.filter(|p| !p.is_empty()).map(str::to_string);
    tokio::task::spawn_blocking(move || load_key_blocking(&path, passphrase.as_deref()))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

fn load_key_blocking(path: &Path, passphrase: Option<&str>) -> AppResult<russh::keys::PrivateKey> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::Invalid(format!(
                "No existe la llave privada {}",
                path.display()
            )));
        }
        Err(e) => {
            return Err(AppError::Invalid(format!(
                "No se pudo leer la llave privada {}: {e}",
                path.display()
            )));
        }
    };
    if text.trim_start().starts_with("ssh-") || text.trim_start().starts_with("ecdsa-") {
        return Err(AppError::Invalid(format!(
            "{} es una llave pública; elige el archivo de la llave privada (sin .pub)",
            path.display()
        )));
    }
    match russh::keys::decode_secret_key(&text, passphrase) {
        Ok(k) => Ok(k),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(AppError::NeedsPassphrase),
        Err(e) => {
            if passphrase.is_some() {
                // ¿Es una llave cifrada? Entonces la frase está mal.
                match russh::keys::decode_secret_key(&text, None) {
                    Err(russh::keys::Error::KeyIsEncrypted) => {
                        return Err(AppError::AuthFailed(WRONG_PASSPHRASE_MSG.into()));
                    }
                    Err(_) if is_encrypted_pem(&text) => {
                        return Err(AppError::AuthFailed(WRONG_PASSPHRASE_MSG.into()));
                    }
                    _ => {}
                }
            } else if is_encrypted_pem(&text) {
                return Err(AppError::NeedsPassphrase);
            }
            Err(AppError::Invalid(format!(
                "No se pudo leer la llave privada {} (formato no soportado o archivo dañado): {e}",
                path.display()
            )))
        }
    }
}

fn is_encrypted_pem(text: &str) -> bool {
    text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") || text.contains("Proc-Type: 4,ENCRYPTED")
}

async fn auth_key(handle: &mut Handle<ClientHandler>, ctx: &mut AuthCtx<'_>) -> AppResult<Step> {
    let Some(key) = ctx.key.clone() else {
        return Err(AppError::Invalid("No se pudo cargar la llave".into()));
    };
    ctx.used_key = true;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let res = handle
        .authenticate_publickey(ctx.user, PrivateKeyWithHashAlg::new(key, hash))
        .await?;
    match res {
        AuthResult::Success => Ok(Step::Done),
        AuthResult::Failure {
            partial_success: true,
            remaining_methods,
        } => Ok(Step::Partial(remaining_methods)),
        AuthResult::Failure { .. } => Err(AppError::AuthFailed(
            "el servidor rechazó la llave (¿está en authorized_keys de ese usuario?)".into(),
        )),
    }
}

/// Cliente del agente SSH sobre el transporte que haya (socket Unix, tubería con nombre, Pageant).
type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// Tiempo máximo para abrir cada agente y leer sus llaves.
const AGENT_TIMEOUT: Duration = Duration::from_secs(5);

/// Tubería del agente de OpenSSH para Windows (servicio «ssh-agent»).
#[cfg(windows)]
const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Dónde buscar un agente SSH.
enum AgentSource {
    /// Socket Unix de `SSH_AUTH_SOCK`.
    #[cfg(unix)]
    Socket(String),
    /// Tubería con nombre de Windows (`SSH_AUTH_SOCK` o el agente de OpenSSH).
    #[cfg(windows)]
    Pipe(String),
    /// PuTTY Pageant (tubería moderna o, si no, mensajes de ventana).
    #[cfg(windows)]
    Pageant,
}

impl AgentSource {
    fn label(&self) -> String {
        match self {
            #[cfg(unix)]
            AgentSource::Socket(p) => format!("SSH_AUTH_SOCK ({p})"),
            #[cfg(windows)]
            AgentSource::Pipe(p) => format!("agente OpenSSH ({p})"),
            #[cfg(windows)]
            AgentSource::Pageant => "Pageant".into(),
        }
    }

    async fn connect(&self) -> Result<Agent, russh::keys::Error> {
        match self {
            #[cfg(unix)]
            AgentSource::Socket(p) => Ok(AgentClient::connect_uds(p).await?.dynamic()),
            #[cfg(windows)]
            AgentSource::Pipe(p) => Ok(AgentClient::connect_named_pipe(p).await?.dynamic()),
            #[cfg(windows)]
            AgentSource::Pageant => Ok(AgentClient::connect_pageant().await?.dynamic()),
        }
    }
}

fn auth_sock() -> Option<String> {
    std::env::var("SSH_AUTH_SOCK")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Agentes a probar, en orden.
/// - Unix: `SSH_AUTH_SOCK`.
/// - Windows: `SSH_AUTH_SOCK` si es una tubería (`\\.\pipe\…`), el agente de OpenSSH y Pageant.
fn agent_sources() -> Vec<AgentSource> {
    #[allow(unused_mut)]
    let mut out = Vec::new();
    #[cfg(unix)]
    if let Some(sock) = auth_sock() {
        out.push(AgentSource::Socket(sock));
    }
    #[cfg(windows)]
    {
        let sock = auth_sock();
        match &sock {
            Some(s) if s.starts_with(r"\\") => out.push(AgentSource::Pipe(s.clone())),
            // Git Bash/MSYS ponen aquí un socket de Cygwin, que no se puede abrir desde Windows.
            Some(s) => log::debug!("agente SSH: SSH_AUTH_SOCK={s} no es una tubería de Windows; se ignora"),
            None => {}
        }
        if !sock.is_some_and(|s| s.eq_ignore_ascii_case(OPENSSH_AGENT_PIPE)) {
            out.push(AgentSource::Pipe(OPENSSH_AGENT_PIPE.into()));
        }
        out.push(AgentSource::Pageant);
    }
    out
}

/// Abre el primer agente que responda y tenga llaves, y devuelve esas llaves.
async fn open_agent() -> AppResult<(Agent, Vec<AgentIdentity>)> {
    let sources = agent_sources();
    if sources.is_empty() {
        return Err(AppError::AuthFailed(
            "no hay un agente SSH disponible (SSH_AUTH_SOCK no está definido)".into(),
        ));
    }
    let mut found_empty = false;
    for source in sources {
        let attempt = async {
            let mut agent = source.connect().await?;
            let ids = agent.request_identities().await?;
            Ok::<_, russh::keys::Error>((agent, ids))
        };
        match tokio::time::timeout(AGENT_TIMEOUT, attempt).await {
            Ok(Ok((agent, ids))) if !ids.is_empty() => return Ok((agent, ids)),
            Ok(Ok(_)) => {
                log::debug!("agente SSH: {} no tiene llaves", source.label());
                found_empty = true;
            }
            Ok(Err(e)) => log::debug!("agente SSH: {}: {e}", source.label()),
            Err(_) => log::debug!("agente SSH: {} no respondió a tiempo", source.label()),
        }
    }
    if found_empty {
        return Err(AppError::AuthFailed(
            "el agente SSH no tiene llaves cargadas (usa ssh-add)".into(),
        ));
    }
    Err(AppError::AuthFailed(NO_AGENT_MSG.into()))
}

#[cfg(unix)]
const NO_AGENT_MSG: &str = "no hay un agente SSH disponible (SSH_AUTH_SOCK no está definido o no responde)";
#[cfg(windows)]
const NO_AGENT_MSG: &str = "no hay un agente SSH disponible: inicia el servicio «Agente de autenticación de \
OpenSSH» (ssh-agent) o Pageant y carga tu llave";
#[cfg(not(any(unix, windows)))]
const NO_AGENT_MSG: &str = "la autenticación con agente SSH no está soportada en este sistema";

async fn auth_agent(handle: &mut Handle<ClientHandler>, user: &str) -> AppResult<Step> {
    let (mut agent, identities) = open_agent().await?;
    if let Some(binding) = handle.agent_session_binding() {
        // Opcional: algunos agentes no soportan session-bind; no es fatal.
        if let Err(e) = agent.bind_session(binding, false).await {
            log::debug!("agente SSH: session-bind no soportado: {e}");
        }
    }
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for id in identities {
        let res = match &id {
            AgentIdentity::PublicKey { key, .. } => {
                let key: PublicKey = key.clone();
                handle
                    .authenticate_publickey_with(user, key, hash, &mut agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                handle
                    .authenticate_certificate_with(user, certificate.clone(), hash, &mut agent)
                    .await
            }
        };
        match res {
            Ok(AuthResult::Success) => return Ok(Step::Done),
            Ok(AuthResult::Failure {
                partial_success: true,
                remaining_methods,
            }) => return Ok(Step::Partial(remaining_methods)),
            Ok(AuthResult::Failure { .. }) => continue,
            Err(e) => {
                log::debug!("agente SSH: firma fallida: {e}");
                if handle.is_closed() {
                    return Err(AppError::Network("El servidor cerró la conexión".into()));
                }
                continue;
            }
        }
    }
    Err(AppError::AuthFailed(
        "el servidor rechazó todas las llaves del agente SSH".into(),
    ))
}

/// Utilidades SOLO para tests (usadas también por los tests de terminal, sftp y transfer).
#[cfg(test)]
pub mod testutil {
    use std::sync::Arc;

    use crate::ssh::handler::HostKeyPolicy;
    use crate::ssh::SshSession;
    use crate::types::{AuthMethod, ServerProfile};

    use super::Credentials;

    pub const TEST_HOST: &str = "127.0.0.1";
    pub const TEST_PORT: u16 = 2222;
    pub const TEST_USER: &str = "test";
    pub const TEST_PASSWORD: &str = "test123";

    /// Perfil de contraseña apuntando al servidor de pruebas.
    pub fn test_profile() -> ServerProfile {
        ServerProfile {
            id: "test-profile".into(),
            name: "Servidor de pruebas".into(),
            host: TEST_HOST.into(),
            port: TEST_PORT,
            username: TEST_USER.into(),
            auth: AuthMethod::Password,
            key_path: None,
            default_path: None,
            color: None,
            tmux: None,
        }
    }

    /// Conecta al servidor de pruebas aceptando su huella sin tocar ~/.ssh/known_hosts.
    /// DUEÑO: agente SSH (lo implementa primero que nada).
    pub async fn connect_test_server() -> Arc<SshSession> {
        match super::connect_policy(&test_profile(), test_creds(), HostKeyPolicy::AcceptAny).await {
            Ok((s, _)) => Arc::new(s),
            Err(e) => panic!("no se pudo conectar al servidor de pruebas {TEST_HOST}:{TEST_PORT}: {e}"),
        }
    }

    /// Credenciales del servidor de pruebas.
    pub fn test_creds() -> Credentials {
        Credentials {
            password: Some(TEST_PASSWORD.into()),
            ..Default::default()
        }
    }
}

#[cfg(test)]
#[path = "connect_tests.rs"]
mod tests;
