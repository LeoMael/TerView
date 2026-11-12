// Detección de privilegios del usuario remoto: comando POSIX + parseo y clasificación (funciones puras).
// Sin dependencias de React ni de Tauri, para poder probarlo aparte.

export type PrivilegeLevel = "root" | "sudo-nopasswd" | "sudo" | "maybe-sudo" | "user" | "unknown";

/** Herramienta con la que se elevarían privilegios. */
export type ElevationTool = "sudo" | "doas";

export interface PrivilegeInfo {
  level: PrivilegeLevel;
  /** Nombre del usuario remoto (`id -un`). */
  user: string | null;
  uid: number | null;
  groups: string[];
  /** `ID` de /etc/os-release (p. ej. "fedora", "ubuntu", "alpine"). */
  distroId: string | null;
  /** `ID_LIKE` de /etc/os-release, separado (p. ej. ["rhel", "centos", "fedora"]). */
  distroLike: string[];
  hasSudo: boolean;
  hasDoas: boolean;
  /** Herramienta que corresponde al nivel (null para root, user y unknown). */
  tool: ElevationTool | null;
  /** Fecha de la comprobación (ms desde epoch). */
  checkedAt: number;
  /** Motivo si `level` es "unknown". */
  error: string | null;
}

/** Grupos que, por convención de cada distro, dan sudo (o doas en Alpine). */
export const ADMIN_GROUPS = ["wheel", "sudo", "admin"] as const;

/**
 * Script POSIX de detección. Reglas para no romperlo:
 * - va entre comillas simples para el shell de login (bash, zsh, fish, tcsh…): dentro NO puede haber
 *   comillas simples, barras invertidas ni "!" (expansión de historial en tcsh);
 * - sin contraseña ni efectos: `sudo -n`/`doas -n` fallan en vez de preguntar, y stdin es /dev/null;
 * - `sudo -n`/`doas -n` solo se prueban si el usuario está en un grupo de administración: a un usuario
 *   fuera de sudoers, sudo le apunta un «NOT in sudoers» en el registro (y puede avisar a root por correo);
 * - salida `clave=valor`, una por línea; quien la lee ignora lo que no conoce.
 */
const SCRIPT = [
  'echo "tv_begin=1"',
  'u=$(id -u 2>/dev/null)',
  'echo "uid=$u"',
  'echo "user=$(id -un 2>/dev/null)"',
  'g=$(id -Gn 2>/dev/null)',
  'echo "groups=$g"',
  // Probar sudo/doas solo si es útil y no deja rastro: ni como root ni fuera de wheel/sudo/admin.
  'case " $g " in *" wheel "*|*" sudo "*|*" admin "*) p=1 ;; *) p=0 ;; esac',
  'if [ "$u" = 0 ]; then p=0; fi',
  'if command -v sudo >/dev/null 2>&1; then echo "sudo=1"; if [ "$p" = 0 ]; then :; elif sudo -n true </dev/null >/dev/null 2>&1; then echo "sudo_nopasswd=1"; else echo "sudo_nopasswd=0"; fi; else echo "sudo=0"; fi',
  'if command -v doas >/dev/null 2>&1; then echo "doas=1"; if [ "$p" = 0 ]; then :; elif doas -n true </dev/null >/dev/null 2>&1; then echo "doas_nopasswd=1"; else echo "doas_nopasswd=0"; fi; else echo "doas=0"; fi',
  'for f in /etc/os-release /usr/lib/os-release; do if [ -r "$f" ]; then (. "$f" >/dev/null 2>&1; echo "os_id=$ID"; echo "os_like=$ID_LIKE"); break; fi; done',
  'echo "tv_end=1"',
].join("; ");

/** Comando exacto que se envía por el canal exec (el shell de login puede no ser POSIX). */
export const DETECT_COMMAND = `sh -c '${SCRIPT}'`;

/** Tiempo límite de la comprobación (segundos). */
export const DETECT_TIMEOUT_SECS = 5;

/** Lee las líneas `clave=valor` (ignora todo lo demás). */
export function parseKeyValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^([a-z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function words(s: string | undefined): string[] {
  return (s ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Resultado "unknown" (la comprobación falló). */
export function unknownPrivilege(error: string, now: number = Date.now()): PrivilegeInfo {
  return {
    level: "unknown",
    user: null,
    uid: null,
    groups: [],
    distroId: null,
    distroLike: [],
    hasSudo: false,
    hasDoas: false,
    tool: null,
    checkedAt: now,
    error,
  };
}

/** Convierte la salida del comando en un resultado tipado. Nunca lanza. */
export function parsePrivilegeOutput(stdout: string, now: number = Date.now()): PrivilegeInfo {
  const kv = parseKeyValues(stdout);
  if (kv.tv_begin !== "1") return unknownPrivilege("La salida no tiene el formato esperado", now);
  const uid = /^\d+$/.test(kv.uid ?? "") ? Number(kv.uid) : null;
  if (uid === null) return unknownPrivilege("No se pudo leer el uid", now);

  const groups = words(kv.groups);
  const hasSudo = kv.sudo === "1";
  const hasDoas = kv.doas === "1";
  const inAdminGroup = groups.some((g) => (ADMIN_GROUPS as readonly string[]).includes(g));
  const distroId = words(kv.os_id)[0]?.toLowerCase() ?? null;

  let level: PrivilegeLevel;
  let tool: ElevationTool | null = null;
  if (uid === 0) level = "root";
  else if (hasSudo && kv.sudo_nopasswd === "1") [level, tool] = ["sudo-nopasswd", "sudo"];
  else if (hasSudo && inAdminGroup) [level, tool] = ["sudo", "sudo"];
  else if (hasDoas && kv.doas_nopasswd === "1") [level, tool] = ["sudo-nopasswd", "doas"];
  // doas.conf por defecto (Alpine): "permit persist :wheel".
  else if (hasDoas && groups.includes("wheel")) [level, tool] = ["sudo", "doas"];
  else if (hasSudo) [level, tool] = ["maybe-sudo", "sudo"];
  else if (hasDoas) [level, tool] = ["maybe-sudo", "doas"];
  else level = "user";

  return {
    level,
    user: kv.user || null,
    uid,
    groups,
    distroId,
    distroLike: words(kv.os_like).map((w) => w.toLowerCase()),
    hasSudo,
    hasDoas,
    tool,
    checkedAt: now,
    error: null,
  };
}

/** Descripción en español para tooltips y lectores de pantalla. */
export function privilegeDescription(info: PrivilegeInfo): string {
  const doas = info.tool === "doas";
  switch (info.level) {
    case "root":
      return "Conectado como root: tienes acceso total al servidor";
    case "sudo-nopasswd":
      return doas ? "Tienes doas sin contraseña" : "Tienes sudo sin contraseña";
    case "sudo":
      return doas ? "Tienes doas (se pedirá tu contraseña)" : "Tienes sudo (se pedirá tu contraseña)";
    case "maybe-sudo":
      return doas
        ? "Puede que tengas doas (no se pudo confirmar sin contraseña)"
        : "Puede que tengas sudo (no se pudo confirmar sin contraseña)";
    case "user":
      return "Usuario sin privilegios de administración";
    default:
      return "No se pudieron comprobar los privilegios";
  }
}

/** true si el nivel permite (o probablemente permite) administrar el servidor. */
export function canElevate(level: PrivilegeLevel): boolean {
  return level === "root" || level === "sudo-nopasswd" || level === "sudo";
}
