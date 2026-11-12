// Selección de servidores: agrupados por proyecto, con "proyecto entero" y buscador.
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { Project, ServerProfile } from "../../api/types";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";

export function userHost(s: ServerProfile): string {
  return `${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`;
}

function matches(s: ServerProfile, q: string) {
  return s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q) || s.username.toLowerCase().includes(q);
}

function connectedKey(tabs: readonly { status: string; profileId: string }[]): string {
  const ids: string[] = [];
  for (const t of tabs) if (t.status === "connected" && !ids.includes(t.profileId)) ids.push(t.profileId);
  return ids.sort().join("\n");
}

/** Perfiles con una pestaña conectada (se reutiliza su sesión). */
export function useConnectedProfiles(): Set<string> {
  const key = useTabs((s) => connectedKey(s.tabs));
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

function TriCheckbox({
  state,
  onChange,
  label,
}: {
  state: "all" | "some" | "none";
  onChange: (on: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={state === "all"}
      onChange={() => onChange(state !== "all")}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface Group {
  key: string;
  project: Project | null;
  title: string;
  servers: ServerProfile[];
}

export function ServerPicker({
  selected,
  onChange,
  focusNonce,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  focusNonce: number;
}) {
  const servers = useProfiles((s) => s.servers);
  const projects = useProfiles((s) => s.projects);
  const loaded = useProfiles((s) => s.loaded);
  const connected = useConnectedProfiles();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) void useProfiles.getState().load();
  }, [loaded]);

  useEffect(() => setQuery(""), [focusNonce]);

  const sel = useMemo(() => new Set(selected), [selected]);
  const q = query.trim().toLowerCase();

  const groups = useMemo<Group[]>(() => {
    const byId = new Map(servers.map((s) => [s.id, s]));
    const inProject = new Set<string>();
    const out: Group[] = [];
    for (const p of projects) {
      const list = p.serverIds.map((id) => byId.get(id)).filter((s): s is ServerProfile => !!s);
      list.forEach((s) => inProject.add(s.id));
      const shown = !q || p.name.toLowerCase().includes(q) ? list : list.filter((s) => matches(s, q));
      if (shown.length > 0) out.push({ key: `p:${p.id}`, project: p, title: p.name, servers: shown });
    }
    const rest = servers.filter((s) => !inProject.has(s.id) && (!q || matches(s, q)));
    if (rest.length > 0) {
      out.push({ key: "rest", project: null, title: projects.length > 0 ? "Sin proyecto" : "Servidores", servers: rest });
    }
    return out;
  }, [servers, projects, q]);

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const g of groups) for (const s of g.servers) if (!ids.includes(s.id)) ids.push(s.id);
    return ids;
  }, [groups]);

  const setMany = (ids: string[], on: boolean) => {
    const next = new Set(sel);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    // Conserva el orden de la lista de servidores.
    onChange(servers.filter((s) => next.has(s.id)).map((s) => s.id));
  };

  const groupState = (g: Group): "all" | "some" | "none" => {
    const n = g.servers.filter((s) => sel.has(s.id)).length;
    return n === 0 ? "none" : n === g.servers.length ? "all" : "some";
  };

  const total = servers.length;
  const count = servers.filter((s) => sel.has(s.id)).length;

  return (
    <div className="mr-servers">
      <div className="mr-search">
        <Search size={13} className="mr-search-icon" />
        <input
          ref={searchRef}
          className="input"
          value={query}
          placeholder="Buscar servidor o proyecto"
          aria-label="Buscar servidores"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query && (
          <button className="mr-search-clear" aria-label="Limpiar búsqueda" onClick={() => setQuery("")}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="mr-servers-bar">
        <span className="muted">
          {count} de {total} seleccionado{total === 1 ? "" : "s"}
        </span>
        <span className="mr-grow" />
        <button className="mr-link" disabled={visibleIds.length === 0} onClick={() => setMany(visibleIds, true)}>
          {q ? "Marcar resultados" : "Todos"}
        </button>
        <button className="mr-link" disabled={count === 0} onClick={() => onChange([])}>
          Ninguno
        </button>
      </div>
      <div className="mr-servers-list" role="group" aria-label="Servidores">
        {!loaded && (
          <div className="mr-empty">
            <span className="spinner" /> Cargando…
          </div>
        )}
        {loaded && total === 0 && <div className="mr-empty">Aún no tienes servidores guardados.</div>}
        {loaded && total > 0 && groups.length === 0 && <div className="mr-empty">Sin resultados para «{query.trim()}»</div>}
        {groups.map((g) => (
          <div key={g.key} className="mr-group">
            <label className="mr-group-head" title={g.project ? "Seleccionar el proyecto entero" : undefined}>
              <TriCheckbox
                state={groupState(g)}
                label={g.project ? `Seleccionar proyecto ${g.title}` : `Seleccionar ${g.title}`}
                onChange={(on) => setMany(g.servers.map((s) => s.id), on)}
              />
              {g.project && <span className="mr-chip" style={{ background: g.project.color ?? undefined }} />}
              <span className="mr-group-title">{g.title}</span>
              <span className="mr-count">
                {g.servers.filter((s) => sel.has(s.id)).length}/{g.servers.length}
              </span>
            </label>
            {g.servers.map((s) => (
              <label key={`${g.key}:${s.id}`} className={`mr-server${sel.has(s.id) ? " on" : ""}`} title={`${s.name} — ${userHost(s)}`}>
                <input type="checkbox" checked={sel.has(s.id)} onChange={(e) => setMany([s.id], e.target.checked)} />
                <span
                  className={`status-dot${connected.has(s.id) ? " on" : ""}`}
                  title={connected.has(s.id) ? "Conectado en una pestaña (se reutiliza)" : "Se conectará en segundo plano"}
                />
                <span className="mr-server-name">{s.name}</span>
                <span className="mr-server-sub mono">{userHost(s)}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
