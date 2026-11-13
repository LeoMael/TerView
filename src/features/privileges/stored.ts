// Contraseña de sudo guardada (o la de la conexión) de cada servidor: se lee del motor cuando un panel
// que eleva la necesita, se comprueba con `sudo -v` y queda en memoria (ver sudo.ts). Aparte de sudo.ts
// para que la ventana principal no cargue los servidores antes de tiempo. Todos los sitios que piden
// la contraseña de sudo pasan por `obtainSudoPassword` (el diálogo la llama antes de preguntar).
import { useEffect, useRef } from "react";
import { profiles } from "../../api/profiles";
import type { SudoMode } from "../../api/types";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { useLock } from "../lock/lockStore";
import type { PrivilegeInfo } from "./detect";
import { otherSessionPasswords, storedFailed, storedStateAfterConfirm, sudoLookupPlan, type SudoSource } from "./lookup";
import { confirmSudo, setStoredSudo, useSudo, without } from "./sudo";

/** Modo de sudo efectivo de un servidor («login» solo si entra con contraseña). */
export function sudoModeOf(profileId: string): SudoMode {
  const srv = useProfiles.getState().getServer(profileId);
  const mode = srv?.sudoMode ?? "ask";
  return mode === "login" && srv?.auth !== "password" ? "ask" : mode;
}

/** Necesita contraseña (sudo con contraseña, o «puede que tenga sudo»). */
function needsPassword(info: PrivilegeInfo | null): boolean {
  return !!info && info.hasSudo && info.level !== "root" && info.level !== "sudo-nopasswd" && info.level !== "user";
}

// Lectura en curso por sesión: el panel que se abre, el diálogo y la acción que pide sudo esperan a la
// misma (así el diálogo no salta mientras la guardada aún se está comprobando).
const inflight = new Map<string, Promise<void>>();

/**
 * Si el servidor usa una contraseña guardada (o la de la conexión), la lee del motor, la comprueba con
 * sudo y la deja en memoria. Una vez por sesión (se repite tras reconectar o desbloquear). Nunca lanza.
 */
export function loadStoredSudo(sessionId: string, profileId: string): Promise<void> {
  const cur = inflight.get(sessionId);
  if (cur) return cur;
  const p = readAndConfirm(sessionId, profileId).finally(() => {
    if (inflight.get(sessionId) === p) inflight.delete(sessionId);
  });
  inflight.set(sessionId, p);
  return p;
}

async function readAndConfirm(sessionId: string, profileId: string): Promise<void> {
  if (sudoModeOf(profileId) === "ask") {
    setStoredSudo(sessionId, "none");
    return;
  }
  setStoredSudo(sessionId, "loading");
  let pw: string | null;
  try {
    pw = await profiles.sudoPassword(profileId);
  } catch {
    // Bloqueado o llavero no disponible: se pedirá a mano (y se reintenta al desbloquear).
    if (useSudo.getState().stored[sessionId] === "loading") setStoredSudo(sessionId, "none");
    return;
  }
  if (useSudo.getState().stored[sessionId] !== "loading") return; // se olvidó mientras tanto
  if (!pw) {
    setStoredSudo(sessionId, "none");
    return;
  }
  const r = await confirmSudo(sessionId, pw);
  if (useSudo.getState().stored[sessionId] !== "loading") return;
  setStoredSudo(sessionId, storedStateAfterConfirm(r));
}

/** Resultado de `obtainSudoPassword`. */
export type SudoObtainResult =
  | { ok: true; source: Exclude<SudoSource, "ask"> }
  /** Hay que preguntar. `storedFailed`: la guardada (o la de la conexión) no sirvió. */
  | { ok: false; storedFailed: boolean };

/**
 * Única forma de conseguir la contraseña de sudo de una conexión (orden en lookup.ts): en memoria →
 * guardada → otra pestaña del mismo servidor → hay que preguntar. Si la consigue, queda en memoria de
 * esta sesión. Nunca lanza.
 */
export async function obtainSudoPassword(sessionId: string, profileId: string): Promise<SudoObtainResult> {
  const st = useSudo.getState();
  const others = otherSessionPasswords(useTabs.getState().tabs, st.bySession, sessionId, profileId);
  const plan = sudoLookupPlan({
    hasMemory: sessionId in st.bySession,
    stored: st.stored[sessionId],
    mode: sudoModeOf(profileId),
    otherSessions: others.length,
  });
  for (const step of plan) {
    if (step === "memory") return { ok: true, source: "memory" };
    if (step === "stored") {
      if (useLock.getState().status?.locked) continue;
      await loadStoredSudo(sessionId, profileId);
      if (sessionId in useSudo.getState().bySession) return { ok: true, source: "stored" };
    } else if (step === "other-session") {
      for (const pw of others) {
        if (useSudo.getState().stored[sessionId] === "off") break;
        const r = await confirmSudo(sessionId, pw);
        if (r.ok) return { ok: true, source: "other-session" };
      }
    }
  }
  if (sessionId in useSudo.getState().bySession) return { ok: true, source: "memory" };
  // Nada sirvió: se apunta para que los paneles no lo reintenten solos cada vez que se abren (cada
  // intento fallido cuenta para sudo y puede bloquear la cuenta). El diálogo sí vuelve a mirar.
  const live = useTabs.getState().tabs.some((t) => t.sessionId === sessionId && t.status !== "closed");
  if (live && useSudo.getState().stored[sessionId] === undefined) setStoredSudo(sessionId, "none");
  return { ok: false, storedFailed: storedFailed(useSudo.getState().stored[sessionId]) };
}

/** Hook para los paneles que elevan (Administración, Contenedores): busca la contraseña (guardada u
 * otra pestaña del mismo servidor) cuando el panel está activo y hace falta, sin preguntar. */
export function useStoredSudo(sessionId: string, profileId: string, info: PrivilegeInfo | null, active: boolean): void {
  const hasPassword = useSudo((s) => sessionId in s.bySession);
  const state = useSudo((s) => s.stored[sessionId]);
  const locked = useLock((s) => !!s.status?.locked);
  const mode = useProfiles((s) => s.servers.find((x) => x.id === profileId)?.sudoMode ?? "ask");
  const need = needsPassword(info);
  useEffect(() => {
    if (!active || locked || hasPassword || !need || state !== undefined) return;
    void obtainSudoPassword(sessionId, profileId);
  }, [active, locked, hasPassword, need, state, sessionId, profileId]);
  // Al cambiar el ajuste del servidor, volver a mirar (salvo si el usuario la olvidó a mano).
  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === mode) return;
    prevMode.current = mode;
    const st = useSudo.getState().stored[sessionId];
    if (st === "none" || storedFailed(st)) useSudo.setState((s) => ({ stored: without(s.stored, sessionId) }));
  }, [mode, sessionId]);
  // Al desbloquear, volver a mirar si la lectura falló por estar bloqueado («none» sin contraseña).
  const prevLocked = useRef(locked);
  useEffect(() => {
    const was = prevLocked.current;
    prevLocked.current = locked;
    if (!was || locked) return;
    if (useSudo.getState().stored[sessionId] === "none") useSudo.setState((s) => ({ stored: without(s.stored, sessionId) }));
  }, [locked, sessionId]);
}
