// Lienzo del mapa de infraestructura: SVG propio (sin dependencias) con disposición por capas, zoom,
// desplazamiento, ajustar a la pantalla, minimapa, filtros, leyenda, panel de detalles y exportar.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  Box,
  ChevronDown,
  Cpu,
  Database,
  Download,
  Earth,
  ExternalLink,
  Globe,
  Map as MapIcon,
  Maximize,
  Minus,
  Network,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Waypoints,
  X,
  type LucideProps,
} from "lucide-react";
import {
  buildGraph,
  filterGraph,
  graphOwners,
  LAYERS,
  type Health,
  type NavTarget,
  type NodeKind,
  type ServerSnapshot,
} from "../../features/infra/graph";
import { layoutGraph } from "../../features/infra/layout";
import { toMermaid } from "../../features/infra/text";
import { exportMap, type ExportFormat } from "./exportMap";
import "./InfraMap.css";

const ICON: Record<NodeKind, ComponentType<LucideProps>> = {
  internet: Earth,
  firewall: ShieldCheck,
  port: Plug,
  proxy: Waypoints,
  site: Globe,
  container: Box,
  service: Settings2,
  process: Cpu,
  db: Database,
  system: Server,
  external: ExternalLink,
};

const KIND_LABEL: Record<NodeKind, string> = {
  internet: "Internet",
  firewall: "Cortafuegos",
  port: "Puerto expuesto",
  proxy: "Proxy web",
  site: "Sitio",
  container: "Contenedor",
  service: "Servicio",
  process: "Proceso",
  db: "Datos",
  system: "Sistema",
  external: "Externo",
};

const HEALTH_LABEL: Record<Health, string> = { ok: "Bien", warn: "Aviso", bad: "Caído / error", off: "Parado" };

interface View {
  x: number;
  y: number;
  k: number;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function InfraMapView({
  snapshots,
  loading,
  onRefresh,
  onNav,
  name,
  extraTools,
}: {
  snapshots: ServerSnapshot[] | null;
  loading: boolean;
  onRefresh: () => void;
  /** «Ir a…» desde el panel de detalles. */
  onNav?: (serverId: string, target: NavTarget) => void;
  /** Nombre para los archivos exportados. */
  name: string;
  extraTools?: ReactNode;
}) {
  const [hideLocal, setHideLocal] = useState(false);
  const [hideSystem, setHideSystem] = useState(true);
  const [owners, setOwners] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [miniOn, setMiniOn] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);

  const full = useMemo(() => (snapshots ? buildGraph(snapshots) : null), [snapshots]);
  const allOwners = useMemo(() => (full ? graphOwners(full) : []), [full]);
  const graph = useMemo(() => (full ? filterGraph(full, { hideLocal, hideSystem, owners }) : null), [full, hideLocal, hideSystem, owners]);
  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);
  const sel = selected ? (graph?.nodes.find((n) => n.id === selected) ?? null) : null;
  const related = useMemo(() => {
    if (!sel || !graph) return null;
    const s = new Set([sel.id]);
    for (const e of graph.edges) {
      if (e.from === sel.id) s.add(e.to);
      if (e.to === sel.id) s.add(e.from);
    }
    return s;
  }, [sel, graph]);

  // ───────── Zoom y desplazamiento ─────────
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 500 });
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const fit = useCallback(() => {
    if (!layout) return;
    const k = Math.min(1.25, Math.max(0.2, Math.min(size.w / layout.width, size.h / layout.height)));
    setView({ k, x: (size.w - layout.width * k) / 2, y: Math.max(0, (size.h - layout.height * k) / 2) });
  }, [layout, size.w, size.h]);
  // Ajustar al cambiar el contenido, y al cambiar el tamaño mientras el usuario no haya movido la vista.
  const fitKey = layout ? `${layout.width}x${layout.height}` : "";
  const lastFit = useRef("");
  const touched = useRef(false);
  useEffect(() => {
    if (!fitKey || size.w < 50) return;
    const key = touched.current ? fitKey : `${fitKey}|${size.w}x${size.h}`;
    if (lastFit.current === key) return;
    lastFit.current = key;
    touched.current = false;
    fit();
  }, [fitKey, fit, size.w, size.h]);

  const zoomAt = (factor: number, cx = size.w / 2, cy = size.h / 2) => {
    touched.current = true;
    setView((v) => {
      const k = Math.min(3, Math.max(0.15, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      else {
        touched.current = true;
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; node: string | null } | null>(null);
  const onDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const t = (e.target as Element).closest("[data-node]");
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, node: t ? t.getAttribute("data-node") : null };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* eventos sintéticos (vista previa) */
    }
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = touched.current = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) setSelected(d.node);
  };

  const doExport = (f: ExportFormat) => {
    setExportOpen(false);
    if (!svgRef.current || !contentRef.current || !layout || !graph) return;
    void exportMap(f, { name, svg: svgRef.current, content: contentRef.current, width: layout.width, height: layout.height, mermaid: () => toMermaid(graph) });
  };

  const toggleOwner = (o: string) => {
    setOwners((cur) => {
      const s = new Set(cur ?? allOwners);
      if (s.has(o)) s.delete(o);
      else s.add(o);
      return s.size === allOwners.length ? null : s;
    });
  };

  const notes = (snapshots ?? []).flatMap((s) => [
    ...(s.error ? [`${s.name}: ${s.error}`] : []),
    ...s.notes.map((n) => (snapshots!.length > 1 ? `${s.name}: ${n}` : n)),
  ]);

  return (
    <div className="im-root">
      <div className="im-toolbar">
        <div className="im-filters" role="group" aria-label="Filtros">
          <label className="im-check">
            <input type="checkbox" checked={hideLocal} onChange={(e) => setHideLocal(e.target.checked)} /> Ocultar locales
          </label>
          <label className="im-check">
            <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} /> Ocultar sistema
          </label>
          {allOwners.length > 1 && (
            <div className="im-owners" role="group" aria-label="Usuarios">
              <button className={`im-chip${owners === null ? " on" : ""}`} onClick={() => setOwners(null)}>
                Todos
              </button>
              {allOwners.map((o) => (
                <button key={o} className={`im-chip${!owners || owners.has(o) ? " on" : ""}`} onClick={() => toggleOwner(o)} aria-pressed={!owners || owners.has(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="im-tools">
          {extraTools}
          <button className="icon-btn" onClick={() => zoomAt(1 / 1.2)} title="Alejar" aria-label="Alejar">
            <Minus size={14} />
          </button>
          <span className="im-zoom">{Math.round(view.k * 100)}%</span>
          <button className="icon-btn" onClick={() => zoomAt(1.2)} title="Acercar" aria-label="Acercar">
            <Plus size={14} />
          </button>
          <button className="icon-btn" onClick={fit} title="Ajustar a la pantalla" aria-label="Ajustar a la pantalla">
            <Maximize size={14} />
          </button>
          <button className={`icon-btn${miniOn ? " active" : ""}`} onClick={() => setMiniOn((m) => !m)} title="Minimapa" aria-label="Minimapa" aria-pressed={miniOn}>
            <MapIcon size={14} />
          </button>
          <div className="im-export">
            <button className="btn btn-sm" onClick={() => setExportOpen((o) => !o)} disabled={!layout} aria-haspopup="menu" aria-expanded={exportOpen}>
              <Download size={13} /> Exportar <ChevronDown size={12} />
            </button>
            {exportOpen && (
              <div className="im-menu" role="menu" onMouseLeave={() => setExportOpen(false)}>
                <button role="menuitem" onClick={() => doExport("png")}>Imagen PNG…</button>
                <button role="menuitem" onClick={() => doExport("svg")}>SVG…</button>
                <button role="menuitem" onClick={() => doExport("mermaid")}>Mermaid…</button>
                <button role="menuitem" onClick={() => doExport("mermaid-copy")}>Copiar Mermaid</button>
              </div>
            )}
          </div>
          <button className="btn btn-sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={13} className={loading ? "adm-spin" : undefined} /> Actualizar
          </button>
        </div>
      </div>
      {notes.length > 0 && (
        <div className="im-notes" role="status">
          {notes.slice(0, 3).map((n, i) => (
            <span key={i}>{n}</span>
          ))}
        </div>
      )}
      <div className="im-body">
        <div
          ref={wrapRef}
          className="im-canvas"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onKeyDown={(e) => {
            if (e.key === "+" || e.key === "=") zoomAt(1.2);
            else if (e.key === "-") zoomAt(1 / 1.2);
            else if (e.key === "0") fit();
            else if (e.key === "Escape") setSelected(null);
          }}
          tabIndex={0}
          aria-label="Mapa de infraestructura"
        >
          {!layout || !graph ? (
            <div className="empty-state im-empty">
              {loading ? <span className="spinner" /> : <Network size={22} />}
              <div>{loading ? "Leyendo el servidor…" : "Sin datos"}</div>
            </div>
          ) : (
            <svg ref={svgRef} className="im-svg" width={size.w} height={size.h}>
              <defs>
                <marker id="im-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" className="im-arrow" />
                </marker>
                <marker id="im-arrow-x" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" className="im-arrow-x" />
                </marker>
              </defs>
              <g ref={contentRef} transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {layout.columns.map((c) => (
                  <text key={c.layer} x={c.x + 4} y={24} className="im-col">
                    {LAYERS[c.layer]}
                  </text>
                ))}
                {layout.servers.map((s) => {
                  const srv = graph.servers.find((x) => x.id === s.id)!;
                  return (
                    <g key={s.id}>
                      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={10} className="im-server" />
                      <circle cx={s.x + 16} cy={s.y + 17} r={5} className={`im-dot im-h-${srv.health}`} />
                      <text x={s.x + 28} y={s.y + 22} className="im-server-name">
                        {srv.name}
                      </text>
                      <text x={s.x + s.w - 12} y={s.y + 22} className="im-server-sub" textAnchor="end">
                        {[srv.os, srv.firewall].filter(Boolean).join(" · ")}
                      </text>
                      {s.bands.map((b) => (
                        <g key={b.owner}>
                          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} className="im-band" />
                          <text x={b.x + 10} y={b.y + 16} className="im-band-name">
                            {b.owner}
                          </text>
                        </g>
                      ))}
                    </g>
                  );
                })}
                {layout.groups.map((g, i) => (
                  <g key={i}>
                    <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={8} className="im-group" />
                    <text x={g.x + g.w - 6} y={g.y + 10} className="im-group-name" textAnchor="end">
                      {g.name}
                    </text>
                  </g>
                ))}
                {layout.edges.map((e) => {
                  const dim = related && !(related.has(e.edge.from) && related.has(e.edge.to));
                  return (
                    <g key={e.edge.id} className={`im-edge im-e-${e.edge.kind}${dim ? " dim" : ""}`}>
                      <path d={e.path} markerEnd={`url(#${e.edge.kind === "cross" ? "im-arrow-x" : "im-arrow"})`} />
                      {e.edge.label && (
                        <text x={e.lx} y={e.ly - 4} textAnchor="end" className="im-edge-label">
                          {e.edge.label}
                        </text>
                      )}
                    </g>
                  );
                })}
                {[...layout.nodes.values()].map((p) => {
                  const n = p.node;
                  const Icon = ICON[n.kind];
                  const dim = related && !related.has(n.id);
                  return (
                    <g
                      key={n.id}
                      data-node={n.id}
                      className={`im-node im-k-${n.kind}${selected === n.id ? " sel" : ""}${dim ? " dim" : ""}`}
                      transform={`translate(${p.x},${p.y})`}
                    >
                      <title>{`${KIND_LABEL[n.kind]}: ${n.label}${n.sub ? `\n${n.sub}` : ""}`}</title>
                      <rect width={p.w} height={p.h} rx={7} className="im-card" />
                      <rect width={4} height={p.h - 12} x={0} y={6} rx={2} className={`im-stripe im-h-${n.health}`} />
                      <Icon x={10} y={p.h / 2 - 9} width={18} height={18} className="im-icon" />
                      <text x={36} y={n.sub ? 19 : 27} className="im-label">
                        {clip(n.label, 21)}
                      </text>
                      {n.sub && (
                        <text x={36} y={34} className="im-sub">
                          {clip(n.sub, 26)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          {layout && miniOn && <MiniMap layout={layout} view={view} size={size} onCenter={(x, y) => setView((v) => ({ ...v, x: size.w / 2 - x * v.k, y: size.h / 2 - y * v.k }))} />}
          <Legend />
        </div>
        {sel && (
          <aside className="im-details" aria-label="Detalles">
            <div className="im-details-head">
              <span className={`im-dot-html im-h-${sel.health}`} />
              <div className="im-details-title">
                <strong>{sel.label}</strong>
                <span className="faint">
                  {KIND_LABEL[sel.kind]} · {HEALTH_LABEL[sel.health]}
                </span>
              </div>
              <button className="icon-btn" onClick={() => setSelected(null)} title="Cerrar" aria-label="Cerrar">
                <X size={14} />
              </button>
            </div>
            <dl className="im-dl">
              {sel.server && (
                <div className="im-dl-row">
                  <dt>Servidor</dt>
                  <dd>{graph?.servers.find((s) => s.id === sel.server)?.name}</dd>
                </div>
              )}
              {sel.details.map(([k, v], i) => (
                <div key={i} className="im-dl-row">
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {sel.nav && sel.server && onNav && (
              <button className="btn btn-sm" onClick={() => onNav(sel.server!, sel.nav!)}>
                {sel.nav.kind === "ports" ? "Ver en Puertos" : sel.nav.kind === "web" ? "Ver en Sitios web" : "Ver en Contenedores"}
              </button>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function Legend() {
  const kinds: NodeKind[] = ["port", "proxy", "site", "container", "service", "db"];
  return (
    <div className="im-legend" aria-label="Leyenda">
      {kinds.map((k) => {
        const Icon = ICON[k];
        return (
          <span key={k} className={`im-k-${k}`}>
            <Icon size={12} className="im-icon" /> {KIND_LABEL[k]}
          </span>
        );
      })}
      <span>
        <i className="im-dot-html im-h-ok" /> bien
      </span>
      <span>
        <i className="im-dot-html im-h-warn" /> aviso
      </span>
      <span>
        <i className="im-dot-html im-h-bad" /> caído
      </span>
      <span>
        <i className="im-line-x" /> entre servidores
      </span>
    </div>
  );
}

function MiniMap({
  layout,
  view,
  size,
  onCenter,
}: {
  layout: ReturnType<typeof layoutGraph>;
  view: View;
  size: { w: number; h: number };
  onCenter: (x: number, y: number) => void;
}) {
  const W = 170;
  const s = W / layout.width;
  const H = Math.min(130, layout.height * s);
  const sc = Math.min(s, H / layout.height);
  const go = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCenter((e.clientX - r.left) / sc, (e.clientY - r.top) / sc);
  };
  return (
    <svg
      className="im-mini"
      width={layout.width * sc}
      height={layout.height * sc}
      onPointerDown={(e) => {
        e.stopPropagation();
        go(e);
      }}
      onPointerUp={(e) => e.stopPropagation()}
      aria-hidden="true"
    >
      {layout.servers.map((x) => (
        <rect key={x.id} x={x.x * sc} y={x.y * sc} width={x.w * sc} height={x.h * sc} rx={2} className="im-mini-server" />
      ))}
      {[...layout.nodes.values()].map((p) => (
        <rect key={p.node.id} x={p.x * sc} y={p.y * sc} width={p.w * sc} height={p.h * sc} className={`im-mini-node im-h-${p.node.health}`} />
      ))}
      <rect x={(-view.x / view.k) * sc} y={(-view.y / view.k) * sc} width={(size.w / view.k) * sc} height={(size.h / view.k) * sc} className="im-mini-view" />
    </svg>
  );
}
