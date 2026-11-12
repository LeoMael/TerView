// Sincronizar configuración: qué se sube (sin contraseñas) y cómo se fusiona al importar.
import type { Project, ServerProfile, Snippet } from "../../api/types";

export const SYNC_FORMAT = "terview-config";

export interface SyncPayload {
  format: typeof SYNC_FORMAT;
  version: 1;
  exportedAt: string;
  servers: ServerProfile[];
  projects: Project[];
  snippets: Snippet[];
}

/** Copia sin secretos (el motor además rechaza campos como «password» o «token»). */
export function buildPayload(servers: ServerProfile[], projects: Project[], snippets: Snippet[]): SyncPayload {
  return {
    format: SYNC_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    // Copia completa del perfil (los perfiles nunca llevan secretos: viven en el llavero).
    servers: servers.map((s) => ({ ...s })),
    projects: projects.map((p) => ({ ...p })),
    snippets: snippets.map((s) => ({ ...s })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Valida lo descifrado. Lanza un error legible si no es una copia de TerView. */
export function parsePayload(v: unknown): SyncPayload {
  if (!isObj(v) || v.format !== SYNC_FORMAT) throw new Error("La copia no tiene el formato de TerView");
  const arr = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).filter(isObj) : []);
  const servers: ServerProfile[] = arr("servers")
    .filter((s) => str(s.id) && str(s.name) && str(s.host) && str(s.username))
    .map((s) => ({
      ...(s as Partial<ServerProfile>),
      id: s.id as string,
      name: s.name as string,
      host: s.host as string,
      port: typeof s.port === "number" ? s.port : 22,
      username: s.username as string,
      auth: s.auth === "key" || s.auth === "agent" ? s.auth : "password",
      keyPath: str(s.keyPath),
      defaultPath: str(s.defaultPath),
      color: str(s.color),
    }));
  const projects: Project[] = arr("projects")
    .filter((p) => str(p.id) && str(p.name))
    .map((p) => ({
      ...(p as Partial<Project>),
      id: p.id as string,
      name: p.name as string,
      serverIds: Array.isArray(p.serverIds) ? p.serverIds.filter((x): x is string => typeof x === "string") : [],
      bookmarks: Array.isArray(p.bookmarks)
        ? p.bookmarks.filter(isObj).flatMap((b) =>
            str(b.serverId) && str(b.path)
              ? [{ serverId: b.serverId as string, path: b.path as string, label: str(b.label) }]
              : [],
          )
        : [],
      color: str(p.color),
    }));
  const snippets: Snippet[] = arr("snippets")
    .filter((s) => str(s.name) && str(s.command))
    .map((s) => ({
      id: str(s.id) ?? "",
      name: s.name as string,
      description: str(s.description),
      command: s.command as string,
      category: str(s.category) ?? "",
      scope: s.scope === "project" || s.scope === "server" ? s.scope : "global",
      scopeId: str(s.scopeId),
      dangerous: s.dangerous === true,
      sudo: s.sudo === true,
      readOnly: s.readOnly === true,
    }));
  return {
    format: SYNC_FORMAT,
    version: 1,
    exportedAt: str(v.exportedAt) ?? "",
    servers,
    projects,
    snippets,
  };
}

export type ItemState = "new" | "same" | "changed";

export interface PlanItem<T> {
  remote: T;
  /** Elemento local equivalente (mismo id, o mismo host/usuario, o mismo nombre). */
  local: T | null;
  state: ItemState;
}

export interface ImportPlan {
  servers: PlanItem<ServerProfile>[];
  projects: PlanItem<Project>[];
  snippets: PlanItem<Snippet>[];
  /** id remoto → id local de servidores. */
  serverMap: Record<string, string>;
  projectMap: Record<string, string>;
}

const serverKey = (s: ServerProfile) => `${s.host.toLowerCase()}|${s.port}|${s.username}`;
const sameServer = (a: ServerProfile, b: ServerProfile) =>
  a.name === b.name &&
  serverKey(a) === serverKey(b) &&
  a.auth === b.auth &&
  a.keyPath === b.keyPath &&
  a.defaultPath === b.defaultPath &&
  a.color === b.color;

export function planImport(
  remote: SyncPayload,
  local: { servers: ServerProfile[]; projects: Project[]; snippets: Snippet[] },
): ImportPlan {
  const serverMap: Record<string, string> = {};
  const servers = remote.servers.map((r): PlanItem<ServerProfile> => {
    const l =
      local.servers.find((x) => x.id === r.id) ?? local.servers.find((x) => serverKey(x) === serverKey(r)) ?? null;
    serverMap[r.id] = l?.id ?? r.id;
    return { remote: r, local: l, state: !l ? "new" : sameServer(l, r) ? "same" : "changed" };
  });

  const projectMap: Record<string, string> = {};
  const projects = remote.projects.map((r): PlanItem<Project> => {
    const l =
      local.projects.find((x) => x.id === r.id) ??
      local.projects.find((x) => x.name.trim().toLowerCase() === r.name.trim().toLowerCase()) ??
      null;
    projectMap[r.id] = l?.id ?? r.id;
    const mapped = r.serverIds.map((id) => serverMap[id] ?? id);
    const same =
      l !== null &&
      l.name === r.name &&
      l.color === r.color &&
      mapped.length === l.serverIds.length &&
      mapped.every((id) => l.serverIds.includes(id)) &&
      r.bookmarks.length === l.bookmarks.length;
    return { remote: r, local: l, state: !l ? "new" : same ? "same" : "changed" };
  });

  const snippets = remote.snippets.map((r): PlanItem<Snippet> => {
    const l =
      local.snippets.find((x) => r.id && x.id === r.id) ??
      local.snippets.find((x) => x.name === r.name && x.command === r.command) ??
      null;
    const same =
      l !== null &&
      l.name === r.name &&
      l.command === r.command &&
      l.description === r.description &&
      l.category === r.category &&
      l.dangerous === r.dangerous &&
      l.sudo === r.sudo &&
      l.readOnly === r.readOnly;
    return { remote: r, local: l, state: !l ? "new" : same ? "same" : "changed" };
  });

  return { servers, projects, snippets, serverMap, projectMap };
}

export function countStates<T>(items: PlanItem<T>[]): Record<ItemState, number> {
  const c: Record<ItemState, number> = { new: 0, same: 0, changed: 0 };
  for (const i of items) c[i.state]++;
  return c;
}

/** Servidor a guardar (conserva el id local si ya existía). */
export function serverToSave(i: PlanItem<ServerProfile>): ServerProfile {
  return { ...i.remote, id: i.local?.id ?? i.remote.id };
}

/** Proyecto a guardar con ids de servidores traducidos y filtrados a los que existen. */
export function projectToSave(i: PlanItem<Project>, plan: ImportPlan, knownServers: Set<string>): Project {
  const map = (id: string) => plan.serverMap[id] ?? id;
  return {
    ...i.remote,
    id: i.local?.id ?? i.remote.id,
    serverIds: [...new Set(i.remote.serverIds.map(map))].filter((id) => knownServers.has(id)),
    bookmarks: i.remote.bookmarks
      .map((b) => ({ ...b, serverId: map(b.serverId) }))
      .filter((b) => knownServers.has(b.serverId)),
  };
}

/** Comando a guardar: nuevos con id "" (el motor exige id conocido para actualizar). */
export function snippetToSave(i: PlanItem<Snippet>, plan: ImportPlan): Snippet {
  let scopeId = i.remote.scopeId;
  if (scopeId && i.remote.scope === "server") scopeId = plan.serverMap[scopeId] ?? scopeId;
  if (scopeId && i.remote.scope === "project") scopeId = plan.projectMap[scopeId] ?? scopeId;
  return { ...i.remote, id: i.local?.id ?? "", scopeId };
}
