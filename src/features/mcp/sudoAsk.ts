// Contraseña de sudo para los comandos del asistente (petición `sudo` del motor, ver uiBridge.ts).
//
// Con «Aceptar automáticamente: todo» no se muestra nada si la contraseña ya está en memoria o guardada: el
// diálogo solo aparece (una vez) si no hay ninguna.
// Se consigue igual que en los paneles (`obtainSudoPassword`: en memoria → guardada → otra pestaña del
// mismo servidor) y, si no hay ninguna, con el diálogo de siempre (SudoDialog, mostrado por SudoAskHost).
// Queda en memoria de la conexión, la misma caché que usa la interfaz: si ya la escribiste en
// Administración no se vuelve a pedir, y al revés. El motor la pasa por stdin a un envoltorio que se la da
// a sudo; el asistente nunca la ve.
import { create } from "zustand";
import {
  detectPrivilege,
  getPrivilege,
  getSudoPassword,
  obtainSudoPassword,
  sudoPasswordNeeded,
} from "../privileges";
import { useLock } from "../lock/lockStore";
import { useTabs } from "../../stores/tabs";

/** Respuesta al motor (core.rs → `sudo_answer`). */
export type SudoReply = { elevate: false } | { elevate: true; password: string } | { canceled: true };

export interface SudoAsk {
  id: string;
  sessionId: string;
  profileId: string;
  user: string | null;
  serverName: string;
  /** El comando se aceptó con «Aceptar automáticamente» (no hubo diálogo de permiso). */
  auto: boolean;
  /** Unix ms: después se cierra solo (el motor ya no espera). */
  expiresAt: number;
}

interface SudoAskState {
  asks: SudoAsk[];
}

export const useSudoAsks = create<SudoAskState>(() => ({ asks: [] }));

const waiting = new Map<string, (given: boolean) => void>();
let seq = 0;

/** Muestra el diálogo de la contraseña y espera a que se cierre. true = quedó en memoria. */
function askInDialog(a: Omit<SudoAsk, "id">): Promise<boolean> {
  const id = `sudo-${++seq}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    useSudoAsks.setState((s) => ({ asks: [...s.asks, { ...a, id }] }));
  });
}

/** El diálogo se cerró (confirmada, cancelada, tiempo agotado o bloqueo). */
export function finishSudoAsk(id: string): void {
  const ask = useSudoAsks.getState().asks.find((a) => a.id === id);
  useSudoAsks.setState((s) => ({ asks: s.asks.filter((a) => a.id !== id) }));
  const resolve = waiting.get(id);
  waiting.delete(id);
  resolve?.(!!ask && getSudoPassword(ask.sessionId) !== undefined && !useLock.getState().status?.locked);
}

/** Al bloquear TerView: se cierran todos (el motor ya lo deniega). */
export function cancelAllSudoAsks(): void {
  for (const a of useSudoAsks.getState().asks) finishSudoAsk(a.id);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Petición `sudo` del motor: { sessionId, profileId, serverName, timeoutSecs }. */
export async function sudoForAssistant(payload: Record<string, unknown>): Promise<SudoReply> {
  const sessionId = str(payload.sessionId);
  if (!sessionId) throw new Error("Falta la conexión");
  const tab = useTabs.getState().tabs.find((t) => t.sessionId === sessionId && t.status !== "closed");
  if (!tab) throw new Error("Esa conexión ya no está abierta en TerView");
  if (useLock.getState().status?.locked) throw new Error("TerView está bloqueado");
  const profileId = str(payload.profileId) ?? tab.profileId;
  const info = getPrivilege(sessionId) ?? (await detectPrivilege(sessionId));
  if (!sudoPasswordNeeded(info)) return { elevate: false };

  const found = await obtainSudoPassword(sessionId, profileId);
  if (!found.ok) {
    const secs = typeof payload.timeoutSecs === "number" && payload.timeoutSecs > 0 ? payload.timeoutSecs : 120;
    const given = await askInDialog({
      sessionId,
      profileId,
      user: info.user,
      serverName: str(payload.serverName) ?? tab.title,
      auto: payload.auto === true,
      expiresAt: Date.now() + secs * 1000,
    });
    if (!given) return { canceled: true };
  }
  if (useLock.getState().status?.locked) throw new Error("TerView está bloqueado");
  const password = getSudoPassword(sessionId);
  return password === undefined ? { canceled: true } : { elevate: true, password };
}
