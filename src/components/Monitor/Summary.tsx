// «Todas las conexiones»: una tarjeta compacta por cada sesión conectada.
import { useEffect } from "react";
import { useTabs, type SessionTab } from "../../stores/tabs";
import {
  HISTORY_MS,
  setSampleDemand,
  SUMMARY_INTERVAL,
  useSessionMonitor,
} from "../../features/monitor";
import { AreaChart, type ChartSeries } from "./AreaChart";
import { fmtLoad, fmtPct, fmtRate } from "./format";

const CPU_SERIES: ChartSeries[] = [{ key: "cpu", label: "CPU", color: "--accent" }];

interface SummaryProps {
  currentSessionId: string;
  /** Se ve y la ventana está visible: solo entonces se muestrean las otras sesiones. */
  live: boolean;
}

export function Summary({ currentSessionId, live }: SummaryProps) {
  const tabs = useTabs((s) => s.tabs);
  const connected = tabs.filter((t) => t.status === "connected");
  if (!connected.length) return <div className="empty-state">No hay conexiones abiertas</div>;
  return (
    <div className="mon-summary" role="list" aria-label="Resumen de las conexiones abiertas">
      {connected.map((t) => (
        <SummaryCard key={t.id} tab={t} current={t.sessionId === currentSessionId} live={live} />
      ))}
    </div>
  );
}

function SummaryCard({ tab, current, live }: { tab: SessionTab; current: boolean; live: boolean }) {
  const mon = useSessionMonitor(tab.sessionId);
  const owner = `summary:${tab.sessionId}`;

  useEffect(() => {
    setSampleDemand(tab.sessionId, tab.profileId, owner, live ? SUMMARY_INTERVAL : null);
  }, [tab.sessionId, tab.profileId, owner, live]);
  useEffect(() => () => setSampleDemand(tab.sessionId, tab.profileId, owner, null), [tab.sessionId, tab.profileId, owner]);

  const m = mon?.metrics ?? null;
  const maxDisk = m?.disks.reduce((a, d) => (d.pct > a.pct ? d : a), m.disks[0]) ?? null;
  const alerts = mon?.alerts.length ?? 0;

  return (
    <div className="mon-scard" role="listitem" aria-label={`Servidor ${tab.title}`}>
      <div className="mon-scard-head">
        <span className="mon-scard-color" style={{ background: tab.color ?? "var(--border-strong)" }} aria-hidden="true" />
        <span className="mon-scard-title" title={tab.title}>
          {tab.title}
        </span>
        {current && <span className="mon-tag">este</span>}
        {alerts > 0 && (
          <span
            className="status-dot mon-dot-alert"
            title={mon?.alerts.map((a) => a.title).join("\n")}
            aria-label={`${alerts} alerta${alerts > 1 ? "s" : ""} activa${alerts > 1 ? "s" : ""}`}
          />
        )}
      </div>
      {mon?.noProc ? (
        <div className="muted mon-scard-msg">Sin /proc (no es Linux)</div>
      ) : !m ? (
        <div className="muted mon-scard-msg">{mon?.error ?? (live ? "Leyendo…" : "Sin datos")}</div>
      ) : (
        <>
          <dl className="mon-scard-stats">
            <div>
              <dt>CPU</dt>
              <dd>{m.cpuPct === null ? "—" : fmtPct(m.cpuPct)}</dd>
            </div>
            <div>
              <dt>Memoria</dt>
              <dd>{m.mem ? fmtPct(m.mem.usedPct) : "—"}</dd>
            </div>
            <div>
              <dt>Disco</dt>
              <dd title={maxDisk ? `El más lleno: ${maxDisk.mount}` : undefined}>{maxDisk ? `${maxDisk.pct} %` : "—"}</dd>
            </div>
            <div>
              <dt>Carga</dt>
              <dd>{m.load ? fmtLoad(m.load[0]) : "—"}</dd>
            </div>
          </dl>
          <AreaChart
            points={mon?.history ?? []}
            series={CPU_SERIES}
            windowMs={HISTORY_MS}
            max={100}
            format={fmtPct}
            height={28}
            compact
            ariaLabel={`CPU de ${tab.title} en los últimos 5 minutos`}
          />
          <div className="mon-scard-net faint">
            ↓ {m.net.rxRate === null ? "—" : fmtRate(m.net.rxRate)} · ↑ {m.net.txRate === null ? "—" : fmtRate(m.net.txRate)}
          </div>
        </>
      )}
    </div>
  );
}
