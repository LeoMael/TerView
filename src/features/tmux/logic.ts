// Terminales persistentes (tmux): funciones puras, sin React ni Tauri, para poder probarlas aparte.
import type { TmuxMode, TmuxSession } from "../../api/types";

/** Prefijo de las sesiones de SSHorus (el motor solo acepta `sshorus-` + letras, números, - y _). */
export const TMUX_PREFIX = "sshorus-";
/** Servidor tmux propio de SSHorus (`tmux -L sshorus`). */
export const TMUX_SOCKET = "sshorus";

export const TMUX_MODE_LABELS: Record<TmuxMode, string> = {
  auto: "Automático",
  always: "Siempre",
  never: "Nunca",
};

export const TMUX_MODE_HINTS: Record<TmuxMode, string> = {
  auto: "Usa tmux si el servidor lo tiene; si no, abre una terminal normal sin avisar.",
  always: "Usa tmux siempre. Si no está instalado, abre una terminal normal y avisa una vez cómo instalarlo.",
  never: "Terminales normales: si se corta la conexión, lo que corría se pierde.",
};

/** Modo efectivo: el del servidor si lo tiene; si no, el general (por defecto «auto»). */
export function resolveTmuxMode(global: TmuxMode | null | undefined, server: TmuxMode | null | undefined): TmuxMode {
  if (server === "auto" || server === "always" || server === "never") return server;
  if (global === "always" || global === "never") return global;
  return "auto";
}

/** Valor válido de modo, o null (p. ej. al importar datos de fuera). */
export function parseTmuxMode(v: unknown): TmuxMode | null {
  return v === "auto" || v === "always" || v === "never" ? v : null;
}

/** Nombre nuevo y estable para una terminal: `sshorus-` + 8 caracteres hexadecimales al azar. */
export function newTmuxName(
  randomBytes: (n: number) => ArrayLike<number> = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  return TMUX_PREFIX + Array.from(randomBytes(4), (b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

/** true si el nombre es de una sesión de SSHorus (mismo criterio que el motor). */
export function isSshorusName(name: string): boolean {
  return name.length <= 64 && /^sshorus-[A-Za-z0-9_-]+$/.test(name);
}

/** Comando para engancharse a mano desde una shell normal del servidor. */
export function manualAttachCommand(name: string): string {
  return `tmux -L ${TMUX_SOCKET} attach -t ${name}`;
}

/** Sesiones que no están abiertas en ninguna terminal de SSHorus (las que «quedaron» en el servidor). */
export function leftoverSessions(sessions: TmuxSession[], openNames: ReadonlySet<string>): TmuxSession[] {
  return sessions.filter((s) => isSshorusName(s.name) && !openNames.has(s.name));
}

/** Sesiones sueltas que nadie está mirando (para el contador de la barra). */
export function detachedLeftovers(sessions: TmuxSession[], openNames: ReadonlySet<string>): TmuxSession[] {
  return leftoverSessions(sessions, openNames).filter((s) => s.attached === 0);
}

/** «hace 5 min», «hace 2 h», «hace 3 días» (segundos desde epoch). */
export function ago(epochSecs: number | null, nowMs: number = Date.now()): string {
  if (epochSecs === null) return "—";
  const secs = Math.max(0, Math.round(nowMs / 1000 - epochSecs));
  if (secs < 60) return "hace un momento";
  const min = Math.floor(secs / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} días`;
}

export interface InstallInfo {
  /** Nombre legible de la distro. */
  distro: string;
  command: string;
}

/**
 * Comando para instalar tmux según la distro (`ID` / `ID_LIKE` de /etc/os-release).
 * `elevate`: "" si ya es root; "sudo" o "doas" si no.
 */
export function tmuxInstallCommand(
  distroId: string | null,
  distroLike: string[] = [],
  elevate: "" | "sudo" | "doas" = "sudo",
): InstallInfo {
  const ids = [distroId ?? "", ...distroLike].map((s) => s.toLowerCase());
  const has = (...xs: string[]) => xs.some((x) => ids.includes(x));
  const p = elevate ? `${elevate} ` : "";
  if (has("fedora", "rhel", "centos", "rocky", "almalinux", "ol", "amzn")) {
    return { distro: has("fedora") && !has("rhel") ? "Fedora" : "RHEL / Rocky / Alma", command: `${p}dnf install -y tmux` };
  }
  if (has("ubuntu", "debian", "linuxmint", "pop", "raspbian")) {
    return {
      distro: has("ubuntu") ? "Ubuntu" : "Debian",
      command: `${p}apt-get update && ${p}apt-get install -y tmux`,
    };
  }
  if (has("alpine")) return { distro: "Alpine", command: `${p}apk add tmux` };
  if (has("arch", "manjaro", "endeavouros")) return { distro: "Arch Linux", command: `${p}pacman -S --needed tmux` };
  if (has("opensuse", "opensuse-leap", "opensuse-tumbleweed", "suse", "sles")) {
    return { distro: "openSUSE", command: `${p}zypper install -y tmux` };
  }
  if (has("freebsd")) return { distro: "FreeBSD", command: `${p}pkg install -y tmux` };
  return {
    distro: distroId ?? "tu sistema",
    command: `${p}apt-get install -y tmux  # o dnf / apk / pacman / zypper / brew según tu sistema`,
  };
}
