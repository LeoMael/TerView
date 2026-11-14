// Barra/panel de transferencias en la parte inferior. Controla su propia altura:
// plegada (~34 px, una línea de resumen) o desplegada (~260 px, lista de lotes).
// DUEÑO: agente Transferencias.
import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleMinus,
  Clock,
  Eraser,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { transfers } from "../../api/transfers";
import type { TransferJob, TransferStatus } from "../../api/types";
import { formatBytes, formatDuration, formatSpeed } from "../../lib/format";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { useTabs } from "../../stores/tabs";
import {
  batchJobIds,
  formatCount,
  isActiveStatus,
  tickTransfers,
  useTransfers,
  type BatchStatus,
  type BatchSummary,
} from "../../stores/transfers";
import { ConflictDialog } from "./ConflictDialog";
import "./TransferPanel.css";

const EXPANDED_KEY = "sshorus.transfers.expanded";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveExpanded(v: boolean) {
  try {
    localStorage.setItem(EXPANDED_KEY, v ? "1" : "0");
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}

/** Llama al motor y avisa si falla. */
function act(fn: () => Promise<void>, what: string) {
  fn().catch((e) => toast.error(`No se pudo ${what}`, e));
}

const pauseIds = (ids: string[]) => act(() => transfers.pause(ids), "pausar");
const resumeIds = (ids: string[]) => act(() => transfers.resume(ids), "reanudar");
const retryIds = (ids: string[]) => act(() => transfers.retry(ids), "reintentar");

async function cancelBatches(list: BatchSummary[]) {
  const pending = list.reduce((n, b) => n + b.running + b.queued + b.paused, 0);
  if (pending > 1) {
    const ok = await confirmDialog({
      title: list.length > 1 ? "¿Cancelar las transferencias?" : "¿Cancelar la transferencia?",
      message: `Quedan ${formatCount(pending)} archivos pendientes. Los archivos a medio copiar se borrarán; los ya terminados se conservan.`,
      confirmText: "Cancelar transferencia",
      cancelText: "Seguir",
      danger: true,
    });
    if (!ok) return;
  }
  act(() => transfers.cancel(list.map((b) => b.id)), "cancelar");
}

function pct(b: { bytesDone: number; bytesTotal: number; done: number; skipped: number; total: number; canceled: number }) {
  if (b.bytesTotal > 0) return Math.min(100, (b.bytesDone / b.bytesTotal) * 100);
  const t = b.total - b.canceled;
  return t > 0 ? ((b.done + b.skipped) / t) * 100 : 0;
}

/** Texto de un trabajo omitido por la política de conflictos. */
function skippedText(j: TransferJob) {
  return `Omitido: ${j.error ?? "ya existía"}`;
}

function etaText(eta: number | null) {
  return eta === null ? "" : `~${formatDuration(eta)}`;
}

const STATUS_LABEL: Record<BatchStatus, string> = {
  running: "En curso",
  queued: "En cola",
  paused: "En pausa",
  done: "Completado",
  error: "Con errores",
  canceled: "Cancelado",
};

const JOB_STATUS_LABEL: Record<TransferStatus, string> = {
  running: "En curso",
  queued: "En cola",
  paused: "En pausa",
  done: "Completado",
  skipped: "Omitido",
  error: "Error",
  canceled: "Cancelado",
};

function DirIcon({ dir, size = 14 }: { dir: "upload" | "download"; size?: number }) {
  return dir === "upload" ? (
    <ArrowUp size={size} className="tp-dir tp-dir-up" aria-label="Subida" />
  ) : (
    <ArrowDown size={size} className="tp-dir tp-dir-down" aria-label="Descarga" />
  );
}

function Bar({ value, status }: { value: number; status?: BatchStatus | TransferStatus }) {
  return (
    <div className={`progress tp-bar${status ? ` tp-bar-${status}` : ""}`}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn tp-ibtn${danger ? " tp-danger" : ""}`}
      title={title}
      aria-label={title}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

// ───────────────────────── Panel ─────────────────────────

export function TransferPanel() {
  const [expanded, setExpanded] = useState(loadExpanded);
  const order = useTransfers((s) => s.batchOrder);
  const batches = useTransfers((s) => s.batches);
  const list = useMemo(() => order.map((id) => batches[id]).filter((b): b is BatchSummary => !!b), [order, batches]);
  const anyRunning = list.some((b) => b.status === "running");

  // Velocidad/ETA siguen bajando si una transferencia se atasca.
  useEffect(() => {
    if (!anyRunning) return;
    // Con la ventana minimizada u oculta no hace falta recalcular nada.
    const t = setInterval(() => {
      if (!document.hidden) tickTransfers();
    }, 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const toggle = (v: boolean) => {
    setExpanded(v);
    saveExpanded(v);
  };

  return (
    <section className={`tp-root${expanded ? " tp-expanded" : ""}`} aria-label="Transferencias">
      {expanded ? (
        <ExpandedView list={list} onCollapse={() => toggle(false)} />
      ) : (
        <CollapsedBar list={list} onExpand={() => toggle(true)} />
      )}
      <ConflictDialog />
    </section>
  );
}

// ───────────────────────── Plegado ─────────────────────────

function aggregate(list: BatchSummary[]) {
  let total = 0;
  let finished = 0;
  let bytesTotal = 0;
  let bytesDone = 0;
  let speed = 0;
  let canceled = 0;
  let done = 0;
  let skipped = 0;
  for (const b of list) {
    total += b.total;
    finished += b.done + b.skipped + b.error + b.canceled;
    done += b.done;
    skipped += b.skipped;
    canceled += b.canceled;
    bytesTotal += b.bytesTotal;
    bytesDone += b.bytesDone;
    speed += b.speed;
  }
  const eta = speed > 1 ? Math.max(0, bytesTotal - bytesDone) / speed : null;
  return { total, finished, bytesTotal, bytesDone, speed, eta, done, skipped, canceled };
}

function CollapsedBar({ list, onExpand }: { list: BatchSummary[]; onExpand: () => void }) {
  const active = list.filter((b) => isActiveStatus(b.status));
  const paused = list.filter((b) => b.status === "paused");
  const withErrors = list.filter((b) => b.error > 0).length;

  let body: ReactNode;
  if (active.length > 0 || paused.length > 0) {
    const shown = active.length > 0 ? active : paused;
    const isPaused = active.length === 0;
    const ag = aggregate(shown);
    const one = shown.length === 1 ? shown[0] : null;
    const dir = one ? one.direction : shown.every((b) => b.direction === "upload") ? "upload" : shown.every((b) => b.direction === "download") ? "download" : null;
    const title = one
      ? `${isPaused ? "En pausa:" : one.direction === "upload" ? "Subiendo" : "Descargando"} ${one.label}`
      : `${shown.length} transferencias${isPaused ? " en pausa" : ""}`;
    body = (
      <>
        <span className="tp-c-title">
          {dir ? <DirIcon dir={dir} /> : <Loader2 size={14} className="tp-spin" />}
          <span className="tp-ellipsis">{title}</span>
        </span>
        <span className="tp-c-count mono">
          {formatCount(ag.finished)} / {formatCount(ag.total)}
        </span>
        <Bar value={pct(ag)} status={isPaused ? "paused" : "running"} />
        {!isPaused && <span className="tp-c-speed mono">{formatSpeed(ag.speed)}</span>}
        {!isPaused && <span className="tp-c-eta muted">{etaText(ag.eta)}</span>}
        {withErrors > 0 && (
          <span className="tp-c-err" title="Hay archivos con errores">
            <CircleAlert size={13} /> {withErrors}
          </span>
        )}
        <span className="tp-c-actions">
          {isPaused ? (
            <IconBtn title="Reanudar" onClick={() => resumeIds(shown.map((b) => b.id))}>
              <Play size={14} />
            </IconBtn>
          ) : (
            <IconBtn title="Pausar" onClick={() => pauseIds(shown.map((b) => b.id))}>
              <Pause size={14} />
            </IconBtn>
          )}
          <IconBtn title="Cancelar" danger onClick={() => void cancelBatches(shown)}>
            <X size={14} />
          </IconBtn>
        </span>
      </>
    );
  } else {
    body = (
      <span className="tp-c-idle">
        <ArrowUp size={13} className="tp-idle-ico" />
        <ArrowDown size={13} className="tp-idle-ico" />
        <span>Sin transferencias</span>
        {list.length > 0 && (
          <span className="faint">
            · {formatCount(list.length)} en el historial
            {withErrors > 0 && (
              <>
                {" · "}
                <span className="tp-err-text">{formatCount(withErrors)} con errores</span>
              </>
            )}
          </span>
        )}
      </span>
    );
  }

  return (
    <div
      className="tp-collapsed"
      role="button"
      tabIndex={0}
      title="Ver transferencias"
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onExpand();
        }
      }}
    >
      {body}
      <span className="tp-c-chevron">
        <ChevronUp size={14} />
      </span>
    </div>
  );
}

// ───────────────────────── Desplegado ─────────────────────────

function ExpandedView({ list, onCollapse }: { list: BatchSummary[]; onCollapse: () => void }) {
  const tabs = useTabs((s) => s.tabs);
  const serverNames = useMemo(() => new Map(tabs.map((t) => [t.sessionId, t.title])), [tabs]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Estable: así BatchRow (memo) solo se redibuja si cambia SU lote, no con cada progreso de otro.
  const onToggle = useCallback((id: string) => setOpen((o) => ({ ...o, [id]: !o[id] })), []);

  const active = list.filter((b) => isActiveStatus(b.status));
  const paused = list.filter((b) => b.status === "paused");
  const ag = aggregate(active);
  const newestFirst = useMemo(() => [...list].reverse(), [list]);

  const clear = () => act(() => transfers.clearFinished(), "limpiar la lista");

  return (
    <>
      <header className="tp-head">
        <span className="section-label">Transferencias</span>
        <span className="tp-head-sum muted">
          {active.length > 0
            ? `${formatCount(ag.finished)} / ${formatCount(ag.total)} archivos · ${formatSpeed(ag.speed)}${ag.eta !== null ? ` · ${etaText(ag.eta)}` : ""}`
            : list.length > 0
              ? "Nada en curso"
              : ""}
        </span>
        <span className="tp-head-actions">
          {active.length > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => pauseIds(active.map((b) => b.id))}>
              <Pause size={13} /> Pausar todo
            </button>
          ) : paused.length > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => resumeIds(paused.map((b) => b.id))}>
              <Play size={13} /> Reanudar todo
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            disabled={!list.some((b) => b.done + b.skipped + b.error + b.canceled > 0)}
            onClick={clear}
            title="Quitar de la lista lo completado, omitido, cancelado o con error"
          >
            <Eraser size={13} /> Limpiar terminados
          </button>
          <button type="button" className="icon-btn" title="Plegar" aria-label="Plegar" onClick={onCollapse}>
            <ChevronDown size={16} />
          </button>
        </span>
      </header>
      <div className="tp-body">
        {newestFirst.length === 0 ? (
          <div className="tp-empty">
            <ArrowUp size={16} />
            <ArrowDown size={16} />
            <span>Sin transferencias. Arrastra archivos o carpetas al explorador para subirlos.</span>
          </div>
        ) : (
          newestFirst.map((b) => (
            <BatchRow
              key={b.id}
              b={b}
              server={serverNames.get(b.sessionId) ?? "Conexión cerrada"}
              open={!!open[b.id]}
              onToggle={onToggle}
            />
          ))
        )}
      </div>
    </>
  );
}

function StatusBadge({ s }: { s: BatchStatus }) {
  const icon =
    s === "running" ? (
      <Loader2 size={12} className="tp-spin" />
    ) : s === "done" ? (
      <Check size={12} />
    ) : s === "error" ? (
      <CircleAlert size={12} />
    ) : s === "paused" ? (
      <Pause size={12} />
    ) : s === "queued" ? (
      <Clock size={12} />
    ) : (
      <X size={12} />
    );
  return (
    <span className={`tp-badge tp-badge-${s}`}>
      {icon}
      {STATUS_LABEL[s]}
    </span>
  );
}

const BatchRow = memo(function BatchRow({
  b,
  server,
  open,
  onToggle,
}: {
  b: BatchSummary;
  server: string;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const active = isActiveStatus(b.status);
  const counted = b.total - b.canceled - b.skipped;
  return (
    <div className={`tp-batch${open ? " tp-open" : ""}`}>
      <div
        className="tp-brow"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onToggle(b.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(b.id);
          }
        }}
      >
        <span className="tp-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <DirIcon dir={b.direction} />
        <span className="tp-blabel">
          <span className="tp-ellipsis tp-bname" title={b.label}>
            {b.label}
          </span>
          <span className="tp-ellipsis tp-server faint" title={server}>
            {b.direction === "upload" ? "→" : "←"} {server}
          </span>
        </span>
        <span className="tp-bcount mono" title="Archivos terminados / total">
          {formatCount(b.done)} / {formatCount(counted)}
          {b.skipped > 0 && (
            <span className="tp-skip-text" title="Omitidos: ya existían en el destino">
              {" "}
              · {formatCount(b.skipped)} omit.
            </span>
          )}
          {b.error > 0 && <span className="tp-err-text"> · {formatCount(b.error)} ✕</span>}
        </span>
        <span className="tp-bbytes mono muted">
          {formatBytes(b.bytesDone)} / {formatBytes(b.bytesTotal)}
        </span>
        <span className="tp-bprog">
          <Bar value={pct(b)} status={b.status} />
        </span>
        <span className="tp-bspeed mono">{b.status === "running" ? formatSpeed(b.speed) : ""}</span>
        <span className="tp-beta muted">{b.status === "running" ? etaText(b.eta) : ""}</span>
        <StatusBadge s={b.status} />
        <span className="tp-bactions">
          {active && (
            <IconBtn title="Pausar" onClick={() => pauseIds([b.id])}>
              <Pause size={14} />
            </IconBtn>
          )}
          {b.status === "paused" && (
            <IconBtn title="Reanudar" onClick={() => resumeIds([b.id])}>
              <Play size={14} />
            </IconBtn>
          )}
          {b.error > 0 && (
            <IconBtn title="Reintentar los fallidos" onClick={() => retryIds([b.id])}>
              <RotateCcw size={14} />
            </IconBtn>
          )}
          {(active || b.status === "paused") && (
            <IconBtn title="Cancelar" danger onClick={() => void cancelBatches([b])}>
              <X size={14} />
            </IconBtn>
          )}
        </span>
      </div>
      {!open && b.firstError && (
        <div className="tp-berror tp-ellipsis" title={b.firstError}>
          <CircleAlert size={12} /> {b.firstError}
        </div>
      )}
      {open && <JobList batch={b} />}
    </div>
  );
});

// ───────────────────────── Trabajos de un lote (lista con ventana) ─────────────────────────

const ROW_H = 24;
const MAX_ROWS = 8;
const OVERSCAN = 6;
const ORDER: Record<TransferStatus, number> = { running: 0, error: 1, paused: 2, queued: 3, done: 4, skipped: 5, canceled: 6 };

type Filter = "all" | "pending" | "skipped" | "error";

function JobList({ batch }: { batch: BatchSummary }) {
  const [filter, setFilter] = useState<Filter>(batch.error > 0 && !isActiveStatus(batch.status) ? "error" : "all");
  const [scrollTop, setScrollTop] = useState(0);

  // Se recalcula solo cuando cambia algún trabajo de ESTE lote (version).
  const rows = useMemo(() => {
    const jobs = useTransfers.getState().jobs;
    const out: TransferJob[] = [];
    for (const id of batchJobIds(batch.id)) {
      const j = jobs[id];
      if (!j) continue;
      if (filter === "error" && j.status !== "error") continue;
      if (filter === "skipped" && j.status !== "skipped") continue;
      if (filter === "pending" && (j.status === "done" || j.status === "canceled" || j.status === "skipped")) continue;
      out.push(j);
    }
    out.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    return out;
  }, [batch.id, batch.version, filter]);

  const height = Math.max(1, Math.min(rows.length, MAX_ROWS)) * ROW_H;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const pending = batch.running + batch.queued + batch.paused;

  return (
    <div className="tp-jobs">
      <div className="tp-filters" role="tablist">
        <FilterBtn cur={filter} v="all" set={setFilter}>
          Todos ({formatCount(batch.total)})
        </FilterBtn>
        <FilterBtn cur={filter} v="pending" set={setFilter}>
          Pendientes ({formatCount(pending)})
        </FilterBtn>
        {batch.skipped > 0 && (
          <FilterBtn cur={filter} v="skipped" set={setFilter}>
            Omitidos ({formatCount(batch.skipped)})
          </FilterBtn>
        )}
        <FilterBtn cur={filter} v="error" set={setFilter}>
          Errores ({formatCount(batch.error)})
        </FilterBtn>
      </div>
      {rows.length === 0 ? (
        <div className="tp-jempty faint">Nada que mostrar</div>
      ) : (
        <div className="tp-jscroll" style={{ height }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(first, last).map((j, i) => (
              <JobRow key={j.id} j={j} top={(first + i) * ROW_H} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterBtn({ cur, v, set, children }: { cur: Filter; v: Filter; set: (f: Filter) => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={cur === v} className={`tp-filter${cur === v ? " tp-on" : ""}`} onClick={() => set(v)}>
      {children}
    </button>
  );
}

function JobIcon({ s }: { s: TransferStatus }) {
  switch (s) {
    case "running":
      return <Loader2 size={13} className="tp-spin tp-ji-running" />;
    case "done":
      return <Check size={13} className="tp-ji-done" />;
    case "error":
      return <CircleAlert size={13} className="tp-ji-error" />;
    case "paused":
      return <Pause size={13} className="tp-ji-paused" />;
    case "queued":
      return <Clock size={13} className="tp-ji-queued" />;
    case "skipped":
      return <CircleMinus size={13} className="tp-ji-skipped" />;
    default:
      return <X size={13} className="tp-ji-canceled" />;
  }
}

const JobRow = memo(function JobRow({ j, top }: { j: TransferJob; top: number }) {
  const showProgress = j.status === "running" || j.status === "paused" || (j.status === "error" && j.transferred > 0);
  const p = j.size > 0 ? (j.transferred / j.size) * 100 : 0;
  const path = j.direction === "upload" ? j.remotePath : j.localPath;
  return (
    <div className={`tp-job tp-job-${j.status}`} style={{ top, height: ROW_H }} title={`${JOB_STATUS_LABEL[j.status]} · ${path}`}>
      <JobIcon s={j.status} />
      <span className="tp-jname tp-ellipsis mono">{j.name}</span>
      {j.status === "error" ? (
        <span className="tp-jerr tp-ellipsis" title={j.error ?? ""}>
          {j.error ?? "Error"}
        </span>
      ) : j.status === "skipped" ? (
        <span className="tp-jnote tp-ellipsis" title={skippedText(j)}>
          {skippedText(j)}
        </span>
      ) : (
        <span className="tp-jinfo">
          {showProgress && (
            <span className="tp-jbar">
              <Bar value={p} status={j.status} />
            </span>
          )}
          <span className="mono muted">
            {showProgress ? `${formatBytes(j.transferred)} / ${formatBytes(j.size)}` : formatBytes(j.size)}
          </span>
          {j.status === "running" && j.speed > 0 && <span className="mono">{formatSpeed(j.speed)}</span>}
          {j.status === "queued" && j.error && <span className="tp-jnote tp-ellipsis">{j.error}</span>}
        </span>
      )}
      <span className="tp-jactions">
        {(j.status === "running" || j.status === "queued") && (
          <IconBtn title="Pausar" onClick={() => pauseIds([j.id])}>
            <Pause size={12} />
          </IconBtn>
        )}
        {j.status === "paused" && (
          <IconBtn title="Reanudar" onClick={() => resumeIds([j.id])}>
            <Play size={12} />
          </IconBtn>
        )}
        {j.status === "error" && (
          <IconBtn title="Reintentar" onClick={() => retryIds([j.id])}>
            <RotateCcw size={12} />
          </IconBtn>
        )}
        {(j.status === "running" || j.status === "queued" || j.status === "paused" || j.status === "error") && (
          <IconBtn title="Cancelar" danger onClick={() => act(() => transfers.cancel([j.id]), "cancelar")}>
            <X size={12} />
          </IconBtn>
        )}
      </span>
    </div>
  );
});
