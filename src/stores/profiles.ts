// Servidores y proyectos guardados. DUEÑO: agente Almacenamiento/Sidebar.
import { create } from "zustand";
import { profiles } from "../api/profiles";
import type { Bookmark, Project, ServerProfile } from "../api/types";
import { toast } from "./toasts";

interface ProfilesState {
  servers: ServerProfile[];
  projects: Project[];
  loaded: boolean;
  /** profileIds con una conexión en curso (spinner en la barra lateral). */
  connecting: Record<string, true>;

  load: () => Promise<void>;
  /** Crea o actualiza. `secret`: contraseña/frase a guardar ("" = borrar, undefined = no tocar).
   * `sudoSecret`: igual, para la contraseña de sudo guardada. Van a la bóveda o, sin PIN, al llavero. */
  saveServer: (server: ServerProfile, secret?: string, sudoSecret?: string) => Promise<ServerProfile | null>;
  deleteServer: (id: string) => Promise<boolean>;
  /** Copia el servidor (y sus contraseñas guardadas: conexión y sudo). */
  duplicateServer: (id: string) => Promise<ServerProfile | null>;
  /** Guarda varios servidores nuevos (p. ej. importados de ~/.ssh/config). Devuelve cuántos se guardaron. */
  importServers: (list: ServerProfile[]) => Promise<number>;
  saveProject: (project: Project) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<boolean>;
  addServerToProject: (projectId: string, serverId: string) => Promise<boolean>;
  addBookmark: (projectId: string, bookmark: Bookmark) => Promise<boolean>;
  removeBookmark: (projectId: string, serverId: string, path: string) => Promise<boolean>;

  setConnecting: (profileId: string, on: boolean) => void;
  getServer: (id: string) => ServerProfile | undefined;
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

let loading: Promise<void> | null = null;

export const useProfiles = create<ProfilesState>((set, get) => ({
  servers: [],
  projects: [],
  loaded: false,
  connecting: {},

  load: () => {
    // Varias partes de la interfaz pueden pedir la carga a la vez: una sola petición.
    loading ??= (async () => {
      try {
        const d = await profiles.load();
        set({ servers: d.servers, projects: d.projects, loaded: true });
      } catch (e) {
        set({ loaded: true });
        toast.error("No se pudieron cargar los servidores", e);
      } finally {
        loading = null;
      }
    })();
    return loading;
  },

  saveServer: async (server, secret, sudoSecret) => {
    let saved: ServerProfile;
    try {
      saved = await profiles.saveServer(server);
    } catch (e) {
      toast.error("No se pudo guardar el servidor", e);
      return null;
    }
    set((s) => ({ servers: upsert(s.servers, saved) }));
    if (secret !== undefined) {
      try {
        await profiles.setSecret(saved.id, secret === "" ? null : secret);
      } catch (e) {
        toast.error("Servidor guardado, pero no la contraseña", e);
      }
    }
    if (sudoSecret !== undefined) {
      try {
        await profiles.setSecret(saved.id, sudoSecret === "" ? null : sudoSecret, "sudo");
      } catch (e) {
        toast.error("Servidor guardado, pero no la contraseña de sudo", e);
      }
    }
    return saved;
  },

  deleteServer: async (id) => {
    try {
      await profiles.deleteServer(id);
    } catch (e) {
      toast.error("No se pudo eliminar el servidor", e);
      return false;
    }
    // El motor también limpia los proyectos: reflejamos lo mismo aquí.
    set((s) => ({
      servers: s.servers.filter((x) => x.id !== id),
      projects: s.projects.map((p) => ({
        ...p,
        serverIds: p.serverIds.filter((x) => x !== id),
        bookmarks: p.bookmarks.filter((b) => b.serverId !== id),
      })),
    }));
    return true;
  },

  duplicateServer: async (id) => {
    let copy: ServerProfile;
    try {
      copy = await profiles.duplicateServer(id);
    } catch (e) {
      toast.error("No se pudo duplicar el servidor", e);
      return null;
    }
    // El motor la coloca justo debajo del original y la añade a sus mismos proyectos.
    set((s) => {
      const i = s.servers.findIndex((x) => x.id === id);
      const servers = s.servers.slice();
      servers.splice(i < 0 ? servers.length : i + 1, 0, copy);
      const projects = s.projects.map((p) =>
        p.serverIds.includes(id) ? { ...p, serverIds: [...p.serverIds, copy.id] } : p,
      );
      return { servers, projects };
    });
    return copy;
  },

  importServers: async (list) => {
    let n = 0;
    for (const srv of list) {
      try {
        const saved = await profiles.saveServer({ ...srv, id: "" });
        set((s) => ({ servers: upsert(s.servers, saved) }));
        n++;
      } catch (e) {
        toast.error(`No se pudo importar ${srv.name}`, e);
      }
    }
    return n;
  },

  saveProject: async (project) => {
    try {
      const saved = await profiles.saveProject(project);
      set((s) => ({ projects: upsert(s.projects, saved) }));
      return saved;
    } catch (e) {
      toast.error("No se pudo guardar el proyecto", e);
      return null;
    }
  },

  deleteProject: async (id) => {
    try {
      await profiles.deleteProject(id);
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
      return true;
    } catch (e) {
      toast.error("No se pudo eliminar el proyecto", e);
      return false;
    }
  },

  addServerToProject: async (projectId, serverId) => {
    const p = get().projects.find((x) => x.id === projectId);
    if (!p) return false;
    if (p.serverIds.includes(serverId)) return true;
    return (await get().saveProject({ ...p, serverIds: [...p.serverIds, serverId] })) !== null;
  },

  addBookmark: async (projectId, bookmark) => {
    const p = get().projects.find((x) => x.id === projectId);
    if (!p) return false;
    const exists = p.bookmarks.some((b) => b.serverId === bookmark.serverId && b.path === bookmark.path);
    const bookmarks = exists
      ? p.bookmarks.map((b) => (b.serverId === bookmark.serverId && b.path === bookmark.path ? bookmark : b))
      : [...p.bookmarks, bookmark];
    return (await get().saveProject({ ...p, bookmarks })) !== null;
  },

  removeBookmark: async (projectId, serverId, path) => {
    const p = get().projects.find((x) => x.id === projectId);
    if (!p) return false;
    const bookmarks = p.bookmarks.filter((b) => !(b.serverId === serverId && b.path === path));
    return (await get().saveProject({ ...p, bookmarks })) !== null;
  },

  setConnecting: (profileId, on) =>
    set((s) => {
      const connecting = { ...s.connecting };
      if (on) connecting[profileId] = true;
      else delete connecting[profileId];
      return { connecting };
    }),

  getServer: (id) => get().servers.find((s) => s.id === id),
}));
