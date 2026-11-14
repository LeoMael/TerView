// Mapa de un proyecto: todos sus servidores conectados en un mismo lienzo (con las conexiones entre ellos).
import { useCallback, useEffect, useRef, useState } from "react";
import { Plug, Waypoints, X } from "lucide-react";
import { connectToMany } from "../../features/connect";
import { collectServer } from "../../features/infra/collect";
import type { NavTarget, ServerSnapshot } from "../../features/infra/graph";
import { closeProjectMap, useInfraNav, useProjectMap } from "../../features/infra/store";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { InfraMapView } from "./InfraMapView";

function offline(id: string, name: string, host: string): ServerSnapshot {
  return {
    id,
    name,
    host,
    sessionId: null,
    error: null,
    offline: true,
    elevated: false,
    me: null,
    ports: null,
    web: null,
    containers: [],
    extra: null,
    userServices: {},
    notes: ["sin conexión"],
  };
}

export function ProjectMap() {
  const projectId = useProjectMap((s) => s.projectId);
  const preset = useProjectMap((s) => s.preset);
  const nonce = useProjectMap((s) => s.nonce);
  const project = useProfiles((s) => s.projects.find((p) => p.id === projectId) ?? null);
  const servers = useProfiles((s) => s.servers);
  const tabs = useTabs((s) => s.tabs);
  const [snaps, setSnaps] = useState<ServerSnapshot[] | null>(preset);
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);

  const members = (project?.serverIds ?? []).map((id) => servers.find((s) => s.id === id)).filter((s) => !!s);
  const sessionOf = (profileId: string) => tabs.filter((t) => t.profileId === profileId && t.status === "connected").slice(-1)[0]?.sessionId ?? null;
  const missing = members.filter((s) => !sessionOf(s.id));

  const load = useCallback(async () => {
    if (preset) return;
    const g = ++gen.current;
    setLoading(true);
    const { servers: all, projects } = useProfiles.getState();
    const p = projects.find((x) => x.id === projectId);
    const list = (p?.serverIds ?? []).map((id) => all.find((s) => s.id === id)).filter((s) => !!s);
    const live = useTabs.getState().tabs;
    const out = await Promise.all(
      list.map((s) => {
        const sid = live.filter((t) => t.profileId === s.id && t.status === "connected").slice(-1)[0]?.sessionId;
        return sid ? collectServer({ profileId: s.id, name: s.name, host: s.host, sessionId: sid }) : Promise.resolve(offline(s.id, s.name, s.host));
      }),
    );
    if (g !== gen.current) return;
    setSnaps(out);
    setLoading(false);
  }, [projectId, preset]);

  useEffect(() => {
    setSnaps(preset);
    void load();
  }, [nonce, preset, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".modal-backdrop")) closeProjectMap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nav = (serverId: string, t: NavTarget) => {
    const sid = snaps?.find((s) => s.id === serverId)?.sessionId ?? sessionOf(serverId);
    if (!sid) return;
    useTabs.getState().setActive(sid);
    closeProjectMap();
    useInfraNav.getState().open(sid, t);
  };

  const name = project?.name ?? "proyecto";
  return (
    <div className="im-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeProjectMap()}>
      <div className="im-panel" role="dialog" aria-modal="true" aria-label={`Mapa de ${name}`} tabIndex={-1}>
        <div className="im-panel-head">
          <Waypoints size={17} />
          <h2>Mapa · {name}</h2>
          <button className="icon-btn" onClick={closeProjectMap} title="Cerrar" aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
        <div className="im-panel-body">
          <InfraMapView
            snapshots={snaps}
            loading={loading}
            onRefresh={() => void load()}
            onNav={nav}
            name={`mapa-${name}`}
            extraTools={
              missing.length > 0 && !preset ? (
                <button
                  className="btn btn-sm"
                  onClick={() => void connectToMany(missing).then(() => setTimeout(() => void load(), 300))}
                  title={missing.map((s) => s.name).join(", ")}
                >
                  <Plug size={13} /> Conectar ({missing.length})
                </button>
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}
