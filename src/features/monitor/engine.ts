// Motor de muestreo por sesión. Cada sesión tiene un `Sampler` con «demandas» (quién quiere datos y cada
// cuánto); muestrea al ritmo de la más exigente y nunca lanza dos muestreos a la vez.
// Los resultados van a un store de zustand que leen el panel y el resumen de conexiones.
import { create } from "zustand";
import { snippets } from "../../api/snippets";
import { errorMessage } from "../../api/core";
import { toast } from "../../stores/toasts";
import { useTabs } from "../../stores/tabs";
import {
  buildContainersCommand,
  buildSampleCommand,
  CONTAINERS_TIMEOUT_SECS,
  parseContainers,
  parseSample,
  SAMPLE_TIMEOUT_SECS,
  type ContainersResult,
  type CpuTicks,
  type RawSample,
  type SampleInfo,
} from "./sample";
import { deriveMetrics, sustainedCpu, toPoint, type HistoryPoint, type Metrics } from "./derive";
import { evaluateAlerts, loadAlerts, onAlertsChanged, type ActiveAlert, type AlertConfig } from "./alerts";
import { CONTAINERS_INTERVAL, HISTORY_MS } from "./prefs";

export interface ContainersState {
  result: ContainersResult | null;
  error: string | null;
  loading: boolean;
  at: number | null;
}

export interface SessionMonitor {
  metrics: Metrics | null;
  history: HistoryPoint[];
  /** Último error del muestreo (se conservan los datos anteriores). */
  error: string | null;
  /** Hay un muestreo en curso. */
  loading: boolean;
  /** El servidor no expone /proc (no es Linux). */
  noProc: boolean;
  info: SampleInfo | null;
  alerts: ActiveAlert[];
  containers: ContainersState;
}

const EMPTY_CONTAINERS: ContainersState = { result: null, error: null, loading: false, at: null };

export const emptyMonitor = (): SessionMonitor => ({
  metrics: null,
  history: [],
  error: null,
  loading: false,
  noProc: false,
  info: null,
  alerts: [],
  containers: EMPTY_CONTAINERS,
});

interface MonitorStore {
  bySession: Record<string, SessionMonitor>;
  patch: (sessionId: string, p: Partial<SessionMonitor>) => void;
  drop: (sessionId: string) => void;
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  bySession: {},
  patch: (sessionId, p) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: { ...(s.bySession[sessionId] ?? emptyMonitor()), ...p } } })),
  drop: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),
}));

/** Datos de una sesión (null si nunca se muestreó). */
export function useSessionMonitor(sessionId: string): SessionMonitor | null {
  return useMonitorStore((s) => s.bySession[sessionId] ?? null);
}

/** Cada cuánto se vuelve a pedir lo que casi no cambia (usuarios, nº de CPU, herramientas). */
const FULL_EVERY_MS = 5 * 60 * 1000;
/** Tras un error, no reintentar más rápido que esto. */
const ERROR_BACKOFF_MS = 5000;

class Sampler {
  private demands = new Map<string, number>();
  private containerDemands = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cRunning = false;
  private disposed = false;
  private lastStart = 0;
  private cLastStart = 0;
  private failed = false;
  private count = 0;

  private prev: RawSample | null = null;
  private info: SampleInfo | null = null;
  private lastFullAt = 0;
  private users = new Map<number, string>();
  /** pid → uid (con su arranque, para no confundir pids reutilizados). */
  private uidCache = new Map<number, { uid: number; start: number }>();
  private wantUids: number[] = [];
  private cpuHist: { uptime: number; cpu: CpuTicks }[] = [];
  private activeAlerts = new Set<string>();
  private alertCfg: AlertConfig;

  constructor(
    readonly sessionId: string,
    public profileId: string,
  ) {
    this.alertCfg = loadAlerts(profileId);
  }

  reloadAlerts() {
    this.alertCfg = loadAlerts(this.profileId);
    if (!this.alertCfg.enabled && this.activeAlerts.size) {
      this.activeAlerts.clear();
      useMonitorStore.getState().patch(this.sessionId, { alerts: [] });
    }
  }

  get hasDemand() {
    return this.demands.size > 0 || this.containerDemands.size > 0;
  }

  setDemand(owner: string, intervalMs: number | null) {
    if (intervalMs === null) this.demands.delete(owner);
    else this.demands.set(owner, intervalMs);
    this.schedule();
  }

  setContainersDemand(owner: string, on: boolean) {
    if (on) this.containerDemands.add(owner);
    else this.containerDemands.delete(owner);
    this.scheduleContainers();
  }

  private interval(): number | null {
    if (!this.demands.size) return null;
    return Math.min(...this.demands.values());
  }

  private schedule() {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) return; // al terminar vuelve a llamar a schedule()
    let iv = this.interval();
    if (iv === null) return;
    // Tras la primera muestra no hay % de CPU (hace falta una diferencia): la segunda llega antes.
    if (this.count === 1) iv = Math.min(iv, 1000);
    const wait = Math.max(0, this.lastStart + (this.failed ? Math.max(iv, ERROR_BACKOFF_MS) : iv) - Date.now());
    this.timer = setTimeout(() => void this.tick(), wait);
  }

  private async tick() {
    this.timer = null;
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastStart = Date.now();
    const store = useMonitorStore.getState();
    store.patch(this.sessionId, { loading: true });
    const full = !this.info || Date.now() - this.lastFullAt > FULL_EVERY_MS;
    try {
      const cmd = buildSampleCommand({ full, uidPids: this.wantUids });
      const r = await snippets.exec(this.sessionId, cmd, SAMPLE_TIMEOUT_SECS);
      if (this.disposed) return;
      const raw = parseSample(r.stdout);
      if (raw.noProc) {
        this.failed = true;
        store.patch(this.sessionId, { noProc: true, loading: false, error: null });
        return;
      }
      if (!raw.cpu || !raw.mem) {
        this.failed = true;
        const why = r.timedOut ? "El servidor tardó demasiado en responder" : r.stderr.trim().split("\n")[0] || "Respuesta incompleta";
        store.patch(this.sessionId, { loading: false, error: why });
        return;
      }
      this.failed = false;
      this.absorb(raw, full);
    } catch (e) {
      if (this.disposed) return;
      this.failed = true;
      useMonitorStore.getState().patch(this.sessionId, { loading: false, error: errorMessage(e) });
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private absorb(raw: RawSample, full: boolean) {
    if (full && raw.info) {
      this.info = raw.info;
      this.lastFullAt = Date.now();
      if (raw.users.size) this.users = raw.users;
    }
    for (const [pid, uid] of raw.uids) {
      const p = raw.procs.find((x) => x.pid === pid);
      this.uidCache.set(pid, { uid, start: p?.start ?? NaN });
    }
    const hz = this.info?.hz ?? 100;
    const pageSize = this.info?.pageSize ?? 4096;
    const metrics = deriveMetrics(this.prev, raw, {
      hz,
      pageSize,
      nproc: this.info?.nproc ?? null,
      uidOf: (p) => {
        const c = this.uidCache.get(p.pid);
        return c && (c.start === p.start || Number.isNaN(c.start)) ? c.uid : null;
      },
      userOf: (uid) => this.users.get(uid) ?? null,
    });
    // Limpieza de la caché de uids (procesos que ya no existen) y pids a preguntar la próxima vez.
    const alive = new Set(raw.procs.map((p) => p.pid));
    for (const pid of this.uidCache.keys()) if (!alive.has(pid)) this.uidCache.delete(pid);
    this.wantUids = metrics.procs.filter((p) => p.uid === null).map((p) => p.pid);
    this.prev = raw;
    this.count++;

    // Historia de 5 min.
    const cur = useMonitorStore.getState().bySession[this.sessionId] ?? emptyMonitor();
    const cutoff = raw.at - HISTORY_MS;
    const history = cur.history.filter((p) => p.t >= cutoff);
    history.push(toPoint(metrics));

    // CPU sostenida para la alerta (contadores del servidor, últimos 10 min).
    let sustained: number | null = null;
    if (raw.uptime !== null && raw.cpu) {
      const now = { uptime: raw.uptime, cpu: raw.cpu };
      sustained = sustainedCpu(this.cpuHist, now);
      this.cpuHist = this.cpuHist.filter((h) => raw.uptime! - h.uptime < 600 && h.uptime < raw.uptime!);
      this.cpuHist.push(now);
    }
    const alerts = evaluateAlerts(this.alertCfg, metrics, sustained, this.activeAlerts);
    const tabTitle = useTabs.getState().tabs.find((t) => t.sessionId === this.sessionId)?.title ?? "Servidor";
    for (const a of alerts) {
      if (!this.activeAlerts.has(a.key)) toast.error(`${tabTitle}: ${a.title}`, a.detail);
    }
    this.activeAlerts = new Set(alerts.map((a) => a.key));

    useMonitorStore.getState().patch(this.sessionId, {
      metrics,
      history,
      error: null,
      loading: false,
      noProc: false,
      info: this.info,
      alerts,
    });
  }

  // ───────── Contenedores (cada 10 s, solo si alguien lo pide) ─────────

  private scheduleContainers() {
    if (this.disposed) return;
    if (this.cTimer) clearTimeout(this.cTimer);
    this.cTimer = null;
    if (this.cRunning || !this.containerDemands.size) return;
    if (this.info && !this.info.docker && !this.info.podman) {
      // Sin motor de contenedores: se vuelve a mirar cuando llegue otra muestra completa.
      this.cTimer = setTimeout(() => this.scheduleContainers(), CONTAINERS_INTERVAL);
      return;
    }
    const wait = Math.max(0, this.cLastStart + CONTAINERS_INTERVAL - Date.now());
    this.cTimer = setTimeout(() => void this.tickContainers(), wait);
  }

  private async tickContainers() {
    this.cTimer = null;
    if (this.disposed || this.cRunning) return;
    if (!this.info) {
      // Aún no se sabe si hay docker/podman: esperar a la primera muestra.
      this.cTimer = setTimeout(() => this.scheduleContainers(), 1000);
      return;
    }
    this.cRunning = true;
    this.cLastStart = Date.now();
    const patchC = (p: Partial<ContainersState>) => {
      const cur = useMonitorStore.getState().bySession[this.sessionId]?.containers ?? EMPTY_CONTAINERS;
      useMonitorStore.getState().patch(this.sessionId, { containers: { ...cur, ...p } });
    };
    patchC({ loading: true });
    try {
      const r = await snippets.exec(this.sessionId, buildContainersCommand(), CONTAINERS_TIMEOUT_SECS);
      if (this.disposed) return;
      if (r.timedOut) patchC({ loading: false, error: "Las estadísticas de contenedores tardaron demasiado" });
      else patchC({ loading: false, error: null, result: parseContainers(r.stdout), at: Date.now() });
    } catch (e) {
      if (!this.disposed) patchC({ loading: false, error: errorMessage(e) });
    } finally {
      this.cRunning = false;
      this.scheduleContainers();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.cTimer) clearTimeout(this.cTimer);
    this.demands.clear();
    this.containerDemands.clear();
  }
}

const samplers = new Map<string, Sampler>();
let watching = false;

function watch() {
  if (watching) return;
  watching = true;
  // Pestaña cerrada → fuera su muestreador y sus datos.
  useTabs.subscribe((s) => {
    const ids = new Set(s.tabs.map((t) => t.sessionId));
    for (const [id, sm] of samplers) {
      if (!ids.has(id)) {
        sm.dispose();
        samplers.delete(id);
        useMonitorStore.getState().drop(id);
      }
    }
  });
  onAlertsChanged((profileId) => {
    for (const sm of samplers.values()) if (sm.profileId === profileId) sm.reloadAlerts();
  });
}

function sampler(sessionId: string, profileId: string): Sampler {
  watch();
  let sm = samplers.get(sessionId);
  if (!sm) {
    sm = new Sampler(sessionId, profileId);
    samplers.set(sessionId, sm);
  } else if (sm.profileId !== profileId) {
    sm.profileId = profileId;
    sm.reloadAlerts();
  }
  return sm;
}

/**
 * Declara cada cuánto quiere datos `owner` para una sesión (null = ya no). El muestreo va al ritmo
 * de la demanda más rápida y se para cuando no queda ninguna.
 */
export function setSampleDemand(sessionId: string, profileId: string, owner: string, intervalMs: number | null): void {
  if (intervalMs === null && !samplers.has(sessionId)) return;
  sampler(sessionId, profileId).setDemand(owner, intervalMs);
}

export function setContainersDemand(sessionId: string, profileId: string, owner: string, on: boolean): void {
  if (!on && !samplers.has(sessionId)) return;
  sampler(sessionId, profileId).setContainersDemand(owner, on);
}
