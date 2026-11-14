// «Nuevo usuario con clave»: usuario SIN contraseña que solo entra con su llave SSH.
// Funciones puras (sin React ni Tauri): validación de la llave pública, lectura de AllowUsers/AllowGroups
// de sshd, el plan de comandos del asistente y el comando equivalente del catálogo (también para MCP).
import { addMemberStep, writeKeysSteps, type AdminEnv, type Plan } from "./commands";
import { parsePublicKey, shQuote } from "./shell";

const q = shQuote;

// ───────── Llave pública ─────────

/** Decodifica base64 estándar (sin espacios). null si no es válido. */
function decodeBase64(s: string): Uint8Array | null {
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export type PublicKeyCheck = { ok: true; line: string; type: string; comment: string } | { ok: false; error: string };

/**
 * Valida una llave pública de una sola línea, más estricto que `parsePublicKey`: sin opciones delante,
 * base64 válido y el tipo escrito dentro de la llave igual al de delante (detecta llaves cortadas o mezcladas).
 */
export function checkPublicKey(text: string): PublicKeyCheck {
  const p = parsePublicKey(text);
  if (!p.ok) return p;
  const parts = p.line.split(/\s+/);
  if (parts[0] !== p.type) return { ok: false, error: "La llave debe empezar por su tipo (ssh-ed25519, ssh-rsa…), sin opciones delante" };
  const blob = decodeBase64(parts[1]);
  if (!blob || blob.length < 4) return { ok: false, error: "La parte en base64 de la llave no es válida (¿está cortada?)" };
  const len = ((blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]) >>> 0;
  const inner = len <= blob.length - 4 ? new TextDecoder().decode(blob.subarray(4, 4 + len)) : "";
  if (inner !== p.type) return { ok: false, error: "La llave está dañada: su contenido no corresponde al tipo indicado" };
  // ed25519: tipo (4 + 11) + llave (4 + 32) = 51 bytes exactos.
  if (p.type === "ssh-ed25519" && blob.length !== 51) return { ok: false, error: "La llave ed25519 está incompleta (¿está cortada?)" };
  if (p.type === "ssh-dss") return { ok: false, error: "Las llaves DSA (ssh-dss) ya no las acepta OpenSSH: usa ed25519" };
  return { ok: true, line: p.line, type: p.type, comment: p.comment };
}

/** Nombre de archivo sugerido para una llave nueva en ~/.ssh. */
export function suggestKeyName(user: string, host: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const h = clean(host.split(".")[0] ?? "");
  return ["id_ed25519", clean(user), h].filter(Boolean).join("_");
}

/** Mismas reglas que el motor (`localkeys::check_key_name`). */
export function validateKeyName(name: string): string | null {
  if (!name) return "Escribe un nombre para el archivo de la llave";
  if (name.length > 64) return "Máximo 64 caracteres";
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name) || name.endsWith(".pub"))
    return "Solo letras, números, «.», «_» y «-» (p. ej. id_ed25519_ana)";
  return null;
}

// ───────── Quién puede entrar por SSH (AllowUsers/AllowGroups) ─────────

/** Lectura (mejor como root: `sshd -T` necesita leer las llaves del servidor). Sale bien siempre. */
export const SSHD_ACCESS_SCRIPT = [
  "echo @@eff",
  "PATH=$PATH:/usr/sbin:/sbin",
  "sshd -T 2>/dev/null | grep -Ei '^(allowusers|allowgroups|denyusers|denygroups) ' || true",
  "echo @@conf",
  "cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | grep -Ei '^[[:space:]]*(allowusers|allowgroups|denyusers|denygroups)[[:space:]]' || true",
  "echo @@end",
].join("\n");

export interface SshdAccess {
  allowUsers: string[];
  allowGroups: string[];
  denyUsers: string[];
  denyGroups: string[];
  /** «sshd -T» (configuración efectiva) o «archivos» (sshd_config leído a mano: aproximado). */
  source: "sshd -T" | "archivos" | null;
}

/** Interpreta las secciones @@eff y @@conf de `SSHD_ACCESS_SCRIPT`. */
export function parseSshdAccess(sections: Map<string, string[]>): SshdAccess {
  const eff = sections.get("eff") ?? [];
  const conf = sections.get("conf") ?? [];
  const lines = eff.length ? eff : conf;
  const out: SshdAccess = { allowUsers: [], allowGroups: [], denyUsers: [], denyGroups: [], source: null };
  if (!lines.length) return out;
  out.source = eff.length ? "sshd -T" : "archivos";
  const keys: Record<string, keyof Omit<SshdAccess, "source">> = {
    allowusers: "allowUsers",
    allowgroups: "allowGroups",
    denyusers: "denyUsers",
    denygroups: "denyGroups",
  };
  for (const raw of lines) {
    const [kw, ...vals] = raw.trim().split(/\s+/);
    const k = keys[kw.toLowerCase()];
    if (!k) continue;
    for (const v of vals) {
      if (v.startsWith("#")) break;
      if (!out[k].includes(v)) out[k].push(v);
    }
  }
  return out;
}

/** Comodines de sshd (`*`, `?`) y forma usuario@host: true si `name` coincide con el patrón. */
function matchPattern(pattern: string, name: string): boolean {
  const pat = pattern.split("@")[0];
  const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(name);
}

export interface AccessAdvice {
  /** Grupo de AllowGroups que hay que añadir al usuario (si no está ya en uno). */
  needGroup: string | null;
  /** AllowUsers existe y no incluye al usuario: sshd lo rechazará aunque la llave sea correcta. */
  needAllowUsers: boolean;
  /** DenyUsers/DenyGroups lo bloquean. */
  denied: string | null;
}

/** Qué falta para que sshd deje entrar a `user` con los grupos `groups`. */
export function accessAdvice(a: SshdAccess, user: string, groups: string[]): AccessAdvice {
  const denied =
    a.denyUsers.find((p) => matchPattern(p, user)) ??
    a.denyGroups.find((p) => groups.some((g) => matchPattern(p, g))) ??
    null;
  const inGroup = a.allowGroups.length === 0 || a.allowGroups.some((p) => groups.some((g) => matchPattern(p, g)));
  const needGroup = inGroup ? null : (a.allowGroups.find((p) => !/[*?]/.test(p)) ?? null);
  const needAllowUsers = a.allowUsers.length > 0 && !a.allowUsers.some((p) => matchPattern(p, user));
  return { needGroup, needAllowUsers, denied: denied ? `sshd lo bloquea (Deny…: ${denied})` : null };
}

// ───────── Plan del asistente ─────────

export interface KeyUser {
  name: string;
  /** Línea ya validada con `checkPublicKey`. */
  publicKey: string;
  shell: string;
  /** Grupos suplementarios (p. ej. el de AllowGroups). */
  groups: string[];
  admin: boolean;
  linger: boolean;
}

/**
 * Crea el usuario sin contraseña («*» en /etc/shadow: no puede entrar con contraseña pero la cuenta no
 * queda «bloqueada», que sshd rechaza incluso con llave cuando no usa PAM) y escribe su authorized_keys.
 * No toca sshd_config ni PasswordAuthentication.
 */
export function createKeyUserPlan(env: AdminEnv, u: KeyUser): Plan {
  const groups = [...new Set([...u.groups, ...(u.admin ? [env.adminGroup] : [])])].filter((g) => g && g !== u.name);
  const steps: string[] = ["# Usuario sin contraseña: solo podrá entrar con su llave SSH"];
  if (env.toolset === "shadow") {
    const args = ["useradd", "-m", "-s", q(u.shell)];
    if (groups.length) args.push("-G", q(groups.join(",")));
    args.push(q(u.name));
    steps.push(args.join(" "));
    steps.push(`usermod -p '*' ${q(u.name)}`);
  } else {
    steps.push(`adduser -D -s ${q(u.shell)} ${q(u.name)}`);
    steps.push(`printf '%s:*\\n' ${q(u.name)} | chpasswd -e`);
    for (const g of groups) steps.push(addMemberStep(env, u.name, g));
  }
  steps.push(...writeKeysSteps(u.name, u.publicKey));
  if (u.linger) {
    steps.push(
      "# linger: sus servicios de usuario (systemd --user, contenedores) siguen activos sin sesión abierta",
      `if command -v loginctl >/dev/null 2>&1; then loginctl enable-linger ${q(u.name)}; else echo ${q(
        "Sin loginctl (no es systemd): se omite linger",
      )} >&2; fi`,
    );
  }
  return { action: `Crear usuario «${u.name}» con acceso solo por llave SSH`, steps };
}

/**
 * Añade `user` a AllowUsers con un archivo aparte en sshd_config.d (AllowUsers se acumula entre líneas),
 * comprueba la configuración con `sshd -t` (si falla, lo deshace) y recarga sshd. Cambio global: va aparte.
 */
export function allowUsersPlan(user: string): Plan {
  const file = `/etc/ssh/sshd_config.d/60-sshorus-${user}.conf`;
  return {
    action: `Añadir «${user}» a AllowUsers de sshd`,
    danger: true,
    steps: [
      `if [ ! -d /etc/ssh/sshd_config.d ]; then echo ${q("Este servidor no tiene /etc/ssh/sshd_config.d: añade «AllowUsers " + user + "» a mano")} >&2; exit 1; fi`,
      `printf '%s\\n' ${q(`# Añadido por SSHorus: deja entrar a ${user} por SSH`)} ${q(`AllowUsers ${user}`)} > ${q(file)}`,
      `chmod 600 ${q(file)}`,
      `PATH=$PATH:/usr/sbin:/sbin`,
      `if ! sshd -t; then rm -f ${q(file)}; echo ${q("sshd -t falló: se deshizo el cambio")} >&2; exit 1; fi`,
      `if sshd -T 2>/dev/null | grep -qix ${q(`allowusers ${user}`)}; then :; else rm -f ${q(file)}; echo ${q(
        "sshd no aplicó el cambio (¿falta «Include /etc/ssh/sshd_config.d/*.conf»?): se deshizo",
      )} >&2; exit 1; fi`,
      `systemctl reload sshd 2>/dev/null || systemctl reload ssh`,
    ],
  };
}

// ───────── Comando del catálogo (Biblioteca y MCP) ─────────

/**
 * `usuarios.crear-usuario-clave`: el mismo cambio en un solo comando con variables. Todo el script va entre
 * comillas simples (sin variables dentro) y los valores se pasan como argumentos ($1…$5), así que la
 * llave (con espacios y comentario) llega literal, sin inyección de shell.
 * admin/linger: «si» o «no». grupo: vacío o lista separada por comas.
 */
export const KEY_USER_CATALOG_COMMAND =
  "sudo sh -c '" +
  [
    "set -e",
    "u=$1 k=$2 g=$3 a=$4 l=$5",
    'case $u in [a-z_]*) ;; *) echo "Usuario no válido: $u" >&2; exit 2;; esac',
    'case $u in *[!a-z0-9_-]*) echo "Usuario no válido: $u" >&2; exit 2;; esac',
    'case $k in ssh-ed25519\\ AAAA*|ssh-rsa\\ AAAA*|ecdsa-sha2-nistp*\\ AAAA*|sk-*@openssh.com\\ AAAA*) ;; *) echo "No parece una llave pública SSH" >&2; exit 2;; esac',
    'if id "$u" >/dev/null 2>&1; then echo "El usuario $u ya existe" >&2; exit 1; fi',
    "s=/bin/sh; if [ -x /bin/bash ]; then s=/bin/bash; fi",
    'if command -v useradd >/dev/null 2>&1; then useradd -m -s "$s" "$u"; usermod -p "*" "$u"; else adduser -D -s "$s" "$u"; printf "%s:*\\n" "$u" | chpasswd -e; fi',
    'add() { if command -v usermod >/dev/null 2>&1; then usermod -aG "$2" "$1"; else addgroup "$1" "$2"; fi; }',
    'for x in $(printf %s "$g" | tr , " "); do case $x in -*|*[!A-Za-z0-9._-]*) echo "Grupo no válido: $x" >&2; exit 2;; esac; add "$u" "$x"; done',
    'case $a in si|sí|s|yes|y|1) ag=wheel; if [ -f /etc/debian_version ]; then ag=sudo; fi; if ! grep -q "^$ag:" /etc/group; then if [ $ag = wheel ]; then ag=sudo; else ag=wheel; fi; fi; add "$u" "$ag";; esac',
    'h=$(grep "^$u:" /etc/passwd | cut -d: -f6); d=$h/.ssh',
    'mkdir -p "$d"; printf "%s\\n" "$k" > "$d/authorized_keys"',
    'chown -R "$u:$(id -g "$u")" "$d"; chmod 700 "$d"; chmod 600 "$d/authorized_keys"',
    'case $l in si|sí|s|yes|y|1) if command -v loginctl >/dev/null 2>&1; then loginctl enable-linger "$u"; else echo "Sin loginctl: se omite linger" >&2; fi;; esac',
    'echo "Usuario $u creado: solo puede entrar con su llave SSH"',
  ].join("; ") +
  "' crear-usuario {{usuario}} {{clave_publica}} {{grupo:}} {{admin:no}} {{linger:no}}";
