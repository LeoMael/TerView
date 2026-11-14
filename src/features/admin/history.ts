// Historial de cambios de administración hechos desde la app: en memoria + localStorage por perfil.
// Nunca contiene contraseñas (los planes no las llevan en los comandos; el stdin se muestra enmascarado).
import { create } from "zustand";

export interface HistoryEntry {
  id: string;
  /** ms desde epoch. */
  at: number;
  /** Nombre del servidor (pestaña). */
  server: string;
  action: string;
  /** Comandos ejecutados (sin contraseñas). */
  command: string;
  ok: boolean;
  /** Salida o error (recortado). */
  result: string;
}

export const HISTORY_LIMIT = 300;
const RESULT_MAX = 2000;
const KEY = (profileId: string) => `sshorus.admin.history.v1.${profileId}`;

function readStorage(profileId: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY(profileId));
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (e): e is HistoryEntry =>
          !!e &&
          typeof e === "object" &&
          typeof (e as HistoryEntry).at === "number" &&
          typeof (e as HistoryEntry).action === "string" &&
          typeof (e as HistoryEntry).command === "string",
      )
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeStorage(profileId: string, list: HistoryEntry[]) {
  try {
    if (list.length) localStorage.setItem(KEY(profileId), JSON.stringify(list));
    else localStorage.removeItem(KEY(profileId));
  } catch {
    // Sin almacenamiento (modo privado, cuota): el historial queda solo en memoria.
  }
}

interface HistoryState {
  byProfile: Record<string, HistoryEntry[]>;
  ensure: (profileId: string) => void;
  add: (profileId: string, e: Omit<HistoryEntry, "id" | "at">) => void;
  clear: (profileId: string) => void;
}

let seq = 0;

export const useAdminHistory = create<HistoryState>((set, get) => ({
  byProfile: {},
  ensure: (profileId) => {
    if (get().byProfile[profileId]) return;
    set((s) => ({ byProfile: { ...s.byProfile, [profileId]: readStorage(profileId) } }));
  },
  add: (profileId, e) => {
    const prev = get().byProfile[profileId] ?? readStorage(profileId);
    const entry: HistoryEntry = {
      ...e,
      result: e.result.length > RESULT_MAX ? `${e.result.slice(0, RESULT_MAX)}…` : e.result,
      id: `${Date.now()}-${++seq}`,
      at: Date.now(),
    };
    const list = [entry, ...prev].slice(0, HISTORY_LIMIT);
    writeStorage(profileId, list);
    set((s) => ({ byProfile: { ...s.byProfile, [profileId]: list } }));
  },
  clear: (profileId) => {
    writeStorage(profileId, []);
    set((s) => ({ byProfile: { ...s.byProfile, [profileId]: [] } }));
  },
}));

const EMPTY: HistoryEntry[] = [];

export function useHistoryOf(profileId: string): HistoryEntry[] {
  return useAdminHistory((s) => s.byProfile[profileId] ?? EMPTY);
}
