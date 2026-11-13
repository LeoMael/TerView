// Hosts ya guardados en el editor de servidor (funciones puras): sugerencias para el campo Host
// y aviso de servidor repetido.
import type { ServerProfile } from "../api/types";

/** Host comparable: sin espacios y en minúsculas (los nombres de host no distinguen mayúsculas). */
export function normHost(h: string): string {
  return h.trim().toLowerCase();
}

/** Puerto efectivo (vacío o 0 → 22). */
function normPort(p: number | string): number {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : 22;
}

/** «usuario@host:puerto» (sin «:22»). */
export function serverAddress(s: Pick<ServerProfile, "username" | "host" | "port">): string {
  const port = normPort(s.port);
  return `${s.username}@${s.host}${port === 22 ? "" : `:${port}`}`;
}

/**
 * Servidores guardados para sugerir en el campo Host (sin el que se edita).
 * Con `query`, solo los que lo contienen en el host o en el nombre; los que empiezan por él, primero.
 */
export function hostSuggestions(
  servers: readonly ServerProfile[],
  selfId: string,
  query = "",
  max = 50,
): ServerProfile[] {
  const q = normHost(query);
  const others = servers.filter((s) => s.id !== selfId && s.host.trim() !== "");
  if (!q) return others.slice(0, max);
  const starts: ServerProfile[] = [];
  const contains: ServerProfile[] = [];
  for (const s of others) {
    const h = normHost(s.host);
    if (h.startsWith(q)) starts.push(s);
    else if (h.includes(q) || s.name.toLowerCase().includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, max);
}

export interface ServerMatches {
  /** Otro servidor con el mismo host, puerto y usuario. */
  exact: ServerProfile | null;
  /** Otros servidores con el mismo host (otro usuario o puerto). */
  sameHost: ServerProfile[];
}

/** Servidores guardados que coinciden con lo escrito (sin compararlo consigo mismo). */
export function findMatches(
  servers: readonly ServerProfile[],
  selfId: string,
  host: string,
  port: number | string,
  username: string,
): ServerMatches {
  const h = normHost(host);
  if (!h) return { exact: null, sameHost: [] };
  const p = normPort(port);
  const u = username.trim();
  let exact: ServerProfile | null = null;
  const sameHost: ServerProfile[] = [];
  for (const s of servers) {
    if (s.id === selfId || normHost(s.host) !== h) continue;
    if (!exact && u !== "" && s.username.trim() === u && normPort(s.port) === p) exact = s;
    else sameHost.push(s);
  }
  return { exact, sameHost };
}
