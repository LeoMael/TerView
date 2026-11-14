// Mapa de un servidor (Administración → Mapa). Se lee al abrirlo por primera vez y con «Actualizar».
import { useCallback, useEffect, useRef, useState } from "react";
import { collectServer } from "../../features/infra/collect";
import type { NavTarget, ServerSnapshot } from "../../features/infra/graph";
import { useInfraNav } from "../../features/infra/store";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { InfraMapView } from "./InfraMapView";

export function ServerMap({ sessionId, profileId, active, disabled }: { sessionId: string; profileId: string; active: boolean; disabled: boolean }) {
  const profile = useProfiles((s) => s.servers.find((x) => x.id === profileId));
  const title = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.title ?? "servidor");
  const [snap, setSnap] = useState<ServerSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    setLoading(true);
    const s = await collectServer({ profileId, name: profile?.name ?? title, host: profile?.host ?? "", sessionId });
    if (g !== gen.current) return;
    setSnap(s);
    setLoading(false);
  }, [profileId, profile?.name, profile?.host, title, sessionId]);
  const started = useRef(false);
  useEffect(() => {
    if (active && !disabled && !started.current) {
      started.current = true;
      void load();
    }
  }, [active, disabled, load]);
  const nav = useCallback((_server: string, t: NavTarget) => useInfraNav.getState().open(sessionId, t), [sessionId]);
  return (
    <InfraMapView
      snapshots={snap ? [snap] : null}
      loading={loading}
      onRefresh={() => void load()}
      onNav={nav}
      name={`mapa-${profile?.name ?? title}`}
    />
  );
}
