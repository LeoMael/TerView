// Cómo se ejecuta un script como root (directo, sudo/doas sin contraseña, sudo con contraseña por stdin).
// Funciones puras, sin React ni Tauri.
//
// Reglas de seguridad:
//  - Las contraseñas (de sudo y de usuarios) NUNCA van en la línea de comandos: viajan por stdin.
//  - El comando del canal exec es siempre el mismo arranque corto, sin comillas simples internas,
//    barras invertidas ni «!»: funciona con cualquier shell de login (bash, zsh, fish, tcsh…).
//    El script real llega por stdin: `dd` lee exactamente sus bytes y `sh` lo evalúa; lo que sigue en
//    stdin (contraseña de sudo, «usuario:clave»…) queda para el script.
//  - Con contraseña: primero `sudo -k -S -v` recibe SOLO la primera línea (si es incorrecta no consume
//    nada más), y después `sudo -k -S` (sin reutilizar credenciales: -k obliga a leer la contraseña, así
//    nunca pasa al comando) ejecuta el script interior; el resto de stdin llega a ese script.
//    Sin terminal, sudo no reutiliza el sello de tiempo entre canales: se envía en cada comando.
import { shQuote } from "../admin/shell";
import type { ElevationTool } from "./detect";

export type Elevation =
  /** Sin elevar (lecturas como el usuario conectado). */
  | { kind: "none" }
  /** Ya es root. */
  | { kind: "root" }
  /** sudo -n / doas -n. */
  | { kind: "nopasswd"; tool: ElevationTool }
  /** sudo -S con la contraseña por stdin. */
  | { kind: "password"; password: string };

/** Códigos de salida propios del envoltorio (el script interior no debería usarlos). */
export const EXIT_TTY_REQUIRED = 95;
export const EXIT_SUDO_DENIED = 96;
export const EXIT_SUDO_BAD_PASSWORD = 97;
export const EXIT_NEED_PASSWORD = 98;

const MARK = {
  [EXIT_TTY_REQUIRED]: "__TV_SUDO_TTY__",
  [EXIT_SUDO_DENIED]: "__TV_SUDO_DENIED__",
  [EXIT_SUDO_BAD_PASSWORD]: "__TV_SUDO_BAD__",
  [EXIT_NEED_PASSWORD]: "__TV_NEED_PASSWORD__",
} as const;

function fail(code: keyof typeof MARK): string {
  return `{ echo ${MARK[code]} >&2; exit ${code}; }`;
}

/** Envoltorio (sin secretos) que ejecuta `inner` según la elevación. Es lo que se muestra como «script completo». */
export function wrapScript(inner: string, el: Elevation): string {
  const q = shQuote(inner);
  switch (el.kind) {
    case "none":
      return inner;
    case "root":
      return `sh -c ${q}`;
    case "nopasswd":
      return [
        `if ! LC_ALL=C ${el.tool} -n true </dev/null >/dev/null 2>&1; then ${fail(EXIT_NEED_PASSWORD)}; fi`,
        `${el.tool} -n sh -c ${q}`,
      ].join("\n");
    case "password":
      return [
        "IFS= read -r p",
        `if ! e=$(printf '%s\\n' "$p" | LC_ALL=C sudo -k -S -p '' -v 2>&1 >/dev/null); then`,
        `  case "$e" in *tty*) ${fail(EXIT_TTY_REQUIRED)} ;; *"may not run"*|*"not in the sudoers"*|*"not allowed"*) ${fail(EXIT_SUDO_DENIED)} ;; esac`,
        `  ${fail(EXIT_SUDO_BAD_PASSWORD)}`,
        "fi",
        `{ printf '%s\\n' "$p"; cat; } | sudo -k -S -p '' sh -c ${q}`,
      ].join("\n");
  }
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface ExecRequest {
  /** Comando del canal exec (arranque corto, sin secretos). */
  command: string;
  /** Entrada estándar: script + [contraseña de sudo] + secreto. ¡Contiene secretos! */
  stdin: string;
  /** Script envuelto (sin secretos), para mostrar. */
  script: string;
}

/** Prepara la ejecución de `inner` con la elevación indicada. `secret` llega al stdin del script interior. */
export function buildExec(inner: string, el: Elevation, secret = ""): ExecRequest {
  const script = `${wrapScript(inner, el)}\n`;
  const command = `sh -c 'eval "$(dd bs=1 count=${utf8Length(script)} 2>/dev/null)"'`;
  const pass = el.kind === "password" ? `${el.password}\n` : "";
  return { command, stdin: script + pass + secret, script };
}

export type ElevationFailure = "bad-password" | "need-password" | "denied" | "tty-required";

/** Reconoce los fallos del envoltorio (por código y marca en stderr). */
export function elevationFailure(exitCode: number | null, stderr: string): ElevationFailure | null {
  if (exitCode === EXIT_SUDO_BAD_PASSWORD && stderr.includes(MARK[EXIT_SUDO_BAD_PASSWORD])) return "bad-password";
  if (exitCode === EXIT_NEED_PASSWORD && stderr.includes(MARK[EXIT_NEED_PASSWORD])) return "need-password";
  if (exitCode === EXIT_SUDO_DENIED && stderr.includes(MARK[EXIT_SUDO_DENIED])) return "denied";
  if (exitCode === EXIT_TTY_REQUIRED && stderr.includes(MARK[EXIT_TTY_REQUIRED])) return "tty-required";
  return null;
}

export function elevationFailureMessage(f: ElevationFailure): string {
  switch (f) {
    case "bad-password":
      return "La contraseña de sudo no es correcta";
    case "need-password":
      return "sudo pide contraseña en este servidor";
    case "denied":
      return "Tu usuario no tiene permiso para usar sudo en este servidor";
    case "tty-required":
      return "sudo exige una terminal (opción «requiretty» en sudoers): no se puede usar desde aquí";
  }
}
