// Estado de túneles en la interfaz: definiciones por servidor y estado en vivo por sesión.
// El motor se encarga del arranque automático, la reconexión y el cierre; aquí solo se refleja.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { EV_TUNNEL_STATUS, tunnels, type TunnelDef, type TunnelStatus } from "../../api/tunnels";

interface TunnelsState {
  /** profileId → túneles guardados (undefined = sin cargar). */
  defs: Record<string, TunnelDef[] | undefined>;
  /** sessionId → tunnelId → estado (solo los que no están parados). */
  status: Record<string, Record<string, TunnelStatus> | undefined>;
  loadDefs: (profileId: string) => Promise<void>;
  loadStatus: (sessionId: string) => Promise<void>;
  save: (def: TunnelDef) => Promise<TunnelDef>;
  remove: (def: TunnelDef) => Promise<void>;
  applyStatus: (st: TunnelStatus) => void;
}

export const useTunnels = create<TunnelsState>((set) => ({
  defs: {},
  status: {},
  loadDefs: async (profileId) => {
    const list = await tunnels.list(profileId);
    set((s) => ({ defs: { ...s.defs, [profileId]: list } }));
  },
  loadStatus: async (sessionId) => {
    const list = await tunnels.status(sessionId);
    const map: Record<string, TunnelStatus> = {};
    for (const st of list) map[st.tunnelId] = st;
    set((s) => ({ status: { ...s.status, [sessionId]: map } }));
  },
  save: async (def) => {
    const saved = await tunnels.save(def);
    set((s) => {
      const cur = s.defs[saved.profileId] ?? [];
      const exists = cur.some((t) => t.id === saved.id);
      const next = exists ? cur.map((t) => (t.id === saved.id ? saved : t)) : [...cur, saved];
      return { defs: { ...s.defs, [saved.profileId]: next } };
    });
    return saved;
  },
  remove: async (def) => {
    await tunnels.delete(def.id);
    set((s) => ({
      defs: { ...s.defs, [def.profileId]: (s.defs[def.profileId] ?? []).filter((t) => t.id !== def.id) },
    }));
  },
  applyStatus: (st) =>
    set((s) => {
      const cur = { ...(s.status[st.sessionId] ?? {}) };
      if (st.state === "stopped") delete cur[st.tunnelId];
      else cur[st.tunnelId] = st;
      return { status: { ...s.status, [st.sessionId]: cur } };
    }),
}));

let listening = false;

/** Escucha `tunnel://status` (una sola vez para toda la app). */
export function ensureTunnelEvents(): void {
  if (listening) return;
  listening = true;
  listen<TunnelStatus>(EV_TUNNEL_STATUS, (e) => useTunnels.getState().applyStatus(e.payload)).catch(() => {
    listening = false;
  });
}

/** Dirección para copiar: la que usarás en tu PC (local/SOCKS) o en el servidor (remoto). */
export function tunnelAddress(def: TunnelDef, st?: TunnelStatus): string {
  const port = st?.boundPort ?? def.bindPort;
  if (def.kind === "remote") {
    const h = isOpenBind(def.bindHost) ? "localhost" : def.bindHost;
    return `${h}:${port}`;
  }
  const local = isOpenBind(def.bindHost) || def.bindHost === "127.0.0.1" || def.bindHost === "::1";
  return `${local ? "localhost" : def.bindHost}:${port}`;
}

/** ¿Escucha para toda la red y no solo este equipo? */
export function isOpenBind(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "*" || host === "";
}

export interface TunnelTemplate {
  label: string;
  kind: TunnelDef["kind"];
  name: string;
  port: number;
}

export const TUNNEL_TEMPLATES: TunnelTemplate[] = [
  { label: "PostgreSQL", kind: "local", name: "PostgreSQL", port: 5432 },
  { label: "MySQL", kind: "local", name: "MySQL", port: 3306 },
  { label: "Redis", kind: "local", name: "Redis", port: 6379 },
  { label: "Panel web", kind: "local", name: "Panel web", port: 8080 },
  { label: "SOCKS", kind: "socks", name: "Proxy SOCKS", port: 1080 },
];

export const KIND_INFO: Record<TunnelDef["kind"], { label: string; short: string; help: string }> = {
  local: {
    label: "Local",
    short: "L",
    help:
      "Abre en tu PC un servicio del servidor. Ej.: la base de datos que solo escucha dentro del servidor " +
      "aparece en localhost:5432 de tu PC y la usas con tu programa de siempre.",
  },
  remote: {
    label: "Remoto",
    short: "R",
    help:
      "Lo contrario: muestra en el servidor un servicio de tu PC. Ej.: tu web de pruebas en el puerto 3000 " +
      "de tu PC se ve en el puerto 8080 del servidor.",
  },
  socks: {
    label: "SOCKS",
    short: "SOCKS",
    help:
      "Un proxy para navegar como si estuvieras en el servidor. Configura tu navegador (o programa) con " +
      "un proxy SOCKS5 en localhost:1080 y todo saldrá por el servidor.",
  },
};
