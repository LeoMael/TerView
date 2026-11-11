// Sistema operativo de ESTE equipo y rutas LOCALES (las del disco del usuario).
// No confundir con `paths.ts`, que trata rutas REMOTAS (siempre con "/").

type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

function detect(): "windows" | "mac" | "linux" {
  if (typeof navigator === "undefined") return "linux";
  const nav = navigator as NavigatorWithUAData;
  const p = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "mac";
  return "linux";
}

export const OS = detect();
export const isWindows = OS === "windows";
export const isMac = OS === "mac";

/** Archivo de configuración de OpenSSH del usuario. */
export const SSH_CONFIG_LABEL = isWindows ? "%USERPROFILE%\\.ssh\\config" : "~/.ssh/config";
/** Ejemplo de ruta de llave privada para los campos de texto. */
export const SSH_KEY_EXAMPLE = isWindows ? "C:\\Users\\tu-usuario\\.ssh\\id_ed25519" : "~/.ssh/id_ed25519";

/** Tecla de los atajos: Ctrl (Linux/Windows) o ⌘ (macOS). */
export function isModKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Texto de un atajo para mostrar: "Ctrl+B" o "⌘B". */
export function shortcutLabel(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

// ───────── Rutas locales (aceptan "\" y "/", y letra de unidad "C:") ─────────

const SEP_RE = /[\\/]+$/;

/** Último nombre de una ruta local: "C:\\Users\\x\\Fotos\\a.png" → "a.png"; "/home/x/" → "x". */
export function localBasename(path: string): string {
  const p = path.replace(SEP_RE, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const name = p.slice(i + 1);
  return name || path;
}

/** Carpeta que contiene una ruta local: "C:\\Users\\x\\a.png" → "C:\\Users\\x"; "C:\\a.png" → "C:\\". */
export function localDirname(path: string): string {
  const p = path.replace(SEP_RE, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return "";
  const dir = p.slice(0, i);
  if (dir === "") return p[0]; // raíz POSIX "/"
  if (/^[a-zA-Z]:$/.test(dir)) return `${dir}${p[i]}`; // "C:" → "C:\"
  return dir;
}

/** Une carpeta local y nombre usando el separador que ya usa la carpeta (o el del sistema). */
export function localJoin(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : dir.includes("/") ? "/" : isWindows ? "\\" : "/";
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}${sep}${name}`;
}
