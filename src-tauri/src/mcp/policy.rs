//! Reglas de permiso del asistente (funciones puras, sin Tauri).
//!
//! - Cada servidor tiene un nivel de acceso: Sin acceso (por defecto), Solo lectura o Completo.
//! - Cada acción del asistente es de lectura o de cambio. Las lecturas pasan solas; los cambios
//!   piden permiso en SSHorus, salvo que el usuario haya dicho «Permitir siempre» a esa misma acción
//!   en ese servidor.
//! - Lo peligroso (`rm -rf`, `prune`, `sudo`, `reboot`… o un comando ⚠️ del catálogo) pide permiso
//!   SIEMPRE: no se puede recordar.
//! - «Aceptar automáticamente» (por servidor, solo con acceso Completo y SSHorus desbloqueado):
//!   `Changes` acepta los cambios normales; `All` también lo peligroso y sudo. Ver `decide_auto`.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Nivel de acceso del asistente a un servidor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    /// Sin acceso: el asistente ni siquiera ve el servidor.
    #[default]
    None,
    /// Solo lectura: listar, leer archivos y comandos 📊 de la biblioteca.
    Read,
    /// Completo: también cambios, siempre con tu permiso.
    Full,
}

impl Access {
    pub fn label(self) -> &'static str {
        match self {
            Access::None => "Sin acceso",
            Access::Read => "Solo lectura",
            Access::Full => "Completo",
        }
    }
}

/// Qué hace una acción.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// No cambia nada: pasa sin preguntar (si hay acceso).
    Read,
    /// Cambia algo (o usa la conexión de forma visible): pide permiso.
    Change,
}

/// Una acción concreta que el asistente quiere hacer en un servidor.
#[derive(Debug, Clone)]
pub struct Action {
    pub effect: Effect,
    /// Se permite también en servidores de solo lectura (p. ej. conectar o descargar a tu PC).
    pub allowed_on_read: bool,
    /// Motivos de peligro (vacío = no es peligrosa).
    pub danger: Vec<String>,
    /// Clave para «Permitir siempre» (herramienta + comando o ruta exactos).
    pub key: String,
}

impl Action {
    pub fn read(key: impl Into<String>) -> Self {
        Action { effect: Effect::Read, allowed_on_read: true, danger: Vec::new(), key: key.into() }
    }

    pub fn change(key: impl Into<String>) -> Self {
        Action { effect: Effect::Change, allowed_on_read: false, danger: Vec::new(), key: key.into() }
    }

    /// Cambio que también se permite en servidores de solo lectura (con permiso).
    pub fn change_on_read(key: impl Into<String>) -> Self {
        Action { allowed_on_read: true, ..Action::change(key) }
    }

    pub fn with_danger(mut self, reasons: Vec<String>) -> Self {
        self.danger = reasons;
        self
    }
}

/// Modo «Aceptar automáticamente» de un servidor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoLevel {
    /// Apagado: se pregunta como siempre.
    #[default]
    Off,
    /// Los cambios normales (lo que no es peligroso) pasan solos.
    Changes,
    /// Todo pasa solo, también lo peligroso y sudo.
    All,
}

/// Modo automático temporal (solo en memoria). `until` = Unix ms en que se apaga; None = hasta
/// cerrar SSHorus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoGrant {
    pub level: AutoLevel,
    pub until: Option<u64>,
}

impl AutoGrant {
    pub fn active(&self, now: u64) -> bool {
        self.level != AutoLevel::Off && self.until.is_none_or(|u| now < u)
    }
}

/// Nivel automático que vale ahora: el temporal (si no caducó) manda sobre el guardado («siempre»).
/// Nunca con SSHorus bloqueado ni en servidores que no tengan acceso Completo.
pub fn effective_auto(access: Access, locked: bool, saved: Option<AutoLevel>, temp: Option<AutoGrant>, now: u64) -> AutoLevel {
    if locked || access != Access::Full {
        return AutoLevel::Off;
    }
    match temp {
        Some(g) if g.active(now) => g.level,
        _ => saved.unwrap_or_default(),
    }
}

/// Resultado de aplicar las reglas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Pasa sin preguntar. El texto dice por qué (para el registro).
    Allow(&'static str),
    /// Pasa sin preguntar por el modo «Aceptar automáticamente». `danger` = era peligrosa (o sudo).
    AutoAllow { danger: bool },
    /// Hay que preguntar en SSHorus. `can_remember` = se ofrece «Permitir siempre».
    Ask { can_remember: bool },
    /// No se permite. El texto es el motivo, listo para el asistente.
    Deny(String),
}

/// Motivo de registro: lectura automática.
pub const AUTO_READ: &str = "automático (lectura)";
/// Motivo de registro: regla «Permitir siempre» guardada.
pub const REMEMBERED: &str = "regla guardada («siempre»)";

pub fn no_access_msg(server: &str) -> String {
    format!(
        "El asistente no tiene acceso a «{server}». Puedes dárselo en SSHorus → Ajustes → Asistentes de IA (MCP)."
    )
}

pub fn read_only_msg(server: &str) -> String {
    format!(
        "«{server}» es de solo lectura para el asistente: no se permiten cambios. \
         Usa herramientas de lectura (list_dir, read_file, comandos 📊 de run_catalog_command) \
         o pide al usuario acceso completo en SSHorus."
    )
}

/// Motivo de registro: aceptado por el modo automático (cambio normal).
pub const AUTO_CHANGE: &str = "automático (modo «aceptar automáticamente»)";
/// Motivo de registro: aceptado por el modo automático aunque era peligroso o con sudo.
pub const AUTO_DANGER: &str = "automático (modo «todo», peligroso)";

/// Decide qué pasa con `action` en un servidor con `access` y estas reglas recordadas (sin modo
/// automático).
pub fn decide(server: &str, access: Access, action: &Action, remembered: &BTreeSet<String>) -> Verdict {
    decide_auto(server, access, action, remembered, AutoLevel::Off)
}

/// Como `decide`, con el modo automático que vale ahora (ver `effective_auto`, que ya lo apaga con
/// SSHorus bloqueado o sin acceso Completo). Sin acceso y solo lectura no cambian.
pub fn decide_auto(server: &str, access: Access, action: &Action, remembered: &BTreeSet<String>, auto: AutoLevel) -> Verdict {
    let auto = if access == Access::Full { auto } else { AutoLevel::Off };
    if access == Access::None {
        return Verdict::Deny(no_access_msg(server));
    }
    if action.effect == Effect::Read {
        return Verdict::Allow(AUTO_READ);
    }
    if access == Access::Read && !action.allowed_on_read {
        return Verdict::Deny(read_only_msg(server));
    }
    if !action.danger.is_empty() {
        if auto == AutoLevel::All {
            return Verdict::AutoAllow { danger: true };
        }
        return Verdict::Ask { can_remember: false };
    }
    if remembered.contains(&action.key) {
        return Verdict::Allow(REMEMBERED);
    }
    if auto != AutoLevel::Off {
        return Verdict::AutoAllow { danger: false };
    }
    Verdict::Ask { can_remember: true }
}

// ───────────────────────── Comandos peligrosos ─────────────────────────
// Igual que `src/features/multirun/danger.ts` (mismas reglas), más sudo/doas/su: un asistente
// nunca debería elevarse sin que lo veas.

/// Inicio de un comando: principio, tras ; & | ( ` $( o un espacio.
const W: &str = r"(?:^|[\s;&|(`]|\$\()";

fn rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        let raw: Vec<(String, &'static str)> = vec![
            (
                format!(
                    r"{W}rm\s+(?:[^;&|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*[rR]|--recursive\b[^;&|]*--force|--force\b[^;&|]*--recursive|-[rR]\s+-[fF]|-[fF]\s+-[rR])"
                ),
                "borrado recursivo (rm -rf)",
            ),
            (format!(r"{W}rm\s+(?:[^;&|]*\s)?-[a-zA-Z]*[rR]\b"), "borrado recursivo (rm -r)"),
            (format!(r"{W}(?:shutdown|poweroff|halt)\b"), "apaga el servidor"),
            (format!(r"{W}reboot\b"), "reinicia el servidor"),
            (format!(r"{W}init\s+[06]\b"), "apaga o reinicia el servidor"),
            (format!(r"{W}systemctl\s+(?:[^;&|]*\s)?(?:poweroff|reboot|halt|kexec)\b"), "apaga o reinicia el servidor"),
            (format!(r"{W}mkfs(?:\.[a-z0-9]+)?\b"), "formatea un disco (mkfs)"),
            (format!(r"{W}dd\s"), "escritura directa a disco (dd)"),
            (format!(r"{W}(?:fdisk|sfdisk|parted|wipefs|sgdisk)\b"), "modifica particiones"),
            (r"\bprune\b".to_string(), "borra recursos sin usar (prune)"),
            (format!(r"{W}(?:userdel|deluser|groupdel|delgroup)\b"), "elimina usuarios o grupos"),
            (format!(r"{W}(?:podman|docker)\s+(?:[^;&|]*\s)?(?:rm|rmi|kill)\b"), "elimina o detiene contenedores"),
            (
                format!(r"{W}(?:podman|docker)\s+(?:[^;&|]*\s)?(?:volume|network|system)\s+rm\b"),
                "elimina volúmenes o redes",
            ),
            (format!(r"{W}systemctl\s+(?:[^;&|]*\s)?(?:stop|disable|mask|kill)\b"), "detiene servicios"),
            (format!(r"{W}(?:killall|pkill)\b"), "mata procesos"),
            (format!(r"{W}kill\s+(?:-9|-KILL|-SIGKILL)\b"), "mata procesos"),
            (format!(r"{W}(?:chmod|chown|chgrp)\s+(?:[^;&|]*\s)?-[a-zA-Z]*R"), "cambia permisos de forma recursiva"),
            (
                format!(r"{W}(?:iptables|ip6tables|nft)\s+(?:[^;&|]*\s)?(?:-F|--flush|flush)\b"),
                "vacía el cortafuegos",
            ),
            (format!(r"{W}(?:truncate|shred)\b"), "vacía o destruye archivos"),
            (r">\s*/dev/(?:sd|nvme|vd|hd|xvd|mmcblk)".to_string(), "escribe directamente en un disco"),
            (format!(r"{W}(?:passwd|chpasswd)\b"), "cambia contraseñas"),
            (
                format!(
                    r"{W}(?:dnf|yum|apt|apt-get|apk|zypper|pacman)\s+(?:[^;&|]*\s)?(?:remove|erase|purge|autoremove|del|-R)\b"
                ),
                "desinstala paquetes",
            ),
            (
                format!(r"{W}git\s+(?:[^;&|]*\s)?(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+(?:[^;&|]*\s)?(?:-f|--force))"),
                "descarta cambios de git",
            ),
            (r":\(\)\s*\{\s*:\|:&\s*\};:".to_string(), "bomba de procesos"),
            (r"(?i)\bDROP\s+(?:DATABASE|TABLE|SCHEMA)\b".to_string(), "borra una base de datos"),
            // Solo en el MCP: elevarse siempre se pregunta.
            (format!(r"{W}(?:sudo|doas|pkexec)(?:\s|$)"), "usa sudo (permisos de administrador)"),
            (format!(r"{W}su(?:\s|$)"), "cambia de usuario (su)"),
        ];
        raw.into_iter()
            .filter_map(|(re, label)| match Regex::new(&re) {
                Ok(r) => Some((r, label)),
                Err(e) => {
                    log::error!("regla de peligro inválida ({label}): {e}");
                    None
                }
            })
            .collect()
    })
}

/// Motivos por los que el comando parece peligroso (sin repetir). Vacío = no lo parece.
pub fn danger_reasons(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (re, label) in rules() {
        if re.is_match(command) && !out.iter().any(|x| x == label) {
            out.push((*label).to_string());
        }
    }
    // «rm -rf» ya implica «rm -r».
    if out.iter().any(|x| x == "borrado recursivo (rm -rf)") {
        out.retain(|x| x != "borrado recursivo (rm -r)");
    }
    out
}

/// ¿El comando usa sudo? (la misma regla que «usa sudo» de `danger_reasons`, solo para sudo: doas y
/// pkexec solo aceptan la contraseña desde una terminal). Si lo usa, SSHorus le da la contraseña.
pub fn uses_sudo(command: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r"{W}sudo(?:\s|$)")).ok())
        .as_ref()
        .is_some_and(|re| re.is_match(command))
}

/// ¿El comando no termina solo (top, tail -f…)? Por el canal exec se cortaría por tiempo.
pub fn looks_interactive(command: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"{W}(?:top|htop|btop|watch|less|more|vi|vim|nano|man|ssh|mysql|psql|python3?|node|bash|sh|zsh)\s*$|{W}(?:tail|journalctl|podman\s+logs|docker\s+logs|kubectl\s+logs)\s+(?:[^;&|]*\s)?(?:-f|--follow)\b"
        ))
        .ok()
    })
    .as_ref()
    .is_some_and(|re| re.is_match(command.trim()))
}
