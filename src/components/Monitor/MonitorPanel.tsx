// Pestaña «Monitor»: CPU, memoria, red, carga, discos, procesos y contenedores del servidor, en vivo.
// Solo muestrea mientras se ve (o cada 30 s en segundo plano si hay alertas activas).
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Bell, BellOff } from "lucide-react";
import "./Monitor.css";
import { useTabs } from "../../stores/tabs";
import { formatBytes } from "../../lib/format";
import { usePrivilege, type PrivilegeLevel } from "../../features/privileges";
import {
  BACKGROUND_INTERVAL,
  HISTORY_MS,
  INTERVALS,
  loadAlerts,
  loadPrefs,
  onAlertsChanged,
  savePrefs,
  setContainersDemand,
  setSampleDemand,
  useSessionMonitor,
  type AlertConfig,
  type Metrics,
  type MonitorPrefs,
  type SessionMonitor,
} from "../../features/monitor";
import { AreaChart, type ChartSeries } from "./AreaChart";
import { DiskBars } from "./DiskBars";
import { ProcessTable } from "./ProcessTable";
import { Containers } from "./Containers";
import { AlertsDialog } from "./AlertsDialog";
import { Summary } from "./Summary";
import { fmtLoad, fmtPct, fmtRate, fmtUptime } from "./format";

export interface MonitorPanelProps {
  sessionId: string;
  profileId: string;
  /** La pestaña se ve. */
  active: boolean;
  /** Sin conexión. */
  disabled: boolean;
}

// ───────── Visibilidad de la ventana ─────────
const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const getVisible = () => document.visibilityState !== "hidden";

function useAlertConfig(profileId: string): AlertConfig {
  const [cfg, setCfg] = useState(() => loadAlerts(profileId));
  useEffect(() => {
    setCfg(loadAlerts(profileId));
    return onAlertsChanged((p) => {
      if (p === profileId) setCfg(loadAlerts(profileId));
    });
  }, [profileId]);
  return cfg;
}

const CPU_SERIES: ChartSeries[] = [{ key: "cpu", label: "CPU", color: "--accent" }];
const MEM_SERIES: ChartSeries[] = [{ key: "mem", label: "Memoria", color: "--accent" }];
const NET_SERIES: ChartSeries[] = [
  { key: "rx", label: "Recibido", color: "--accent" },
  { key: "tx", label: "Enviado", color: "--orange" },
];
const LOAD_SERIES: ChartSeries[] = [{ key: "load", label: "Carga", color: "--accent" }];

const clock = (t: number) => {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function MonitorPanel({ sessionId, profileId, active, disabled }: MonitorPanelProps) {
  const visible = useSyncExternalStore(subscribeVisibility, getVisible);
  const [prefs, setPrefsState] = useState<MonitorPrefs>(loadPrefs);
  const alertCfg = useAlertConfig(profileId);
  const mon = useSessionMonitor(sessionId);
  const privilege = usePrivilege(sessionId);
  const title = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.title ?? "este servidor");
  const [alertsOpen, setAlertsOpen] = useState(false);

  const setPrefs = useCallback((p: Partial<MonitorPrefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      savePrefs(next);
      return next;
    });
  }, []);

  const live = active && visible && !disabled;
  const owner = `panel:${sessionId}`;

  // Demanda de muestreo de este panel.
  useEffect(() => {
    let iv: number | null = null;
    if (!disabled) {
      if (live && prefs.view === "server") iv = prefs.interval;
      else if (alertCfg.enabled) iv = BACKGROUND_INTERVAL;
    }
    setSampleDemand(sessionId, profileId, owner, iv);
  }, [sessionId, profileId, owner, live, disabled, prefs.view, prefs.interval, alertCfg.enabled]);

  const hasEngine = !!(mon?.info?.docker || mon?.info?.podman);
  const wantContainers = live && prefs.view === "server" && prefs.containers && hasEngine;
  useEffect(() => {
    setContainersDemand(sessionId, profileId, owner, wantContainers);
  }, [sessionId, profileId, owner, wantContainers]);

  useEffect(
    () => () => {
      setSampleDemand(sessionId, profileId, owner, null);
      setContainersDemand(sessionId, profileId, owner, false);
    },
    [sessionId, profileId, owner],
  );

  const alerts = mon?.alerts ?? [];
  const m = mon?.metrics ?? null;

  return (
    <div className="mon-root">
      <div className="mon-header">
        <div className="mon-seg" role="radiogroup" aria-label="Qué mostrar">
          <button
            role="radio"
            aria-checked={prefs.view === "server"}
            className={prefs.view === "server" ? "active" : ""}
            onClick={() => setPrefs({ view: "server" })}
          >
            Este servidor
          </button>
          <button
            role="radio"
            aria-checked={prefs.view === "all"}
            className={prefs.view === "all" ? "active" : ""}
            onClick={() => setPrefs({ view: "all" })}
          >
            Todas las conexiones
          </button>
        </div>
        <div className="mon-header-spacer" />
        <span className="mon-status faint" aria-live="polite">
          {disabled
            ? "Sin conexión"
            : mon?.error && m
              ? "Sin respuesta"
              : m
                ? `Actualizado ${clock(m.at)}`
                : ""}
          {mon?.loading && <span className="mon-pulse" aria-hidden="true" />}
        </span>
        {prefs.view === "server" && (
          <label className="mon-interval">
            <span className="muted">Cada</span>
            <select
              className="select"
              value={prefs.interval}
              onChange={(e) => setPrefs({ interval: Number(e.target.value) })}
              aria-label="Intervalo de actualización"
            >
              {INTERVALS.map((iv) => (
                <option key={iv} value={iv}>
                  {iv / 1000} s
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="icon-btn mon-bell"
          onClick={() => setAlertsOpen(true)}
          title={
            alerts.length
              ? `Alertas activas:\n${alerts.map((a) => a.title).join("\n")}`
              : alertCfg.enabled
                ? "Alertas activadas"
                : "Alertas desactivadas"
          }
          aria-label={alerts.length ? `Alertas: ${alerts.length} activa${alerts.length > 1 ? "s" : ""}` : "Configurar alertas"}
        >
          {alertCfg.enabled ? <Bell size={15} /> : <BellOff size={15} />}
          {alerts.length > 0 && <span className="mon-bell-dot" aria-hidden="true" />}
        </button>
      </div>

      <div className="mon-body">
        {prefs.view === "all" ? (
          <Summary currentSessionId={sessionId} live={live} />
        ) : (
          <ServerView
            sessionId={sessionId}
            mon={mon}
            prefs={prefs}
            setPrefs={setPrefs}
            disabled={disabled}
            hasEngine={hasEngine}
            diskLimit={alertCfg.disk.pct}
            privilege={privilege?.level ?? null}
          />
        )}
      </div>

      <AlertsDialog
        open={alertsOpen}
        profileId={profileId}
        serverName={title}
        active={alerts}
        onClose={() => setAlertsOpen(false)}
      />
    </div>
  );
}

interface ServerViewProps {
  sessionId: string;
  mon: SessionMonitor | null;
  prefs: MonitorPrefs;
  setPrefs: (p: Partial<MonitorPrefs>) => void;
  disabled: boolean;
  hasEngine: boolean;
  diskLimit: number;
  privilege: PrivilegeLevel | null;
}

function ServerView({ sessionId, mon, prefs, setPrefs, disabled, hasEngine, diskLimit, privilege }: ServerViewProps) {
  const m = mon?.metrics ?? null;
  if (mon?.noProc) {
    return (
      <div className="empty-state">
        Este servidor no tiene /proc: el monitor solo funciona con servidores Linux.
      </div>
    );
  }
  if (!m) {
    if (disabled) return <div className="empty-state">Sin conexión</div>;
    return (
      <div className="empty-state">
        {mon?.error ? (
          <span className="mon-error">{mon.error}</span>
        ) : (
          <>
            <span className="spinner" /> Leyendo datos del servidor…
          </>
        )}
      </div>
    );
  }
  const history = mon?.history ?? [];
  return (
    <>
      {mon?.error && <div className="mon-error mon-banner">No se pudo actualizar: {mon.error}</div>}
      <div className="mon-cards">
        <CpuCard m={m} history={history} />
        <MemCard m={m} history={history} />
        <NetCard m={m} history={history} />
        <LoadCard m={m} history={history} />
      </div>

      <section className="mon-section" aria-labelledby="mon-disks-h">
        <h3 id="mon-disks-h" className="section-label">
          Discos
        </h3>
        <DiskBars disks={m.disks} limit={diskLimit} />
      </section>

      <section className="mon-section" aria-labelledby="mon-procs-h">
        <h3 id="mon-procs-h" className="section-label">
          Procesos
        </h3>
        <ProcessTable
          sessionId={sessionId}
          procs={m.procs}
          procCount={m.procCount}
          sort={prefs.procSort}
          onSort={(procSort) => setPrefs({ procSort })}
          myUid={mon?.info?.uid ?? null}
          myUser={mon?.info?.user ?? null}
          privilege={privilege}
          disabled={disabled}
        />
      </section>

      {hasEngine && (
        <section className="mon-section" aria-labelledby="mon-ct-h">
          <div className="mon-section-head">
            <h3 id="mon-ct-h" className="section-label">
              Contenedores
            </h3>
            <label className="checkbox mon-ct-toggle">
              <input type="checkbox" checked={prefs.containers} onChange={(e) => setPrefs({ containers: e.target.checked })} />
              Mostrar (cada 10 s)
            </label>
          </div>
          {prefs.containers && mon && <Containers state={mon.containers} />}
        </section>
      )}
    </>
  );
}

// ───────── Tarjetas ─────────

interface CardProps {
  m: Metrics;
  history: SessionMonitor["history"];
}

function Card({ label, value, sub, children }: { label: string; value: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="mon-card">
      <div className="mon-card-label">{label}</div>
      <div className="mon-card-value">{value}</div>
      <div className="mon-card-sub muted" title={typeof sub === "string" ? sub : undefined}>
        {sub}
      </div>
      {children}
    </div>
  );
}

function CpuCard({ m, history }: CardProps) {
  const extra = [
    m.nproc ? `${m.nproc} CPU` : null,
    m.iowaitPct !== null && m.iowaitPct >= 0.5 ? `espera de disco ${fmtPct(m.iowaitPct)}` : null,
    m.stealPct !== null && m.stealPct >= 0.5 ? `robado ${fmtPct(m.stealPct)}` : null,
  ].filter(Boolean);
  return (
    <Card label="CPU" value={m.cpuPct === null ? "—" : fmtPct(m.cpuPct)} sub={extra.join(" · ") || " "}>
      <AreaChart
        points={history}
        series={CPU_SERIES}
        windowMs={HISTORY_MS}
        max={100}
        format={fmtPct}
        ariaLabel={`Uso de CPU en los últimos 5 minutos. Ahora: ${m.cpuPct === null ? "sin dato" : fmtPct(m.cpuPct)}`}
      />
    </Card>
  );
}

function MemCard({ m, history }: CardProps) {
  const mem = m.mem;
  const kb = (v: number) => formatBytes(v * 1024);
  const sub = mem
    ? `${kb(mem.usedKb)} de ${kb(mem.totalKb)} · caché ${kb(mem.cacheKb)}${mem.swapTotalKb > 0 ? ` · swap ${fmtPct(mem.swapPct)}` : ""}`
    : " ";
  return (
    <Card label="Memoria" value={mem ? fmtPct(mem.usedPct) : "—"} sub={sub}>
      <AreaChart
        points={history}
        series={MEM_SERIES}
        windowMs={HISTORY_MS}
        max={100}
        format={fmtPct}
        ariaLabel={`Memoria usada en los últimos 5 minutos. Ahora: ${mem ? fmtPct(mem.usedPct) : "sin dato"}`}
      />
    </Card>
  );
}

function NetCard({ m, history }: CardProps) {
  const rx = m.net.rxRate;
  const tx = m.net.txRate;
  const ifaces = m.net.ifaces.filter((i) => !i.virtual);
  const busiest = [...ifaces].sort((a, b) => (b.rxRate ?? 0) + (b.txRate ?? 0) - ((a.rxRate ?? 0) + (a.txRate ?? 0)));
  const sub = busiest.length ? busiest.slice(0, 3).map((i) => i.iface).join(", ") : "Sin interfaces";
  return (
    <div className="mon-card">
      <div className="mon-card-label">Red</div>
      <div className="mon-card-value mon-net-value">
        <span>
          <span className="mon-key" style={{ background: "var(--accent)" }} aria-hidden="true" />↓ {rx === null ? "—" : fmtRate(rx)}
        </span>
        <span>
          <span className="mon-key" style={{ background: "var(--orange)" }} aria-hidden="true" />↑ {tx === null ? "—" : fmtRate(tx)}
        </span>
      </div>
      <div className="mon-card-sub muted" title={m.net.ifaces.map((i) => i.iface).join(", ")}>
        <span className="mon-legend">
          <span className="mon-key" style={{ background: "var(--accent)" }} aria-hidden="true" />
          Recibido
          <span className="mon-key" style={{ background: "var(--orange)" }} aria-hidden="true" />
          Enviado
        </span>
        {" · "}
        {sub}
      </div>
      <AreaChart
        points={history}
        series={NET_SERIES}
        windowMs={HISTORY_MS}
        format={fmtRate}
        ariaLabel={`Red en los últimos 5 minutos. Ahora: recibido ${rx === null ? "sin dato" : fmtRate(rx)}, enviado ${tx === null ? "sin dato" : fmtRate(tx)}`}
      />
    </div>
  );
}

function LoadCard({ m, history }: CardProps) {
  const l = m.load;
  const sub = l
    ? `5 min ${fmtLoad(l[1])} · 15 min ${fmtLoad(l[2])}${m.uptime !== null ? ` · encendido ${fmtUptime(m.uptime)}` : ""}`
    : " ";
  return (
    <Card label="Carga (1 min)" value={l ? fmtLoad(l[0]) : "—"} sub={sub}>
      <AreaChart
        points={history}
        series={LOAD_SERIES}
        windowMs={HISTORY_MS}
        reference={m.nproc ? { value: m.nproc, label: `${m.nproc} CPU` } : undefined}
        format={fmtLoad}
        ariaLabel={`Carga del sistema en los últimos 5 minutos. Ahora: ${l ? fmtLoad(l[0]) : "sin dato"}${m.nproc ? ` con ${m.nproc} CPU` : ""}`}
      />
    </Card>
  );
}
