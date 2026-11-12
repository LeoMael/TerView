// Utilidades de shell para la administración del servidor (funciones puras, sin React ni Tauri).

/**
 * Cita un argumento para un shell POSIX (sh, dash, ash, bash): `'…'` con las comillas simples internas
 * como `'\''`. Siempre cita, aunque no haga falta: el resultado es un único argumento literal.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Une argumentos citándolos todos. */
export function shJoin(args: string[]): string {
  return args.map(shQuote).join(" ");
}

/** Nombres de usuario y de grupo aceptados (los mismos que recomienda shadow-utils). */
export const NAME_RE = /^[a-z_][a-z0-9_-]*$/;
export const NAME_MAX = 32;

/** Devuelve un mensaje de error o null si el nombre es válido. */
export function validateName(name: string, what: "usuario" | "grupo" = "usuario"): string | null {
  if (!name) return `Escribe el nombre del ${what}`;
  if (name.length > NAME_MAX) return `Máximo ${NAME_MAX} caracteres`;
  if (!NAME_RE.test(name)) return "Solo minúsculas, números, «_» y «-»; debe empezar por letra o «_»";
  return null;
}

/** Nombre completo (GECOS): sin «:» (separador de /etc/passwd), saltos de línea ni comas (subcampos). */
export function validateFullName(s: string): string | null {
  if (/[:\n\r,]/.test(s)) return "El nombre completo no puede contener «:», «,» ni saltos de línea";
  if (s.length > 100) return "Máximo 100 caracteres";
  return null;
}

/** Contraseña para un usuario: no vacía, sin «:» al principio del campo ni saltos de línea (chpasswd lee líneas). */
export function validatePassword(s: string): string | null {
  if (!s) return "Escribe una contraseña";
  if (/[\n\r]/.test(s)) return "La contraseña no puede contener saltos de línea";
  if (s.length < 8) return "Usa al menos 8 caracteres";
  return null;
}

/** Shell: ruta absoluta sin espacios ni caracteres raros. */
export function validateShell(s: string): string | null {
  if (!/^\/[A-Za-z0-9._/+-]*$/.test(s)) return "El shell debe ser una ruta absoluta (p. ej. /bin/bash)";
  return null;
}

/** Terminal de `who` (pts/0, tty1…). */
export function validateTty(s: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(s) && !s.includes("..") ? null : "Terminal no válida";
}

/** Fecha AAAA-MM-DD válida. */
export function validateDate(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "Usa el formato AAAA-MM-DD";
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return "Fecha no válida";
  return null;
}

const KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ssh-dss",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
];

/**
 * Valida una línea de llave pública (`authorized_keys`), con opciones delante si las hay.
 * Devuelve la línea normalizada (sin espacios sobrantes) o un error.
 */
export function parsePublicKey(line: string): { ok: true; line: string; type: string; comment: string } | { ok: false; error: string } {
  const t = line.trim();
  if (!t) return { ok: false, error: "Pega una llave pública" };
  if (/[\n\r]/.test(t)) return { ok: false, error: "Una sola llave por línea" };
  if (t.includes("PRIVATE KEY")) return { ok: false, error: "Eso es una llave PRIVADA: pega la pública (.pub)" };
  const parts = t.split(/\s+/);
  const idx = parts.findIndex((p) => KEY_TYPES.includes(p));
  if (idx < 0 || !parts[idx + 1] || !/^[A-Za-z0-9+/]+=*$/.test(parts[idx + 1])) {
    return { ok: false, error: "No parece una llave pública SSH (ssh-ed25519 AAAA…, ssh-rsa AAAA…)" };
  }
  return { ok: true, line: t, type: parts[idx], comment: parts.slice(idx + 2).join(" ") };
}

const PASS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASS_SYMBOLS = "-_.+=@%";

/** Contraseña aleatoria segura (crypto.getRandomValues, sin sesgo de módulo). */
export function generatePassword(length = 20): string {
  const alphabet = PASS_ALPHABET + PASS_SYMBOLS;
  const out: string[] = [];
  const buf = new Uint8Array(1);
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push(alphabet[buf[0] % alphabet.length]);
  }
  // Garantiza al menos un número y un símbolo (algunas políticas los exigen).
  if (!/[0-9]/.test(out.join(""))) out[1] = "7";
  if (!/[-_.+=@%]/.test(out.join(""))) out[length - 2] = "-";
  return out.join("");
}

/** Marca de contraseña oculta en todo lo que se muestra o se guarda. */
export const MASK = "●●●●";
