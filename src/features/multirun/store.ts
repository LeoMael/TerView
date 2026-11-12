// Estado global de "Ejecutar en varios servidores" y conexión del motor con la app real.
// Módulo ligero: lo importa la barra lateral (openMultiRun); el panel se carga aparte.
import { create } from "zustand";
import { ssh } from "../../api/ssh";
import { snippets } from "../../api/snippets";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { detectPrivilege, getPrivilege } from "../privileges";
import { connectInBackground } from "./connect";
import { RunEngine, type EngineDeps } from "./engine";
import type { RunSpec, TargetInput, TargetState } from "./types";

export interface MultiRunPreset {
  /** Comando (puede tener variables {{nombre}}). */
  command?: string;
  /** Nombre del comando de la biblioteca (para mostrarlo). */
  label?: string;
  /** Marcado como peligroso en la biblioteca. */
  dangerous?: boolean;
  /** Servidores preseleccionados. */
  profileIds?: string[];
  /** Proyecto preseleccionado entero. */
  projectId?: string;
}

export interface MultiRunDraft {
  selected: string[];
  command: string;
  label: string | null;
  /** La biblioteca lo marca como peligroso (se suma a la detección automática). */
  flaggedDangerous: boolean;
  values: Record<string, string>;
  timeoutSecs: number;
  concurrency: number;
}

export interface ActiveRun {
  id: number;
  spec: RunSpec;
  targets: TargetState[];
  startedAt: number;
}

interface MultiRunState {
  open: boolean;
  view: "setup" | "results";
  draft: MultiRunDraft;
  run: ActiveRun | null;
  /** Cambia en cada apertura con preselección (el panel reinicia su búsqueda/foco). */
  nonce: number;
}

const PREFS_KEY = "terview.multirun.prefs";
export const DEFAULT_TIMEOUT_SECS = 30;
export const DEFAULT_CONCURRENCY = 4;

function readPrefs(): { timeoutSecs: number; concurrency: number } {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const t = Number(o.timeoutSecs);
    const c = Number(o.concurrency);
    return {
      timeoutSecs: Number.isFinite(t) && t >= 1 && t <= 3600 ? t : DEFAULT_TIMEOUT_SECS,
      concurrency: Number.isFinite(c) && c >= 1 && c <= 16 ? c : DEFAULT_CONCURRENCY,
    };
  } catch {
    return { timeoutSecs: DEFAULT_TIMEOUT_SECS, concurrency: DEFAULT_CONCURRENCY };
  }
}

function writePrefs(timeoutSecs: number, concurrency: number) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ timeoutSecs, concurrency }));
  } catch {
    /* sin almacenamiento */
  }
}

function emptyDraft(): MultiRunDraft {
  return { selected: [], command: "", label: null, flaggedDangerous: false, values: {}, ...readPrefs() };
}

export const useMultiRun = create<MultiRunState>(() => ({
  open: false,
  view: "setup",
  draft: emptyDraft(),
  run: null,
  nonce: 0,
}));

let engine: RunEngine | null = null;
let runSeq = 0;

const realDeps: EngineDeps = {
  tabSession: (profileId) =>
    useTabs.getState().tabs.find((t) => t.profileId === profileId && t.status === "connected")?.sessionId ?? null,
  connect: async (profileId) => (await ssh.connect(profileId)).id,
  connectInteractive: async (profileId) => {
    const profile = useProfiles.getState().getServer(profileId);
    if (!profile) throw new Error("El servidor ya no existe");
    return connectInBackground(profile);
  },
  exec: (sessionId, command, timeoutSecs) => snippets.exec(sessionId, command, timeoutSecs),
  disconnect: (sessionId) => ssh.disconnect(sessionId),
  privilege: async (sessionId, reused) => {
    // Solo lectura: en pestañas se usa lo ya detectado; si no, se consulta sin guardar nada.
    const known = reused ? getPrivilege(sessionId) : null;
    if (known && known.level !== "unknown") return known.level;
    return (await detectPrivilege(sessionId)).level;
  },
};

/** Para pruebas: sustituye las llamadas reales (motor simulado). */
let deps: EngineDeps = realDeps;
export function setMultiRunDeps(d: EngineDeps | null) {
  deps = d ?? realDeps;
}

/**
 * Abre "Ejecutar en varios servidores".
 * Sin argumentos conserva lo último que se preparó; con preselección la aplica.
 * Si hay una ejecución en marcha, solo muestra sus resultados.
 */
export function openMultiRun(preset: MultiRunPreset = {}): void {
  const st = useMultiRun.getState();
  if (engine?.busy) {
    useMultiRun.setState({ open: true, view: "results" });
    return;
  }
  const hasPreset = preset.command !== undefined || preset.profileIds !== undefined || preset.projectId !== undefined;
  if (!hasPreset) {
    useMultiRun.setState({ open: true, view: st.run && st.open ? st.view : "setup" });
    return;
  }
  const draft: MultiRunDraft = { ...st.draft };
  if (preset.profileIds || preset.projectId) {
    const ids = new Set(preset.profileIds ?? []);
    if (preset.projectId) {
      const p = useProfiles.getState().projects.find((x) => x.id === preset.projectId);
      for (const id of p?.serverIds ?? []) ids.add(id);
    }
    draft.selected = Array.from(ids);
  }
  if (preset.command !== undefined) {
    draft.command = preset.command;
    draft.label = preset.label ?? null;
    draft.flaggedDangerous = !!preset.dangerous;
    draft.values = {};
  }
  useMultiRun.setState({ open: true, view: "setup", draft, nonce: st.nonce + 1 });
}

/** ¿Hay servidores en cola, conectando o ejecutando? */
export function multiRunBusy(): boolean {
  return !!engine?.busy;
}

/** Cierra el panel: cancela lo que quede y desconecta las sesiones abiertas por la ejecución. */
export function closeMultiRun(): void {
  engine?.dispose();
  engine = null;
  useMultiRun.setState({ open: false, run: null, view: "setup" });
}

export function updateDraft(p: Partial<MultiRunDraft>): void {
  useMultiRun.setState((s) => ({ draft: { ...s.draft, ...p } }));
  if (p.timeoutSecs !== undefined || p.concurrency !== undefined) {
    const d = useMultiRun.getState().draft;
    writePrefs(d.timeoutSecs, d.concurrency);
  }
}

export function showSetup(): void {
  if (engine?.busy) return;
  useMultiRun.setState({ view: "setup" });
}

export function showResults(): void {
  if (useMultiRun.getState().run) useMultiRun.setState({ view: "results" });
}

/** Lanza una ejecución nueva (la anterior, si terminó, se descarta). */
export function startMultiRun(spec: RunSpec, targets: TargetInput[]): void {
  engine?.dispose();
  const id = ++runSeq;
  const e = new RunEngine(spec, targets, deps, (list) => {
    const run = useMultiRun.getState().run;
    if (run?.id === id) useMultiRun.setState({ run: { ...run, targets: list } });
  });
  engine = e;
  useMultiRun.setState({ view: "results", run: { id, spec, targets: e.targets, startedAt: Date.now() } });
  e.start();
}

/** Repite la última ejecución con los mismos servidores. */
export function repeatMultiRun(): void {
  const run = useMultiRun.getState().run;
  if (!run || engine?.busy) return;
  startMultiRun(
    run.spec,
    run.targets.map(({ profileId, name, address, auth }) => ({ profileId, name, address, auth })),
  );
}

export const multiRunActions = {
  cancel: (profileId: string) => engine?.cancel(profileId),
  cancelAll: () => engine?.cancelAll(),
  retry: (profileId: string) => engine?.retry(profileId),
  retryFailed: () => engine?.retryFailed(),
  resolve: (profileId: string) => engine?.resolve(profileId) ?? Promise.resolve(),
  resolveAll: () => engine?.resolveAll() ?? Promise.resolve(),
};
