// Relación proyecto ↔ servidor (funciones puras). El proyecto guarda la lista `serverIds`;
// un servidor puede estar en varios proyectos o en ninguno.
import type { Project, ServerProfile } from "../api/types";

/** Servidores guardados que aún no están en el proyecto (mismo orden que la lista). */
export function serversNotInProject(servers: readonly ServerProfile[], project: Project): ServerProfile[] {
  const inProject = new Set(project.serverIds);
  return servers.filter((s) => !inProject.has(s.id));
}

/**
 * Proyecto que muestra el selector del editor de servidor al abrirse.
 * - Abierto desde un proyecto (`fromProjectId`): ese proyecto, si existe (y, si el servidor ya
 *   existía, si de verdad está en él).
 * - Si no: el primer proyecto que contiene el servidor, o "" (ninguno).
 */
export function initialProjectFor(
  projects: readonly Project[],
  serverId: string,
  fromProjectId?: string | null,
): string {
  const from = fromProjectId ? projects.find((p) => p.id === fromProjectId) : undefined;
  if (from && (!serverId || from.serverIds.includes(serverId))) return from.id;
  if (!serverId) return "";
  return projects.find((p) => p.serverIds.includes(serverId))?.id ?? "";
}

/**
 * Proyectos que hay que guardar para mover el servidor del proyecto `fromId` al `toId`
 * ("" = ninguno). Al salir de un proyecto se quitan también sus marcadores de ese servidor.
 * Los demás proyectos en los que esté el servidor no se tocan.
 */
export function projectChanges(
  projects: readonly Project[],
  serverId: string,
  fromId: string,
  toId: string,
): Project[] {
  if (fromId === toId) return [];
  const out: Project[] = [];
  const from = projects.find((p) => p.id === fromId);
  if (from && from.serverIds.includes(serverId)) {
    out.push({
      ...from,
      serverIds: from.serverIds.filter((x) => x !== serverId),
      bookmarks: from.bookmarks.filter((b) => b.serverId !== serverId),
    });
  }
  const to = projects.find((p) => p.id === toId);
  if (to && !to.serverIds.includes(serverId)) {
    out.push({ ...to, serverIds: [...to.serverIds, serverId] });
  }
  return out;
}
