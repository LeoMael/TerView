// Cálculos entre dos muestras (funciones puras): CPU %, memoria, red por segundo, procesos.
import type { CpuTicks, DiskUsage, MemInfo, ProcStat, RawSample } from "./sample";

export interface MemMetrics {
  totalKb: number;
  /** total − disponible: lo que de verdad está ocupado. */
  usedKb: number;
  /** Caché de páginas + buffers (se libera si hace falta). */
  cacheKb: number;
  availableKb: number;
  usedPct: number;
  swapTotalKb: number;
  swapUsedKb: number;
  swapPct: number;
}

export interface IfaceRate {
  iface: string;
  rxRate: number | null;
  txRate: number | null;
  rx: number;
  tx: number;
  /** Interfaz virtual (puentes, veth de contenedores…): no suma al total para no contar dos veces. */
  virtual: boolean;
}

export interface NetMetrics {
  /** Bytes/s recibidos (suma de interfaces no virtuales); null en la primera muestra. */
  rxRate: number | null;
  txRate: number | null;
  ifaces: IfaceRate[];
}

export interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
  state: string;
  uid: number | null;
  user: string | null;
  /** % de un núcleo (como top: puede pasar de 100 con varios hilos). null en la primera muestra. */
  cpuPct: number | null;
  memPct: number | null;
  rssKb: number | null;
  /** Segundos desde que arrancó. */
  elapsed: number | null;
}

export interface Metrics {
  at: number;
  uptime: number | null;
  cpuPct: number | null;
  iowaitPct: number | null;
  stealPct: number | null;
  mem: MemMetrics | null;
  load: [number, number, number] | null;
  tasks: { running: number; total: number } | null;
  nproc: number | null;
  net: NetMetrics;
  disks: DiskUsage[];
  /** Unión de los que más CPU y más memoria usan (la tabla ordena y recorta). */
  procs: ProcRow[];
  procCount: number;
}

export const TOP_PROCS = 15;

/** Interfaces que no son tráfico «real» del servidor (lo duplican o son internas). */
const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|cni|podman|flannel|cali|vnet|tap|kube|weave|vxlan|genev|tun|wg|tailscale|zt)/;

export function cpuPercent(prev: CpuTicks | null | undefined, cur: CpuTicks | null): { cpu: number; iowait: number; steal: number } | null {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  if (dt <= 0) return null;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  return {
    cpu: clamp((1 - (cur.idle - prev.idle) / dt) * 100),
    iowait: clamp(((cur.iowait - prev.iowait) / dt) * 100),
    steal: clamp(((cur.steal - prev.steal) / dt) * 100),
  };
}

export function memMetrics(m: MemInfo | null): MemMetrics | null {
  if (!m || m.totalKb <= 0) return null;
  const usedKb = Math.max(0, m.totalKb - m.availableKb);
  const swapUsedKb = Math.max(0, m.swapTotalKb - m.swapFreeKb);
  return {
    totalKb: m.totalKb,
    usedKb,
    cacheKb: m.cachedKb + m.buffersKb,
    availableKb: m.availableKb,
    usedPct: (usedKb / m.totalKb) * 100,
    swapTotalKb: m.swapTotalKb,
    swapUsedKb,
    swapPct: m.swapTotalKb > 0 ? (swapUsedKb / m.swapTotalKb) * 100 : 0,
  };
}

/** Segundos entre dos muestras, con el reloj del servidor si está (más preciso que el local). */
export function elapsedSecs(prev: RawSample, cur: RawSample): number {
  if (prev.uptime !== null && cur.uptime !== null && cur.uptime > prev.uptime) return cur.uptime - prev.uptime;
  return Math.max(0.001, (cur.at - prev.at) / 1000);
}

export function netMetrics(prev: RawSample | null, cur: RawSample): NetMetrics {
  const dt = prev ? elapsedSecs(prev, cur) : 0;
  const before = new Map(prev?.net.map((n) => [n.iface, n]) ?? []);
  let rxSum = 0;
  let txSum = 0;
  let any = false;
  const ifaces: IfaceRate[] = [];
  for (const n of cur.net) {
    if (n.iface === "lo") continue;
    const p = before.get(n.iface);
    // Contador reiniciado (interfaz recreada o desbordado): sin dato esta vez.
    const ok = p && dt > 0 && n.rx >= p.rx && n.tx >= p.tx;
    const rxRate = ok ? (n.rx - p.rx) / dt : null;
    const txRate = ok ? (n.tx - p.tx) / dt : null;
    const virtual = VIRTUAL_IFACE.test(n.iface);
    if (!virtual && rxRate !== null && txRate !== null) {
      rxSum += rxRate;
      txSum += txRate;
      any = true;
    }
    ifaces.push({ iface: n.iface, rxRate, txRate, rx: n.rx, tx: n.tx, virtual });
  }
  ifaces.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.iface.localeCompare(b.iface));
  return { rxRate: any ? rxSum : prev ? 0 : null, txRate: any ? txSum : prev ? 0 : null, ifaces };
}

export interface ProcContext {
  hz: number;
  pageSize: number;
  memTotalKb: number | null;
  uidOf: (p: ProcStat) => number | null;
  userOf: (uid: number) => string | null;
}

export function procRows(prev: RawSample | null, cur: RawSample, ctx: ProcContext): ProcRow[] {
  const dt = prev ? elapsedSecs(prev, cur) : 0;
  const before = new Map(prev?.procs.map((p) => [p.pid, p]) ?? []);
  const rows: ProcRow[] = cur.procs.map((p) => {
    const b = before.get(p.pid);
    // Mismo pid pero otro arranque = pid reutilizado.
    const same = b && b.start === p.start && p.ticks >= b.ticks;
    const cpuPct = same && dt > 0 ? ((p.ticks - b.ticks) / ctx.hz / dt) * 100 : null;
    const rssKb = p.rssPages !== null ? (p.rssPages * ctx.pageSize) / 1024 : null;
    const uid = ctx.uidOf(p);
    return {
      pid: p.pid,
      ppid: p.ppid,
      comm: p.comm,
      state: p.state,
      uid,
      user: uid === null ? null : (ctx.userOf(uid) ?? String(uid)),
      cpuPct,
      memPct: rssKb !== null && ctx.memTotalKb ? (rssKb / ctx.memTotalKb) * 100 : null,
      rssKb,
      elapsed: cur.uptime !== null && Number.isFinite(p.start) ? Math.max(0, cur.uptime - p.start / ctx.hz) : null,
    };
  });
  const byCpu = [...rows].sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || (b.rssKb ?? 0) - (a.rssKb ?? 0));
  const byMem = [...rows].sort((a, b) => (b.rssKb ?? -1) - (a.rssKb ?? -1));
  const pick = new Map<number, ProcRow>();
  for (const r of byCpu.slice(0, TOP_PROCS)) pick.set(r.pid, r);
  for (const r of byMem.slice(0, TOP_PROCS)) pick.set(r.pid, r);
  return [...pick.values()];
}

export interface DeriveContext extends Omit<ProcContext, "memTotalKb"> {
  nproc: number | null;
}

export function deriveMetrics(prev: RawSample | null, cur: RawSample, ctx: DeriveContext): Metrics {
  const cpu = cpuPercent(prev?.cpu, cur.cpu);
  const mem = memMetrics(cur.mem);
  return {
    at: cur.at,
    uptime: cur.uptime,
    cpuPct: cpu?.cpu ?? null,
    iowaitPct: cpu?.iowait ?? null,
    stealPct: cpu?.steal ?? null,
    mem,
    load: cur.load,
    tasks: cur.tasks,
    nproc: ctx.nproc,
    net: netMetrics(prev, cur),
    disks: cur.disks,
    procs: procRows(prev, cur, { ...ctx, memTotalKb: mem?.totalKb ?? null }),
    procCount: cur.procs.length,
  };
}

/** Punto de las gráficas (cada métrica puede faltar). */
export interface HistoryPoint {
  t: number;
  cpu: number | null;
  mem: number | null;
  rx: number | null;
  tx: number | null;
  load: number | null;
}

export function toPoint(m: Metrics): HistoryPoint {
  return {
    t: m.at,
    cpu: m.cpuPct,
    mem: m.mem?.usedPct ?? null,
    rx: m.net.rxRate,
    tx: m.net.txRate,
    load: m.load?.[0] ?? null,
  };
}

/** CPU media de la última ventana (≥ `windowSecs`) a partir de contadores guardados. null si no hay datos suficientes. */
export function sustainedCpu(
  hist: { uptime: number; cpu: CpuTicks }[],
  cur: { uptime: number; cpu: CpuTicks },
  windowSecs = 60,
  maxSecs = 180,
): number | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    const age = cur.uptime - hist[i].uptime;
    if (age >= windowSecs) {
      if (age > maxSecs) return null;
      return cpuPercent(hist[i].cpu, cur.cpu)?.cpu ?? null;
    }
  }
  return null;
}
