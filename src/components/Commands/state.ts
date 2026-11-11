// Estado compartido de la Biblioteca de comandos: "Mis comandos" y cachés por sesión.
import { create } from "zustand";
import { snippets } from "../../api/snippets";
import type { Project, Snippet } from "../../api/types";
import { toast } from "../../stores/toasts";
import { CATALOG, type CatalogEntry, type CatalogVar, type Distro, varHint } from "./catalog";
import { fuzzyScore, parseVars } from "./template";

export const MY_CATEGORY = "★ Mis comandos";

/** Elemento que muestra la interfaz: entrada del catálogo o comando propio. */
export interface CommandItem extends CatalogEntry {
  custom?: Snippet;
}

// ───────── Mis comandos ─────────

interface SnippetsState {
  list: Snippet[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (s: Snippet) => Promise<Snippet | null>;
  remove: (id: string) => Promise<boolean>;
}

let loading: Promise<void> | null = null;

export const useSnippets = create<SnippetsState>((set) => ({
  list: [],
  loaded: false,
  load: () => {
    loading ??= (async () => {
      try {
        set({ list: await snippets.load(), loaded: true });
      } catch (e) {
        set({ loaded: true });
        toast.error("No se pudieron cargar tus comandos", e);
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  save: async (s) => {
    try {
      const saved = await snippets.save(s);
      set((st) => {
        const i = st.list.findIndex((x) => x.id === saved.id);
        if (i < 0) return { list: [...st.list, saved] };
        const list = st.list.slice();
        list[i] = saved;
        return { list };
      });
      return saved;
    } catch (e) {
      toast.error("No se pudo guardar el comando", e);
      return null;
    }
  },
  remove: async (id) => {
    try {
      await snippets.delete(id);
      set((st) => ({ list: st.list.filter((x) => x.id !== id) }));
      return true;
    } catch (e) {
      toast.error("No se pudo eliminar el comando", e);
      return false;
    }
  },
}));

export function snippetToItem(s: Snippet): CommandItem {
  const vars: Record<string, CatalogVar> = {};
  for (const v of parseVars(s.command)) vars[v.name] = { ...(varHint(v.name) ?? {}), default: v.default };
  return {
    id: `my.${s.id}`,
    category: MY_CATEGORY,
    group: s.category || "Mis comandos",
    name: s.name,
    description: s.description ?? undefined,
    command: s.command,
    dangerous: s.dangerous,
    sudo: s.sudo,
    readOnly: s.readOnly,
    vars: Object.keys(vars).length ? vars : undefined,
    custom: s,
  };
}

/** ¿Se muestra este comando propio en el servidor `profileId`? */
export function snippetVisible(s: Snippet, profileId: string, projects: Project[]): boolean {
  if (s.scope === "global") return true;
  if (s.scope === "server") return s.scopeId === profileId;
  const p = projects.find((x) => x.id === s.scopeId);
  return !!p && p.serverIds.includes(profileId);
}

/** Catálogo filtrado por distribución (si se conoce) + comandos propios visibles. */
export function buildItems(
  distro: Distro | null,
  mine: Snippet[],
  profileId: string,
  projects: Project[],
): CommandItem[] {
  const base = CATALOG.filter((e) => !e.distro || !distro || e.distro === distro);
  const own = mine.filter((s) => snippetVisible(s, profileId, projects)).map(snippetToItem);
  return [...base, ...own];
}

/** Búsqueda difusa por nombre, comando, categoría y descripción (mejor primero). */
export function searchItems(items: CommandItem[], query: string): CommandItem[] {
  const scored: { item: CommandItem; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, [
      { text: item.name, weight: 3 },
      { text: item.command, weight: 2 },
      { text: `${item.category} ${item.group}`, weight: 1.5 },
      { text: item.description ?? "", weight: 1 },
    ]);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

// ───────── Cachés por sesión ─────────

export interface SessionInfoCache {
  distro: Distro | null;
  /** "alpine", "fedora"… */
  osId: string | null;
  osName: string | null;
}

const sessionInfo = new Map<string, Promise<SessionInfoCache>>();
const suggestions = new Map<string, Promise<string[]>>();

export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function distroFromOs(os: Record<string, string>): Distro | null {
  const ids = `${os.ID ?? ""} ${os.ID_LIKE ?? ""}`.toLowerCase();
  if (/\b(alpine)\b/.test(ids)) return "apk";
  if (/\b(fedora|rhel|centos|rocky|almalinux|ol|amzn|suse|opensuse)\b/.test(ids)) return "rpm";
  if (/\b(debian|ubuntu|linuxmint|pop|raspbian|kali)\b/.test(ids)) return "deb";
  return null;
}

export function getSessionInfo(sessionId: string): Promise<SessionInfoCache> {
  let p = sessionInfo.get(sessionId);
  if (!p) {
    p = snippets
      .exec(sessionId, "cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null", 10)
      .then((r) => {
        const os = parseOsRelease(r.stdout);
        return { distro: distroFromOs(os), osId: os.ID ?? null, osName: os.PRETTY_NAME ?? os.NAME ?? null };
      })
      .catch(() => {
        sessionInfo.delete(sessionId);
        return { distro: null, osId: null, osName: null };
      });
    sessionInfo.set(sessionId, p);
  }
  return p;
}

/** Fija la info detectada (p. ej. desde "Analizar servidor"). */
export function setSessionInfo(sessionId: string, info: SessionInfoCache) {
  sessionInfo.set(sessionId, Promise.resolve(info));
}

export interface Suggestion {
  value: string;
  detail?: string;
}

/** Opciones sugeridas por el servidor para un comando `suggest` (caché por sesión). */
export async function getSuggestions(sessionId: string, cmd: string, refresh = false): Promise<Suggestion[]> {
  const key = `${sessionId}\n${cmd}`;
  let p = suggestions.get(key);
  if (!p || refresh) {
    p = snippets.exec(sessionId, cmd, 10).then((r) => {
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const raw of r.stdout.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!line.trim() || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
        if (lines.length >= 300) break;
      }
      return lines;
    });
    suggestions.set(key, p);
    p.catch(() => suggestions.delete(key));
  }
  const lines = await p;
  return lines.map((l) => {
    const tab = l.indexOf("\t");
    return tab >= 0 ? { value: l.slice(0, tab).trim(), detail: l.slice(tab + 1).trim() } : { value: l.trim() };
  });
}
