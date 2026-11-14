// Contraseña de sudo por sesión: en memoria (zustand sin persistencia). Se olvida con el botón
// «Olvidar contraseña de sudo», al cerrar la pestaña, al perder la conexión (ver initPrivileges) y al
// bloquear SSHorus.
//
// Cada servidor elige de dónde sale (editor de servidor → «Contraseña de sudo»): pedirla cada vez, la
// de la conexión o una guardada aparte (bóveda o llavero). Las dos últimas se leen del motor cuando
// un panel la necesita (`useStoredSudo` y `obtainSudoPassword`, en stored.ts), se comprueban con
// `sudo -v` y quedan en memoria igual que si se hubieran escrito. Si no sirven, se marca «failed» y el
// diálogo ofrece guardar la nueva. El orden de búsqueda está en lookup.ts.
import { useMemo } from "react";
import { create } from "zustand";
import { snippets } from "../../api/snippets";
import { errorMessage } from "../../api/core";
import type { PrivilegeInfo } from "./detect";
import { buildExec, elevationFailure, elevationFailureMessage, type Elevation } from "./elevate";
import type { StoredSudoState } from "./lookup";

export type { StoredSudoState } from "./lookup";

interface SudoState {
  bySession: Record<string, string>;
  stored: Record<string, StoredSudoState>;
  set: (sessionId: string, password: string) => void;
  clear: (sessionId: string) => void;
}

export function without<T>(m: Record<string, T>, k: string): Record<string, T> {
  if (!(k in m)) return m;
  const next = { ...m };
  delete next[k];
  return next;
}

export const useSudo = create<SudoState>((set) => ({
  bySession: {},
  stored: {},
  set: (sessionId, password) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: password } })),
  clear: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession) && !(sessionId in s.stored)) return s;
      return { bySession: without(s.bySession, sessionId), stored: without(s.stored, sessionId) };
    }),
}));

export function setStoredSudo(sessionId: string, st: StoredSudoState) {
  useSudo.setState((s) => ({ stored: { ...s.stored, [sessionId]: st } }));
}

/** Olvida la contraseña de sudo en memoria de esa sesión (al cerrar o perder la conexión). */
export function forgetSudo(sessionId: string): void {
  useSudo.getState().clear(sessionId);
}

/** Botón «Olvidar»: además no la vuelve a leer de la guardada hasta reconectar. */
export function forgetSudoByUser(sessionId: string): void {
  useSudo.setState((s) => ({ bySession: without(s.bySession, sessionId), stored: { ...s.stored, [sessionId]: "off" } }));
}

/** Olvida todas las contraseñas de sudo en memoria (al bloquear SSHorus). Las guardadas se vuelven a
 * leer al desbloquear. */
export function forgetAllSudo(): void {
  useSudo.setState({ bySession: {}, stored: {} });
}

/** sudo rechazó la contraseña en memoria (p. ej. se cambió en el servidor): se olvida y se pide otra. */
export function sudoRejected(sessionId: string): void {
  const wasStored = useSudo.getState().stored[sessionId] === "ok";
  useSudo.setState((s) => ({
    bySession: without(s.bySession, sessionId),
    stored: wasStored ? { ...s.stored, [sessionId]: "failed" } : s.stored,
  }));
}

/** Como `sudoRejected`, pero fuera de un panel (un comando del asistente) y con el aviso ya mostrado: si
 * era la guardada queda «rejected», así los paneles no abren el diálogo solos y se pide al usarla. */
export function sudoRejectedNotified(sessionId: string): void {
  sudoRejected(sessionId);
  if (useSudo.getState().stored[sessionId] === "failed") setStoredSudo(sessionId, "rejected");
}

export function useStoredSudoState(sessionId: string): StoredSudoState | undefined {
  return useSudo((s) => s.stored[sessionId]);
}

export function useHasSudoPassword(sessionId: string): boolean {
  return useSudo((s) => sessionId in s.bySession);
}

/** Resultado de validar la contraseña de sudo. */
export interface SudoConfirmResult {
  ok: boolean;
  message: string;
  /** sudo dijo que la contraseña no es correcta. */
  badPassword?: boolean;
}

/**
 * Valida la contraseña con `sudo -k -S -p '' -v` (por stdin, nunca en la línea de comandos) y, si es
 * correcta, la guarda en memoria para esa sesión. Nunca lanza.
 */
export async function confirmSudo(sessionId: string, password: string): Promise<SudoConfirmResult> {
  if (!password) return { ok: false, message: "Escribe tu contraseña" };
  if (/[\n\r]/.test(password)) return { ok: false, message: "La contraseña no puede tener saltos de línea" };
  const req = buildExec("true", { kind: "password", password });
  try {
    const r = await snippets.execStdin(sessionId, req.command, req.stdin, 20);
    if (r.timedOut) return { ok: false, message: "sudo tardó demasiado en responder" };
    if (r.exitCode === 0) {
      useSudo.getState().set(sessionId, password);
      return { ok: true, message: "Contraseña de sudo confirmada" };
    }
    const f = elevationFailure(r.exitCode, r.stderr);
    if (f) return { ok: false, message: elevationFailureMessage(f), badPassword: f === "bad-password" };
    if (/command not found|not found/i.test(r.stderr)) return { ok: false, message: "sudo no está instalado en el servidor" };
    return { ok: false, message: r.stderr.trim() || `sudo terminó con código ${r.exitCode ?? "desconocido"}` };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

export interface ElevationState {
  /** null = no se puede elevar (solo lectura). */
  elevation: Elevation | null;
  /** Texto del modo actual («root», «sudo sin contraseña», «sudo (contraseña en memoria)»…). */
  label: string;
  /** Motivo de solo lectura, si lo hay. */
  readOnlyReason: string | null;
  /** Mostrar «Tengo sudo: introducir contraseña». */
  canAskSudo: boolean;
  /** Hay una contraseña guardada en memoria. */
  hasPassword: boolean;
}

/** Calcula el modo de elevación a partir de la detección y la contraseña guardada. Pura. */
export function computeElevation(info: PrivilegeInfo | null, password: string | undefined): ElevationState {
  const hasPassword = password !== undefined;
  if (!info) {
    return { elevation: null, label: "Comprobando…", readOnlyReason: "Comprobando tus privilegios…", canAskSudo: false, hasPassword };
  }
  if (info.level === "root") {
    return { elevation: { kind: "root" }, label: "root", readOnlyReason: null, canAskSudo: false, hasPassword: false };
  }
  if (info.level === "sudo-nopasswd" && info.tool) {
    return {
      elevation: { kind: "nopasswd", tool: info.tool },
      label: `${info.tool} sin contraseña`,
      readOnlyReason: null,
      canAskSudo: false,
      hasPassword: false,
    };
  }
  if (hasPassword && info.hasSudo) {
    return {
      elevation: { kind: "password", password },
      label: "sudo (contraseña en memoria)",
      readOnlyReason: null,
      canAskSudo: false,
      hasPassword,
    };
  }
  const canAskSudo = info.hasSudo;
  if (info.level === "unknown") {
    return {
      elevation: null,
      label: "sin comprobar",
      readOnlyReason: "No se pudieron comprobar tus privilegios. Solo lectura.",
      canAskSudo,
      hasPassword,
    };
  }
  if (info.tool === "doas" && !info.hasSudo) {
    return {
      elevation: null,
      label: "doas",
      readOnlyReason:
        "Este servidor usa doas con contraseña. doas solo acepta la contraseña desde una terminal, así que SSHorus no " +
        "puede enviársela de forma segura: para hacer cambios conéctate como root, usa sudo o configura doas sin " +
        "contraseña («permit nopass»). Mientras tanto, todo queda en solo lectura.",
      canAskSudo: false,
      hasPassword,
    };
  }
  return {
    elevation: null,
    label: info.level === "user" ? "usuario normal" : "sudo sin confirmar",
    readOnlyReason: "Necesitas root o sudo para hacer cambios",
    canAskSudo,
    hasPassword,
  };
}

/** Lectura puntual de la contraseña (para ejecutar un cambio sin re-renderizar). */
export function getSudoPassword(sessionId: string): string | undefined {
  return useSudo.getState().bySession[sessionId];
}

/** Hook: modo de elevación de la sesión. */
export function useElevation(sessionId: string, info: PrivilegeInfo | null): ElevationState {
  const password = useSudo((s) => s.bySession[sessionId]);
  return useMemo(() => computeElevation(info, password), [info, password]);
}
