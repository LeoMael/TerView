//! sudo con contraseña para comandos que escribe otro (el asistente por MCP: `run_command` y
//! `run_catalog_command`; el usuario en «Ejecutar en varios servidores»: `exec_capture_sudo`).
//!
//! El canal exec no tiene terminal: sudo no puede preguntar la contraseña. Si el usuario aprueba un
//! comando con sudo, TerView consigue la contraseña igual que la interfaz (en memoria → guardada → otra
//! pestaña → diálogo; ver `src/features/privileges/lookup.ts`) y el comando se ejecuta dentro de un
//! envoltorio que se la da a sudo sin que el asistente la vea.
//!
//! Por qué un ayudante askpass y no `sudo -S` (como `elevate.ts` en la interfaz): allí TerView escribe
//! el script entero; aquí el comando es del asistente y puede tener varios `sudo` (`sudo a && sudo b`),
//! tuberías (`echo x | sudo tee /etc/y`, que usan el stdin del propio comando) o `sudo bash -c '…'`.
//! Cada sudo de un canal sin terminal vuelve a pedir la contraseña, así que hace falta dársela a todos
//! sin tocar su stdin. El envoltorio (POSIX sh):
//! 1. Lee la contraseña de la primera línea de su stdin (llega tras el script; nunca en la línea de
//!    comandos) y la comprueba UNA vez con `sudo -k -S -v`: si es incorrecta sale en seguida con una marca
//!    (un solo intento fallido: con -A sudo lo intentaría 3 veces y podría bloquear la cuenta).
//! 2. Crea una carpeta temporal 0700 (mktemp; primero en tmpfs) con un FIFO, el ayudante askpass y un
//!    `sudo` de paso que llama al de verdad con `-A`. La carpeta va delante en PATH, así que también lo
//!    usan `env sudo`, `xargs sudo`, `bash -c 'sudo …'`, etc.
//! 3. Un proceso hijo del envoltorio escribe la contraseña en el FIFO cada vez que el askpass lo abre: nunca
//!    queda escrita en un archivo, ni en el entorno ni en las variables del shell del comando. Con varios
//!    sudo a la vez (`sudo a | sudo b`) hay varios lectores: `read` o `head` leen a trozos y se repartirían
//!    los bytes de una línea, así que el askpass lee con UNA sola lectura (`dd bs=65536 count=1`, todo lo
//!    que haya en la tubería). Cada línea se escribe de una vez (menos de PIPE_BUF: atómica), así que esa
//!    lectura siempre trae líneas enteras; si llega entre dos escrituras y no trae nada, vuelve a abrir.
//! 4. Ejecuta el comando con el shell de login (como siempre) y al terminar (o con TERM/INT/HUP) detiene al
//!    escritor y borra la carpeta.
//!
//! No usa la contraseña: un `sudo` con ruta absoluta (`/usr/bin/sudo`), que no pasa por PATH.

use zeroize::Zeroizing;

/// Códigos de salida y marcas del envoltorio (iguales que `src/features/privileges/elevate.ts`, más dos).
pub const EXIT_NO_SUDO: u32 = 93;
pub const EXIT_NO_TEMP: u32 = 94;
pub const EXIT_TTY_REQUIRED: u32 = 95;
pub const EXIT_SUDO_DENIED: u32 = 96;
pub const EXIT_SUDO_BAD_PASSWORD: u32 = 97;

const MARK_NO_SUDO: &str = "__TV_NO_SUDO__";
const MARK_NO_TEMP: &str = "__TV_SUDO_NOTMP__";
const MARK_TTY: &str = "__TV_SUDO_TTY__";
const MARK_DENIED: &str = "__TV_SUDO_DENIED__";
const MARK_BAD: &str = "__TV_SUDO_BAD__";

/// Lo que se envía al servidor.
pub struct SudoExec {
    /// Comando del canal exec: arranque corto y fijo (sin secretos ni el comando del asistente).
    pub command: String,
    /// Entrada estándar: script + contraseña + salto de línea. ¡Contiene la contraseña! Se borra al soltarlo.
    pub stdin: Zeroizing<Vec<u8>>,
}

/// Comillas simples de sh.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Script del envoltorio (sin secretos): ejecuta `command` dando la contraseña (primera línea de stdin) a
/// cada sudo.
pub fn script(command: &str) -> String {
    let mut s = String::with_capacity(SCRIPT.len() + command.len() + 16);
    s.push_str("c=");
    s.push_str(&sh_quote(command));
    s.push('\n');
    s.push_str(SCRIPT);
    s
}

// Reglas: POSIX sh (dash, bash, busybox). La contraseña solo pasa por `read` y `printf`, que son internos
// del shell (no aparecen en `ps`). El askpass y el `sudo` de paso se escriben con here-docs entre comillas.
const SCRIPT: &str = r#"IFS= read -r p || p=
d= w=
tv_end() {
  if [ -n "$w" ]; then kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; fi
  if [ -n "$d" ]; then rm -rf "$d"; fi
}
trap tv_end EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
s=$(command -v sudo 2>/dev/null) || s=
case $s in /*) ;; *) echo __TV_NO_SUDO__ >&2; exit 93 ;; esac
case $s in *[!A-Za-z0-9/._+-]*) echo __TV_NO_SUDO__ >&2; exit 93 ;; esac
if ! e=$(printf '%s\n' "$p" | LC_ALL=C "$s" -k -S -p '' -v 2>&1 >/dev/null); then
  case $e in
    *tty*) echo __TV_SUDO_TTY__ >&2; exit 95 ;;
    *"may not run"*|*"not in the sudoers"*|*"not allowed"*) echo __TV_SUDO_DENIED__ >&2; exit 96 ;;
  esac
  echo __TV_SUDO_BAD__ >&2; exit 97
fi
e=
for b in "${XDG_RUNTIME_DIR:-}" /dev/shm "${TMPDIR:-/tmp}" /tmp "${HOME:-}"; do
  [ -n "$b" ] && [ -d "$b" ] && [ -w "$b" ] || continue
  d=$(mktemp -d "$b/.terview-sudo.XXXXXXXX" 2>/dev/null) || { d=; continue; }
  printf '#!/bin/sh\nexit 0\n' > "$d/a" 2>/dev/null && chmod 700 "$d/a" && "$d/a" 2>/dev/null && break
  rm -rf "$d"; d=
done
[ -n "$d" ] && mkfifo -m 600 "$d/p" 2>/dev/null && mkdir "$d/bin" || { echo __TV_SUDO_NOTMP__ >&2; exit 94; }
cat > "$d/a" <<'TV_EOF'
#!/bin/sh
l=
for i in 1 2 3 4 5 6 7 8 9 10; do
  l=$(dd bs=65536 count=1 < "${0%/*}/p" 2>/dev/null | head -n 1)
  [ -n "$l" ] && break
done
printf '%s\n' "$l"
TV_EOF
cat > "$d/bin/sudo" <<'TV_EOF'
#!/bin/sh
SUDO_ASKPASS=${0%/*/*}/a
export SUDO_ASKPASS
a=-A
for o do
  case $o in
    --) break ;;
    --stdin) a= ;;
    --*) ;;
    -*S*) a= ;;
    -*) ;;
    *) break ;;
  esac
done
TV_EOF
printf 'exec %s $a "$@"\n' "$s" >> "$d/bin/sudo"
chmod 700 "$d/a" "$d/bin/sudo" || { echo __TV_SUDO_NOTMP__ >&2; exit 94; }
( trap '' PIPE
  while [ -p "$d/p" ]; do printf '%s\n' "$p" > "$d/p" || :; done ) </dev/null >/dev/null 2>&1 &
w=$!
p=
unset p
PATH=$d/bin:$PATH
export PATH
"${SHELL:-/bin/sh}" -c "$c" </dev/null
exit $?
"#;

/// Prepara la ejecución de `command` con la contraseña de sudo. Error si la contraseña no se puede enviar.
pub fn wrap(command: &str, password: &str) -> Result<SudoExec, String> {
    if password.is_empty() {
        return Err("La contraseña de sudo está vacía.".into());
    }
    if password.contains(['\n', '\r', '\0']) {
        return Err("La contraseña de sudo tiene saltos de línea: no se puede enviar a sudo.".into());
    }
    // Cada línea del FIFO tiene que caber en una escritura atómica (PIPE_BUF, 512 bytes como mínimo POSIX).
    if password.len() > 500 {
        return Err("La contraseña de sudo es demasiado larga para enviarla a sudo.".into());
    }
    let script = format!("{}\n", script(command));
    let command = format!("sh -c 'eval \"$(dd bs=1 count={} 2>/dev/null)\"'", script.len());
    let mut stdin = Zeroizing::new(Vec::with_capacity(script.len() + password.len() + 1));
    stdin.extend_from_slice(script.as_bytes());
    stdin.extend_from_slice(password.as_bytes());
    stdin.push(b'\n');
    Ok(SudoExec { command, stdin })
}

/// Fallo del envoltorio (antes de ejecutar el comando del asistente).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SudoFailure {
    BadPassword,
    Denied,
    TtyRequired,
    NoTemp,
    NoSudo,
}

impl SudoFailure {
    /// Nombre para la interfaz (igual que `ElevationFailure` de `elevate.ts`, más "no-temp" y "no-sudo").
    pub fn key(self) -> &'static str {
        match self {
            SudoFailure::BadPassword => "bad-password",
            SudoFailure::Denied => "denied",
            SudoFailure::TtyRequired => "tty-required",
            SudoFailure::NoTemp => "no-temp",
            SudoFailure::NoSudo => "no-sudo",
        }
    }
}

/// Reconoce los fallos del envoltorio (por código y marca en stderr, como `elevationFailure`).
pub fn failure(exit_code: Option<u32>, stderr: &str) -> Option<SudoFailure> {
    let (f, mark) = match exit_code? {
        EXIT_SUDO_BAD_PASSWORD => (SudoFailure::BadPassword, MARK_BAD),
        EXIT_SUDO_DENIED => (SudoFailure::Denied, MARK_DENIED),
        EXIT_TTY_REQUIRED => (SudoFailure::TtyRequired, MARK_TTY),
        EXIT_NO_TEMP => (SudoFailure::NoTemp, MARK_NO_TEMP),
        EXIT_NO_SUDO => (SudoFailure::NoSudo, MARK_NO_SUDO),
        _ => return None,
    };
    stderr.contains(mark).then_some(f)
}

pub fn failure_message(f: SudoFailure, server: &str) -> String {
    match f {
        SudoFailure::BadPassword => format!(
            "Contraseña de sudo incorrecta en «{server}»: sudo la rechazó y no se ejecutó el comando. \
             TerView la olvidó y la pedirá al usuario la próxima vez."
        ),
        SudoFailure::Denied => format!("El usuario de «{server}» no tiene permiso para usar sudo: no se ejecutó el comando."),
        SudoFailure::TtyRequired => format!(
            "sudo exige una terminal en «{server}» (opción «requiretty» en sudoers): no se puede usar desde aquí."
        ),
        SudoFailure::NoTemp => format!(
            "No se pudo preparar sudo en «{server}»: no hay ninguna carpeta temporal donde se puedan ejecutar \
             archivos (mktemp y mkfifo)."
        ),
        SudoFailure::NoSudo => format!("sudo no está instalado en «{server}»."),
    }
}

/// Quita la contraseña de un texto (por si un comando la mostrara): nunca llega al asistente.
pub fn redact(text: &mut String, secret: &str) {
    if !secret.is_empty() && text.contains(secret) {
        *text = text.replace(secret, "********");
    }
}
