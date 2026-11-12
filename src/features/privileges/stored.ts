// Contraseña de sudo guardada (o la de la conexión) de cada servidor: se lee del motor cuando un panel
// que eleva la necesita, se comprueba con `sudo -v` y queda en memoria (ver sudo.ts). Aparte de sudo.ts
// para que la ventana principal no cargue los servidores antes de tiempo.
import { useEffect, useRef } from "react";
import { profiles } from "../../api/profiles";
import type { SudoMode } from "../../api/types";
import { useProfiles } from "../../stores/profiles";
import { useLock } from "../lock/lockStore";
import type { PrivilegeInfo } from "./detect";
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

/**
 * Si el servidor usa una contraseña guardada (o la de la conexión), la lee del motor, la comprueba con
 * sudo y la deja en memoria. Una vez por sesión (se repite tras reconectar o desbloquear). Nunca lanza.
 */
async function loadStoredSudo(sessionId: string, profileId: string): Promise<void> {
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
  setStoredSudo(sessionId, r.ok ? "ok" : r.badPassword ? "failed" : "none");
}

/** Hook para los paneles que elevan (Administración, Contenedores): carga la contraseña guardada
 * cuando el panel está activo y hace falta. */
export function useStoredSudo(sessionId: string, profileId: string, info: PrivilegeInfo | null, active: boolean): void {
  const hasPassword = useSudo((s) => sessionId in s.bySession);
  const state = useSudo((s) => s.stored[sessionId]);
  const locked = useLock((s) => !!s.status?.locked);
  const mode = useProfiles((s) => s.servers.find((x) => x.id === profileId)?.sudoMode ?? "ask");
  const need = needsPassword(info);
  useEffect(() => {
    if (!active || locked || hasPassword || !need || state !== undefined) return;
    void loadStoredSudo(sessionId, profileId);
  }, [active, locked, hasPassword, need, state, sessionId, profileId]);
  // Al cambiar el ajuste del servidor, volver a mirar (salvo si el usuario la olvidó a mano).
  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === mode) return;
    prevMode.current = mode;
    const st = useSudo.getState().stored[sessionId];
    if (st === "none" || st === "failed") useSudo.setState((s) => ({ stored: without(s.stored, sessionId) }));
  }, [mode, sessionId]);
}
