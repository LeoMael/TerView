// Privilegios del usuario remoto por sesión: se detectan en segundo plano al conectar y tras cada reconexión.
import { create } from "zustand";
import { snippets } from "../../api/snippets";
import { errorMessage } from "../../api/core";
import { useTabs, type SessionTab } from "../../stores/tabs";
import { forgetSudo, useSudo } from "./sudo";
import { DETECT_COMMAND, DETECT_TIMEOUT_SECS, parsePrivilegeOutput, unknownPrivilege, type PrivilegeInfo } from "./detect";

interface PrivilegesState {
  bySession: Record<string, PrivilegeInfo>;
  set: (sessionId: string, info: PrivilegeInfo) => void;
  clear: (sessionId: string) => void;
}

export const usePrivileges = create<PrivilegesState>((set) => ({
  bySession: {},
  set: (sessionId, info) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: info } })),
  clear: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),
}));

/** Privilegios de una sesión (null mientras no hay resultado). Solo re-renderiza si cambia esa sesión. */
export function usePrivilege(sessionId: string): PrivilegeInfo | null {
  return usePrivileges((s) => s.bySession[sessionId] ?? null);
}

/** Lectura puntual, fuera de React. */
export function getPrivilege(sessionId: string): PrivilegeInfo | null {
  return usePrivileges.getState().bySession[sessionId] ?? null;
}

/** Ejecuta la comprobación (canal exec aparte, sin contraseña). Nunca lanza: si falla devuelve "unknown". */
export async function detectPrivilege(sessionId: string): Promise<PrivilegeInfo> {
  try {
    const r = await snippets.exec(sessionId, DETECT_COMMAND, DETECT_TIMEOUT_SECS);
    const info = parsePrivilegeOutput(r.stdout);
    if (info.level === "unknown" && r.timedOut) info.error = "La comprobación tardó demasiado";
    return info;
  } catch (e) {
    return unknownPrivilege(errorMessage(e));
  }
}

// Turno de cada comprobación por sesión: descarta resultados viejos (reconexión rápida, pestaña cerrada).
const generation = new Map<string, number>();
const RETRY_MS = 4000;

function isLive(sessionId: string): boolean {
  return useTabs.getState().tabs.some((t) => t.sessionId === sessionId && t.status === "connected");
}

/** Lanza (o relanza) la comprobación de una sesión en segundo plano. */
export function refreshPrivilege(sessionId: string): void {
  const gen = (generation.get(sessionId) ?? 0) + 1;
  generation.set(sessionId, gen);
  void (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
      if (generation.get(sessionId) !== gen || !isLive(sessionId)) return;
      const info = await detectPrivilege(sessionId);
      if (generation.get(sessionId) !== gen || !useTabs.getState().tabs.some((t) => t.sessionId === sessionId)) return;
      if (info.level !== "unknown") {
        usePrivileges.getState().set(sessionId, info);
        return;
      }
      // Fallo: se conserva el último resultado bueno (los privilegios casi nunca cambian entre reconexiones).
      if (!getPrivilege(sessionId)) usePrivileges.getState().set(sessionId, info);
    }
  })();
}

function forget(sessionId: string) {
  generation.delete(sessionId);
  usePrivileges.getState().clear(sessionId);
  forgetSudo(sessionId);
}

let started = false;

/** Llamar una vez al iniciar la app: sigue las pestañas (abrir, reconectar, cerrar). */
export function initPrivileges(): () => void {
  if (started) return () => {};
  started = true;
  const seen = new Map<string, number>(); // sessionId → reconnectCount ya comprobado

  const sync = (tabs: SessionTab[]) => {
    const live = new Set<string>();
    for (const t of tabs) {
      live.add(t.sessionId);
      // Desconexión definitiva: la contraseña de sudo se olvida (al reconectar se vuelve a pedir).
      if (t.status === "closed") forgetSudo(t.sessionId);
      const prev = seen.get(t.sessionId);
      if (prev === t.reconnectCount) continue;
      if (t.status !== "connected") continue; // se comprobará al pasar a "connected"
      seen.set(t.sessionId, t.reconnectCount);
      refreshPrivilege(t.sessionId);
    }
    const known = new Set([
      ...seen.keys(),
      ...Object.keys(usePrivileges.getState().bySession),
      ...Object.keys(useSudo.getState().bySession),
      ...generation.keys(),
    ]);
    for (const id of known) {
      if (!live.has(id)) {
        seen.delete(id);
        forget(id);
      }
    }
  };

  sync(useTabs.getState().tabs);
  const unsub = useTabs.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) sync(s.tabs);
  });
  return () => {
    unsub();
    started = false;
  };
}
