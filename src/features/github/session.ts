// Sesiones SSH abiertas que pueden usar las funciones de GitHub (clonar, añadir llaves, desplegar).
import { snippets } from "../../api/snippets";
import type { ExecResult } from "../../api/types";
import { connectToServer } from "../connect";
import { useProfiles } from "../../stores/profiles";
import { useTabs, type SessionTab } from "../../stores/tabs";

/** Pestañas conectadas (una por sesión). */
export function connectedTabs(tabs: SessionTab[]): SessionTab[] {
  return tabs.filter((t) => t.status === "connected");
}

/** sessionId de una conexión abierta al servidor guardado `serverId`, o null. */
export function findSession(serverId: string): string | null {
  const t = useTabs.getState().tabs.find((x) => x.profileId === serverId && x.status === "connected");
  return t?.sessionId ?? null;
}

/** Devuelve una sesión al servidor; si no hay, conecta (abre su pestaña). null si no se pudo. */
export async function ensureSession(serverId: string): Promise<string | null> {
  const found = findSession(serverId);
  if (found) return found;
  const profile = useProfiles.getState().getServer(serverId);
  if (!profile) return null;
  const ok = await connectToServer(profile);
  return ok ? findSession(serverId) : null;
}

/** Ejecuta y lanza un error con la salida si el código no es 0. */
export async function execOk(sessionId: string, command: string, timeoutSecs = 60): Promise<ExecResult> {
  const r = await snippets.exec(sessionId, command, timeoutSecs);
  if (r.timedOut) throw new Error("El comando tardó demasiado y se canceló");
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
    throw new Error(msg || `El comando terminó con código ${r.exitCode ?? "?"}`);
  }
  return r;
}

/** Salida combinada para mostrar. */
export function execOutput(r: ExecResult): string {
  return [r.stdout, r.stderr].filter((s) => s.trim()).join("\n").trimEnd();
}
