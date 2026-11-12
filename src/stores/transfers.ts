// Transferencias: trabajos por id + resúmenes por lote calculados de forma incremental.
// DUEÑO: agente Transferencias.
//
// El motor envía cada ~200 ms solo los trabajos que cambiaron. Con miles de trabajos no se
// recalcula todo: cada actualización resta la contribución vieja del trabajo a su lote y
// suma la nueva (O(cambios)), y solo los lotes tocados reciben un objeto nuevo.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  EV_TRANSFER_CONFLICT,
  EV_TRANSFER_CONFLICT_DONE,
  transfers,
  type TransferConflict,
} from "../api/transfers";
import {
  EV_TRANSFER_REMOVED,
  EV_TRANSFER_UPDATE,
  type TransferDirection,
  type TransferJob,
  type TransferStatus,
} from "../api/types";
import { toast } from "./toasts";

export type BatchStatus = "running" | "queued" | "paused" | "done" | "error" | "canceled";

export interface BatchSummary {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  /** "fotos/", "informe.pdf" o "fotos/ y 2 más". */
  label: string;
  total: number;
  done: number;
  /** No se transfirieron por la política de conflictos (ya existían). */
  skipped: number;
  error: number;
  canceled: number;
  running: number;
  queued: number;
  paused: number;
  /** Bytes de los trabajos no cancelados ni omitidos. */
  bytesTotal: number;
  bytesDone: number;
  /** Bytes/s (ventana reciente del lote completo). */
  speed: number;
  /** Segundos restantes estimados (null si no se sabe). */
  eta: number | null;
  status: BatchStatus;
  createdAt: number;
  /** Primer error (para mostrarlo sin abrir el lote). */
  firstError: string | null;
  /** Cambia cada vez que cambia algún trabajo del lote (para memorizar listas). */
  version: number;
}

interface TransfersState {
  jobs: Record<string, TransferJob>;
  /** Lotes en orden de creación (el más viejo primero). */
  batchOrder: string[];
  batches: Record<string, BatchSummary>;
  loaded: boolean;
}

export const useTransfers = create<TransfersState>(() => ({
  jobs: {},
  batchOrder: [],
  batches: {},
  loaded: false,
}));

/** Preguntas de conflicto pendientes ("Ya existe…"), en orden de llegada: se muestran de una en una. */
export const useTransferConflicts = create<{ queue: TransferConflict[] }>(() => ({ queue: [] }));

function addConflicts(list: TransferConflict[]) {
  if (list.length === 0) return;
  const queue = useTransferConflicts.getState().queue;
  const known = new Set(queue.map((q) => q.jobId));
  const fresh = list.filter((q) => !known.has(q.jobId));
  if (fresh.length > 0) useTransferConflicts.setState({ queue: [...queue, ...fresh] });
}

/** Quita preguntas ya respondidas (también las del mismo lote si se aplicó a todos). */
export function dropConflicts(jobIds: string[]) {
  if (jobIds.length === 0) return;
  const gone = new Set(jobIds);
  const queue = useTransferConflicts.getState().queue;
  const next = queue.filter((q) => !gone.has(q.jobId));
  if (next.length !== queue.length) useTransferConflicts.setState({ queue: next });
}

/** Ids de trabajos de un lote, en orden de llegada (no reactivo: usar junto a `version`). */
export function batchJobIds(batchId: string): readonly string[] {
  return aggs.get(batchId)?.jobIds ?? EMPTY;
}

export function isActiveStatus(s: BatchStatus | TransferStatus): boolean {
  return s === "running" || s === "queued";
}

// ───────────────────────── Agregados internos ─────────────────────────

const EMPTY: readonly string[] = [];
const SPEED_WINDOW_MS = 4000;

interface Agg {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  createdAt: number;
  jobIds: string[];
  /** posición de cada id en jobIds no hace falta: el borrado reconstruye la lista */
  counts: Record<TransferStatus, number>;
  bytesTotal: number;
  bytesDone: number;
  /** raíz → nº de trabajos (en orden de aparición). */
  roots: Map<string, number>;
  errors: number;
  firstError: string | null;
  samples: { t: number; b: number }[];
  /** Suma de velocidades de los trabajos en marcha (respaldo al empezar). */
  jobSpeed: number;
  version: number;
  wasActive: boolean;
  notified: boolean;
}

const aggs = new Map<string, Agg>();

/** Primer tramo del nombre relativo ("fotos/" de "fotos/a.png"). Acepta "\\" por si el
 *  nombre se formó a partir de una ruta local de Windows. */
function rootOf(name: string): string {
  const i = name.search(/[\\/]/);
  return i < 0 ? name : name.slice(0, i + 1);
}

function contribution(j: TransferJob) {
  // Cancelados y omitidos no cuentan en los bytes del lote.
  const excluded = j.status === "canceled" || j.status === "skipped";
  return {
    total: excluded ? 0 : j.size,
    done: excluded ? 0 : j.status === "done" ? j.size : Math.min(j.transferred, j.size || j.transferred),
    speed: j.status === "running" ? j.speed : 0,
  };
}

function newAgg(j: TransferJob): Agg {
  return {
    id: j.batchId,
    sessionId: j.sessionId,
    direction: j.direction,
    createdAt: j.createdAt,
    jobIds: [],
    counts: { queued: 0, running: 0, paused: 0, done: 0, skipped: 0, error: 0, canceled: 0 },
    bytesTotal: 0,
    bytesDone: 0,
    roots: new Map(),
    errors: 0,
    firstError: null,
    samples: [],
    jobSpeed: 0,
    version: 0,
    wasActive: false,
    notified: false,
  };
}

function addJob(a: Agg, j: TransferJob, sign: 1 | -1) {
  const c = contribution(j);
  a.counts[j.status] += sign;
  a.bytesTotal += sign * c.total;
  a.bytesDone += sign * c.done;
  a.jobSpeed += sign * c.speed;
  if (j.status === "error") a.errors += sign;
  const r = rootOf(j.name);
  const n = (a.roots.get(r) ?? 0) + sign;
  if (n <= 0) a.roots.delete(r);
  else a.roots.set(r, n);
}

function statusOf(a: Agg): BatchStatus {
  const c = a.counts;
  if (c.running > 0) return "running";
  if (c.queued > 0) return "queued";
  if (c.paused > 0) return "paused";
  if (c.error > 0) return "error";
  if (c.done > 0 || c.skipped > 0) return "done";
  return "canceled";
}

function labelOf(a: Agg): string {
  let first = "";
  for (const k of a.roots.keys()) {
    first = k;
    break;
  }
  const more = a.roots.size - 1;
  return more > 0 ? `${first} y ${more} más` : first || "—";
}

/** Velocidad por ventana deslizante sobre los bytes del lote. */
function sampleSpeed(a: Agg, now: number, active: boolean): number {
  if (!active) {
    a.samples = [];
    return 0;
  }
  const s = a.samples;
  const last = s[s.length - 1];
  if (!last || last.b !== a.bytesDone || now - last.t > 400) s.push({ t: now, b: a.bytesDone });
  while (s.length > 2 && now - s[0].t > SPEED_WINDOW_MS) s.shift();
  const first = s[0];
  const span = now - first.t;
  if (span < 600) return Math.max(0, a.jobSpeed);
  return Math.max(0, ((a.bytesDone - first.b) * 1000) / span);
}

function summarize(a: Agg, now: number): BatchSummary {
  const c = a.counts;
  const status = statusOf(a);
  const total = c.queued + c.running + c.paused + c.done + c.skipped + c.error + c.canceled;
  const speed = sampleSpeed(a, now, status === "running");
  const remaining = Math.max(0, a.bytesTotal - a.bytesDone);
  return {
    id: a.id,
    sessionId: a.sessionId,
    direction: a.direction,
    label: labelOf(a),
    total,
    done: c.done,
    skipped: c.skipped,
    error: c.error,
    canceled: c.canceled,
    running: c.running,
    queued: c.queued,
    paused: c.paused,
    bytesTotal: a.bytesTotal,
    bytesDone: a.bytesDone,
    speed,
    eta: speed > 1 && status === "running" ? remaining / speed : null,
    status,
    createdAt: a.createdAt,
    firstError: a.firstError,
    version: a.version,
  };
}

function refreshFirstError(a: Agg, jobs: Record<string, TransferJob>) {
  if (a.errors <= 0) {
    a.firstError = null;
    return;
  }
  if (a.firstError !== null) return;
  for (const id of a.jobIds) {
    const j = jobs[id];
    if (j?.status === "error") {
      a.firstError = j.error ?? "Error";
      return;
    }
  }
}

// ───────────────────────── Avisos al terminar un lote ─────────────────────────

const pendingToasts = new Map<string, ReturnType<typeof setTimeout>>();

function verb(d: TransferDirection, done: boolean) {
  if (d === "upload") return done ? "Subida completada" : "Subida con errores";
  return done ? "Descarga completada" : "Descarga con errores";
}

function plural(n: number, one: string, many: string) {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** Espera un momento antes de avisar: una bajada recursiva puede seguir añadiendo archivos. */
function scheduleToast(batchId: string) {
  const prev = pendingToasts.get(batchId);
  if (prev) clearTimeout(prev);
  pendingToasts.set(
    batchId,
    setTimeout(() => {
      pendingToasts.delete(batchId);
      const a = aggs.get(batchId);
      if (!a || a.notified) return;
      const b = useTransfers.getState().batches[batchId];
      if (!b || isActiveStatus(b.status) || b.status === "paused") return;
      a.notified = true;
      a.wasActive = false;
      const skipped = b.skipped > 0 ? ` · ${formatCount(b.skipped)} ${b.skipped === 1 ? "omitido" : "omitidos"}` : "";
      if (b.error > 0) {
        toast.error(
          verb(b.direction, false),
          `${b.label}: fallaron ${formatCount(b.error)} de ${plural(b.total - b.canceled, "archivo", "archivos")}${skipped}`,
        );
      } else if (b.done > 0 || b.skipped > 0) {
        toast.success(verb(b.direction, true), `${b.label} · ${plural(b.done, "archivo", "archivos")}${skipped}`);
      }
    }, 1200),
  );
}

// ───────────────────────── Aplicar eventos ─────────────────────────

function applyUpdate(list: TransferJob[], opts: { onlyNew?: boolean; silent?: boolean } = {}) {
  if (list.length === 0) return;
  const st = useTransfers.getState();
  const jobs = { ...st.jobs };
  const touched = new Set<string>();
  let order = st.batchOrder;
  for (const j of list) {
    const old = jobs[j.id];
    if (old && opts.onlyNew) continue;
    let a = aggs.get(j.batchId);
    if (!a) {
      a = newAgg(j);
      aggs.set(j.batchId, a);
      if (order === st.batchOrder) order = [...order];
      order.push(j.batchId);
      if (opts.silent) a.notified = true;
    }
    if (old) addJob(a, old, -1);
    else a.jobIds.push(j.id);
    addJob(a, j, 1);
    if (old?.status === "error" && j.status !== "error" && a.firstError === (old.error ?? "Error")) a.firstError = null;
    jobs[j.id] = j;
    touched.add(j.batchId);
  }
  if (touched.size === 0) return;
  const now = Date.now();
  const batches = { ...st.batches };
  for (const id of touched) {
    const a = aggs.get(id);
    if (!a) continue;
    a.version++;
    refreshFirstError(a, jobs);
    const s = summarize(a, now);
    batches[id] = s;
    const active = isActiveStatus(s.status);
    if (active) {
      a.wasActive = true;
      a.notified = false;
      const p = pendingToasts.get(id);
      if (p) {
        clearTimeout(p);
        pendingToasts.delete(id);
      }
    } else if (a.wasActive && !a.notified && s.status !== "paused") {
      scheduleToast(id);
    }
  }
  useTransfers.setState({ jobs, batches, batchOrder: order });
}

function applyRemoved(ids: string[]) {
  if (ids.length === 0) return;
  const st = useTransfers.getState();
  const jobs = { ...st.jobs };
  const touched = new Set<string>();
  for (const id of ids) {
    const j = jobs[id];
    if (!j) continue;
    const a = aggs.get(j.batchId);
    if (a) {
      addJob(a, j, -1);
      touched.add(j.batchId);
    }
    delete jobs[id];
  }
  if (touched.size === 0) return;
  const removedSet = new Set(ids);
  const batches = { ...st.batches };
  let order = st.batchOrder;
  const now = Date.now();
  for (const bid of touched) {
    const a = aggs.get(bid);
    if (!a) continue;
    a.jobIds = a.jobIds.filter((x) => !removedSet.has(x));
    if (a.jobIds.length === 0) {
      aggs.delete(bid);
      delete batches[bid];
      order = order.filter((x) => x !== bid);
      continue;
    }
    a.version++;
    a.firstError = null;
    refreshFirstError(a, jobs);
    batches[bid] = summarize(a, now);
  }
  useTransfers.setState({ jobs, batches, batchOrder: order });
}

/**
 * Recalcula velocidades/ETA de los lotes en marcha aunque no lleguen eventos
 * (si una transferencia se atasca, la velocidad debe bajar). Lo llama el panel cada segundo.
 */
export function tickTransfers() {
  const st = useTransfers.getState();
  const now = Date.now();
  let batches: Record<string, BatchSummary> | null = null;
  for (const id of st.batchOrder) {
    const b = st.batches[id];
    const a = aggs.get(id);
    if (!a || !b || b.status !== "running") continue;
    const s = summarize(a, now);
    if (Math.abs(s.speed - b.speed) > 1 || s.eta !== b.eta) {
      batches ??= { ...st.batches };
      batches[id] = s;
    }
  }
  if (batches) useTransfers.setState({ batches });
}

let initPromise: Promise<void> | null = null;

/** Llamar una vez al iniciar la app: carga la lista y escucha eventos. */
export function initTransfersStore(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await listen<TransferJob[]>(EV_TRANSFER_UPDATE, (e) => applyUpdate(e.payload));
      await listen<string[]>(EV_TRANSFER_REMOVED, (e) => applyRemoved(e.payload));
      await listen<TransferConflict>(EV_TRANSFER_CONFLICT, (e) => addConflicts([e.payload]));
      await listen<string[]>(EV_TRANSFER_CONFLICT_DONE, (e) => dropConflicts(e.payload));
      const list = await transfers.list();
      // Lo que ya llegó por eventos es más nuevo que la lista: solo se añaden los que faltan.
      applyUpdate(list, { onlyNew: true, silent: true });
      addConflicts(await transfers.conflicts());
    } catch (err) {
      console.error("No se pudieron cargar las transferencias", err);
    } finally {
      useTransfers.setState({ loaded: true });
    }
  })();
  return initPromise;
}

/** 2000 → "2.000" (agrupa también números de 4 cifras). */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
