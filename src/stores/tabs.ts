// Pestañas de conexión abiertas. BASE compartida (no cambiar la API sin coordinar).
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ssh } from "../api/ssh";
import {
  EV_SESSION_CLOSED,
  EV_SESSION_RECONNECTED,
  EV_SESSION_RECONNECTING,
  type SessionClosed,
  type SessionInfo,
  type SessionReconnecting,
} from "../api/types";

export interface SessionTab {
  /** id de la pestaña (= sessionId) */
  id: string;
  sessionId: string;
  profileId: string;
  title: string;
  color: string | null;
  /** "reconnecting": se cayó y el motor está reintentando (mismo sessionId).
   *  "closed": se perdió definitivamente (o se desconectó). */
  status: "connected" | "reconnecting" | "closed";
  closedReason: string | null;
  /** Datos del reintento en curso (status "reconnecting"). */
  reconnect: SessionReconnecting | null;
  /** Se incrementa en cada reconexión exitosa: los componentes lo usan para reabrir
   *  terminales y recargar el explorador. */
  reconnectCount: number;
  /** Carpeta inicial del explorador (null = home). */
  initialPath: string | null;
}

interface TabsState {
  tabs: SessionTab[];
  activeTabId: string | null;
  openSession: (info: SessionInfo, opts?: { color?: string | null; initialPath?: string | null }) => string;
  /** Cierra la pestaña y desconecta. */
  closeTab: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  markClosed: (sessionId: string, reason: string) => void;
  markReconnecting: (info: SessionReconnecting) => void;
  markReconnected: (sessionId: string) => void;
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  openSession: (info, opts = {}) => {
    const tab: SessionTab = {
      id: info.id,
      sessionId: info.id,
      profileId: info.profileId,
      title: info.name,
      color: opts.color ?? null,
      status: "connected",
      closedReason: null,
      reconnect: null,
      reconnectCount: 0,
      initialPath: opts.initialPath ?? null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },
  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) activeTabId = tabs[Math.max(0, idx - 1)]?.id ?? null;
      return { tabs, activeTabId };
    });
    if (tab && tab.status !== "closed") {
      try {
        await ssh.disconnect(tab.sessionId);
      } catch {
        /* ya estaba cerrada */
      }
    }
  },
  setActive: (id) => set({ activeTabId: id }),
  markClosed: (sessionId, reason) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === sessionId ? { ...t, status: "closed", closedReason: reason, reconnect: null } : t,
      ),
    })),
  markReconnecting: (info) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === info.sessionId && t.status !== "closed"
          ? { ...t, status: "reconnecting", reconnect: info, closedReason: info.reason }
          : t,
      ),
    })),
  markReconnected: (sessionId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === sessionId && t.status !== "closed"
          ? { ...t, status: "connected", reconnect: null, closedReason: null, reconnectCount: t.reconnectCount + 1 }
          : t,
      ),
    })),
}));

/** Llamar una vez al iniciar la app. */
export async function initTabsListeners() {
  const un = await Promise.all([
    listen<SessionClosed>(EV_SESSION_CLOSED, (e) => {
      useTabs.getState().markClosed(e.payload.sessionId, e.payload.reason);
    }),
    listen<SessionReconnecting>(EV_SESSION_RECONNECTING, (e) => {
      useTabs.getState().markReconnecting(e.payload);
    }),
    listen<SessionInfo>(EV_SESSION_RECONNECTED, (e) => {
      useTabs.getState().markReconnected(e.payload.id);
    }),
  ]);
  return () => un.forEach((u) => u());
}
