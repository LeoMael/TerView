// Túneles (port forwarding). Espejo de `src-tauri/src/tunnels/types.rs`.
import { call } from "./core";

/** Payload: `TunnelStatus`. Cambios de estado al momento; contadores ~1 vez por segundo. */
export const EV_TUNNEL_STATUS = "tunnel://status";

/** local = -L · remote = -R · socks = -D */
export type TunnelKind = "local" | "remote" | "socks";

/**
 * Túnel guardado de un servidor.
 * - local / socks: `bind*` es dónde se escucha en tu PC; `dest*` (solo local) se ve desde el servidor.
 * - remote: `bind*` es dónde escucha el servidor; `dest*` está en tu PC (o tu red).
 */
export interface TunnelDef {
  /** "" = nuevo. */
  id: string;
  profileId: string;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
  autoStart: boolean;
}

export type TunnelState = "starting" | "active" | "waiting" | "stopped" | "error";

export interface TunnelStatus {
  sessionId: string;
  tunnelId: string;
  state: TunnelState;
  /** Motivo del error o de la espera. */
  message: string | null;
  /** Último fallo de una conexión concreta (el túnel sigue activo). */
  lastError: string | null;
  connections: number;
  totalConnections: number;
  /** De tu PC hacia el servidor. */
  bytesUp: number;
  /** Del servidor hacia tu PC. */
  bytesDown: number;
  /** Puerto real en escucha. */
  boundPort: number | null;
  /** Unix ms. */
  startedAt: number;
}

export const tunnels = {
  list: (profileId: string) => call<TunnelDef[]>("tunnels_list", { profileId }),
  /** Crea (id "") o actualiza. Si estaba activo y cambió su conexión, el motor lo reinicia. */
  save: (tunnel: TunnelDef) => call<TunnelDef>("tunnels_save", { tunnel }),
  /** Borra y lo para donde esté activo. */
  delete: (id: string) => call<void>("tunnels_delete", { id }),
  /** Errores claros: "El puerto 5432 ya está en uso en tu PC", servidor que no permite túneles… */
  start: (sessionId: string, tunnelId: string) => call<TunnelStatus>("tunnel_start", { sessionId, tunnelId }),
  stop: (sessionId: string, tunnelId: string) => call<void>("tunnel_stop", { sessionId, tunnelId }),
  /** Estado de los túneles en marcha (o con error) de una sesión. */
  status: (sessionId: string) => call<TunnelStatus[]>("tunnels_status", { sessionId }),
};
