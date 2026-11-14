// Preferencias del panel Monitor (globales, localStorage con try/catch).

export const INTERVALS = [1000, 2000, 5000, 10000] as const;
export const DEFAULT_INTERVAL = 2000;
/** Con alertas activas y el panel oculto se sigue muestreando a este ritmo. */
export const BACKGROUND_INTERVAL = 30000;
/** Ritmo de las tarjetas de «Todas las conexiones». */
export const SUMMARY_INTERVAL = 5000;
export const CONTAINERS_INTERVAL = 10000;
/** Ventana de las gráficas. */
export const HISTORY_MS = 5 * 60 * 1000;

export interface MonitorPrefs {
  interval: number;
  containers: boolean;
  /** "server": este servidor · "all": todas las conexiones abiertas. */
  view: "server" | "all";
  procSort: "cpu" | "mem";
}

const KEY = "sshorus.monitor.prefs";
const DEFAULTS: MonitorPrefs = { interval: DEFAULT_INTERVAL, containers: true, view: "server", procSort: "cpu" };

export function loadPrefs(): MonitorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const p = (raw ? JSON.parse(raw) : {}) as Partial<MonitorPrefs>;
    return {
      interval: INTERVALS.includes(p.interval as (typeof INTERVALS)[number]) ? (p.interval as number) : DEFAULTS.interval,
      containers: typeof p.containers === "boolean" ? p.containers : DEFAULTS.containers,
      view: p.view === "all" ? "all" : "server",
      procSort: p.procSort === "mem" ? "mem" : "cpu",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: MonitorPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* sin almacenamiento */
  }
}
