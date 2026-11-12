// Terminales persistentes (tmux): modo efectivo, registro de las terminales abiertas, cierre y avisos.
import type { TmuxMode } from "../../api/types";
import { terminal } from "../../api/terminal";
import { useSettings } from "../../stores/settings";
import { useProfiles } from "../../stores/profiles";
import { sendToTerminal } from "../../stores/terminalBus";
import { toast } from "../../stores/toasts";
import { confirmDialog } from "../../components/ui/dialogs";
import { getPrivilege } from "../privileges";
import { resolveTmuxMode, tmuxInstallCommand } from "./logic";

export * from "./logic";

// ───────── Modo ─────────

/** Modo efectivo de un servidor (hook: cambia al tocar Ajustes o el servidor). */
export function useTmuxMode(profileId: string | null): TmuxMode {
  const global = useSettings((s) => s.settings.terminalTmux);
  const server = useProfiles((s) => (profileId ? (s.servers.find((x) => x.id === profileId)?.tmux ?? null) : null));
  return resolveTmuxMode(global, server);
}

/** Lectura puntual, fuera de React. */
export function getTmuxMode(profileId: string | null): TmuxMode {
  const server = profileId ? useProfiles.getState().servers.find((x) => x.id === profileId)?.tmux : null;
  return resolveTmuxMode(useSettings.getState().settings.terminalTmux, server);
}

// ───────── Registro de terminales persistentes abiertas ─────────
// sessionId → (clave de sub-pestaña → nombre tmux). Lo mantiene TerminalArea.

const openBySession = new Map<string, Map<number, string>>();

export function setOpenTmux(sessionId: string, key: number, name: string | null) {
  let m = openBySession.get(sessionId);
  if (name) {
    if (!m) openBySession.set(sessionId, (m = new Map()));
    m.set(key, name);
  } else if (m) {
    m.delete(key);
    if (m.size === 0) openBySession.delete(sessionId);
  }
}

/** Sesiones tmux abiertas en las terminales de una pestaña de conexión. */
export function openTmuxNames(sessionId: string): string[] {
  return [...(openBySession.get(sessionId)?.values() ?? [])];
}

/** Todas las sesiones tmux abiertas en esta ventana de TerView. */
export function allOpenTmuxNames(): Set<string> {
  const out = new Set<string>();
  for (const m of openBySession.values()) for (const n of m.values()) out.add(n);
  return out;
}

// ───────── Cerrar a propósito ─────────

/**
 * Termina sesiones tmux (al cerrar la terminal o la pestaña a propósito). Nunca lanza.
 * Espera como mucho `timeoutMs`: si el servidor no responde, la sesión queda y se puede cerrar
 * después desde «Sesiones en el servidor».
 */
export async function killTmuxSessions(sessionId: string, names: string[], timeoutMs = 4000): Promise<boolean> {
  if (names.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      terminal.tmuxKill(sessionId, names),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("tiempo agotado")), timeoutMs);
      }),
    ]);
    return true;
  } catch (e) {
    console.warn("tmux: no se pudieron cerrar las sesiones", names, e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ───────── Aviso «tmux no está instalado» (modo Siempre) ─────────

const warned = new Set<string>();

/** Comando de instalación para el servidor de esa sesión (según su distro y privilegios). */
export function installCommandFor(sessionId: string) {
  const p = getPrivilege(sessionId);
  const elevate = p?.level === "root" ? "" : p?.tool === "doas" ? "doas" : "sudo";
  return tmuxInstallCommand(p?.distroId ?? null, p?.distroLike ?? [], elevate);
}

/** Avisa una vez por servidor (en esta ejecución de la app) y ofrece escribir el comando de instalación. */
export async function warnTmuxMissing(sessionId: string, profileId: string, serverName: string): Promise<void> {
  if (warned.has(profileId)) return;
  warned.add(profileId);
  const { distro, command } = installCommandFor(sessionId);
  const ok = await confirmDialog({
    title: "tmux no está instalado",
    message: (
      <>
        <p>
          «{serverName}» está configurado para usar siempre terminales persistentes, pero el servidor no tiene tmux. Se
          abrió una terminal normal: si se corta la conexión, lo que corra en ella se perderá.
        </p>
        <p>Para instalarlo en {distro}:</p>
        <pre className="mono" style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>
          {command}
        </pre>
        <p>Las terminales que abras después de instalarlo ya serán persistentes.</p>
      </>
    ),
    confirmText: "Escribir el comando en la terminal",
    cancelText: "Ahora no",
  });
  if (!ok) return;
  // Se escribe sin Enter: la persona lo revisa y lo ejecuta.
  if (!sendToTerminal(sessionId, command, false)) toast.info("No hay una terminal abierta", command);
}
