// Alertas por servidor: configuración (localStorage, clave por perfil) y evaluación por episodios.
import type { Metrics } from "./derive";

export interface AlertConfig {
  /** Interruptor general: con alertas activas el panel sigue muestreando en segundo plano (cada 30 s). */
  enabled: boolean;
  disk: { on: boolean; pct: number };
  mem: { on: boolean; pct: number };
  /** CPU por encima de `pct` durante 1 minuto seguido (media). */
  cpu: { on: boolean; pct: number };
  /** Carga de 5 min mayor que el número de CPU. */
  load: { on: boolean };
}

export const DEFAULT_ALERTS: AlertConfig = {
  enabled: false,
  disk: { on: true, pct: 85 },
  mem: { on: true, pct: 90 },
  cpu: { on: true, pct: 90 },
  load: { on: true },
};

const KEY = (profileId: string) => `sshorus.monitor.alerts.${profileId}`;

const clampPct = (v: unknown, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : def;
};

export function normalizeAlerts(raw: unknown): AlertConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof AlertConfig, unknown>>;
  const part = (k: "disk" | "mem" | "cpu") => {
    const o = (r[k] && typeof r[k] === "object" ? r[k] : {}) as { on?: unknown; pct?: unknown };
    return { on: typeof o.on === "boolean" ? o.on : DEFAULT_ALERTS[k].on, pct: clampPct(o.pct, DEFAULT_ALERTS[k].pct) };
  };
  const lo = (r.load && typeof r.load === "object" ? r.load : {}) as { on?: unknown };
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_ALERTS.enabled,
    disk: part("disk"),
    mem: part("mem"),
    cpu: part("cpu"),
    load: { on: typeof lo.on === "boolean" ? lo.on : DEFAULT_ALERTS.load.on },
  };
}

const listeners = new Set<(profileId: string) => void>();

export function loadAlerts(profileId: string): AlertConfig {
  try {
    const raw = localStorage.getItem(KEY(profileId));
    return normalizeAlerts(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_ALERTS };
  }
}

export function saveAlerts(profileId: string, cfg: AlertConfig): void {
  try {
    localStorage.setItem(KEY(profileId), JSON.stringify(cfg));
  } catch {
    /* sin almacenamiento: vale para esta sesión */
  }
  listeners.forEach((l) => l(profileId));
}

export function onAlertsChanged(fn: (profileId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface ActiveAlert {
  /** Clave del episodio: "disk:/var", "mem", "cpu", "load". */
  key: string;
  kind: "disk" | "mem" | "cpu" | "load";
  title: string;
  detail: string;
}

/** Margen para dar por terminado un episodio (evita avisos repetidos si el valor baila en el umbral). */
const HYSTERESIS = 3;

const fmt = (v: number) => `${Math.round(v)} %`;

/**
 * Qué alertas están activas ahora. `wasActive` son las claves del episodio anterior:
 * una alerta activa sigue activa hasta bajar `HYSTERESIS` puntos del umbral.
 */
export function evaluateAlerts(
  cfg: AlertConfig,
  m: Metrics,
  sustainedCpu: number | null,
  wasActive: ReadonlySet<string>,
): ActiveAlert[] {
  if (!cfg.enabled) return [];
  const out: ActiveAlert[] = [];
  const over = (key: string, value: number, limit: number) =>
    value > limit || (wasActive.has(key) && value > limit - HYSTERESIS);

  if (cfg.disk.on) {
    for (const d of m.disks) {
      const key = `disk:${d.mount}`;
      if (over(key, d.pct, cfg.disk.pct))
        out.push({ key, kind: "disk", title: `Disco ${d.mount} al ${fmt(d.pct)}`, detail: `Límite: ${cfg.disk.pct} %` });
    }
  }
  if (cfg.mem.on && m.mem && over("mem", m.mem.usedPct, cfg.mem.pct)) {
    out.push({ key: "mem", kind: "mem", title: `Memoria al ${fmt(m.mem.usedPct)}`, detail: `Límite: ${cfg.mem.pct} %` });
  }
  if (cfg.cpu.on) {
    // Sin dato de 1 minuto (p. ej. recién conectado), conserva el estado anterior si lo hay.
    const v = sustainedCpu ?? (wasActive.has("cpu") ? m.cpuPct : null);
    if (v !== null && over("cpu", v, cfg.cpu.pct))
      out.push({ key: "cpu", kind: "cpu", title: `CPU al ${fmt(v)} durante 1 min`, detail: `Límite: ${cfg.cpu.pct} %` });
  }
  if (cfg.load.on && m.load && m.nproc) {
    const l5 = m.load[1];
    const limit = m.nproc;
    if (l5 > limit || (wasActive.has("load") && l5 > limit * 0.9))
      out.push({
        key: "load",
        kind: "load",
        title: `Carga ${l5.toFixed(2)} (más que ${limit} CPU)`,
        detail: "Media de 5 minutos",
      });
  }
  return out;
}
