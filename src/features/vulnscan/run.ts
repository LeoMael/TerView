// Análisis de vulnerabilidades: ejecuta las fases en el servidor (PENDIENTES 10.7) y le pasa las salidas
// al motor, que consulta OSV, junta las fuentes y guarda el historial.
//
// - Fases 1 a 3 sin elevar (las herramientas de la distro funcionan sin root).
// - Fase 4 (imágenes): sin sudo, las del usuario conectado; con sudo, las de root y las de los usuarios
//   elegidos (se entra como cada uno desde el script del motor).
// - Cada fase lleva su `execId`: «Cancelar» detiene el proceso en el servidor y corta OSV.
// - Si una fase falla se anota y se sigue: un informe parcial es mejor que ninguno.
// El estado vive en un store por sesión, así que cambiar de sub-pestaña no pierde un análisis en curso.
import { create } from "zustand";
import { errorMessage, isApiError } from "../../api/core";
import { newExecId, snippets } from "../../api/snippets";
import type { ExecResult } from "../../api/types";
import {
  vulnscan,
  type Engine,
  type ImageRaw,
  type RawOutput,
  type Report,
  type ScanInput,
  type ScanNote,
  type ScanPlan,
  type ScriptRequest,
  type UserCtx,
  type UsersView,
  type VulnScanSettings,
} from "../../api/vulnscan";
import { ElevationError, runScript } from "../admin/run";
import type { Elevation } from "../privileges";

export type PhaseId = "detect" | "inventory" | "distro" | "images" | "osv";
export type PhaseStatus = "pending" | "running" | "ok" | "warn" | "skipped" | "error";

export interface Phase {
  id: PhaseId;
  label: string;
  status: PhaseStatus;
  detail: string | null;
}

export interface ScanRun {
  scanId: string;
  running: boolean;
  phases: Phase[];
  /** Texto de lo que se está haciendo ahora. */
  progress: string;
  /** Error que paró el análisis (no los avisos de fase). */
  error: string | null;
  canceled: boolean;
  startedAt: number;
}

interface VulnState {
  /** Por sesión. */
  runs: Record<string, ScanRun>;
  /** Último informe mostrado, por sesión. */
  reports: Record<string, Report | null>;
  /** Usuarios con almacén de contenedores (leídos con sudo), por sesión. */
  users: Record<string, UsersView | null>;
  setReport: (sessionId: string, r: Report | null) => void;
  /** Olvida el informe en memoria: se vuelve a leer el último del historial. */
  clearReport: (sessionId: string) => void;
}

export const useVulnScan = create<VulnState>((set) => ({
  runs: {},
  reports: {},
  users: {},
  setReport: (sessionId, r) => set((s) => ({ reports: { ...s.reports, [sessionId]: r } })),
  clearReport: (sessionId) =>
    set((s) => {
      const reports = { ...s.reports };
      delete reports[sessionId];
      return { reports };
    }),
}));

/** Lo necesario para cancelar el análisis en curso de cada sesión. */
const live = new Map<string, { scanId: string; execId: string | null; canceled: boolean }>();

const PHASES: { id: PhaseId; label: string }[] = [
  { id: "detect", label: "Detectar el sistema" },
  { id: "inventory", label: "Inventario de paquetes y programas" },
  { id: "distro", label: "Herramienta de seguridad de la distro" },
  { id: "images", label: "Contenedores e imágenes" },
  { id: "osv", label: "Consultar OSV.dev y juntar" },
];

function patchRun(sessionId: string, f: (r: ScanRun) => ScanRun) {
  useVulnScan.setState((s) => {
    const r = s.runs[sessionId];
    return r ? { runs: { ...s.runs, [sessionId]: f(r) } } : s;
  });
}

function setPhase(sessionId: string, id: PhaseId, status: PhaseStatus, detail: string | null = null) {
  patchRun(sessionId, (r) => ({ ...r, phases: r.phases.map((p) => (p.id === id ? { ...p, status, detail } : p)) }));
}

function setProgress(sessionId: string, text: string) {
  patchRun(sessionId, (r) => ({ ...r, progress: text }));
}

class Canceled extends Error {
  constructor() {
    super("Análisis cancelado");
  }
}

function raw(r: ExecResult): RawOutput {
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated };
}

const EMPTY: RawOutput = { stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: false };

export interface ScanOptions {
  sessionId: string;
  profileId: string;
  /** Elevación disponible (null = sin sudo). */
  elevation: Elevation | null;
  settings: VulnScanSettings;
}

/** ¿Hay un análisis en curso en esa sesión? */
export function isScanning(sessionId: string): boolean {
  return useVulnScan.getState().runs[sessionId]?.running ?? false;
}

/** Cancela el análisis de la sesión: detiene el comando del servidor y las peticiones a OSV. */
export async function cancelScan(sessionId: string): Promise<void> {
  const l = live.get(sessionId);
  if (!l) return;
  l.canceled = true;
  setProgress(sessionId, "Cancelando…");
  await Promise.allSettled([l.execId ? snippets.cancelExec(l.execId) : Promise.resolve(false), vulnscan.cancel(l.scanId)]);
}

/** Lista de usuarios con almacén de contenedores (necesita sudo). */
export async function loadStoreUsers(sessionId: string, el: Elevation): Promise<UsersView> {
  const script = await vulnscan.script({ kind: "users" });
  const r = await runScript(sessionId, script, el, "", 30);
  const u = await vulnscan.parseUsers(r.stdout);
  useVulnScan.setState((s) => ({ users: { ...s.users, [sessionId]: u } }));
  return u;
}

/** Una fase en el servidor con su execId (para poder cancelarla). */
async function exec(sessionId: string, req: ScriptRequest, el: Elevation, timeout: number): Promise<ExecResult> {
  const l = live.get(sessionId);
  if (l?.canceled) throw new Canceled();
  const script = await vulnscan.script(req);
  const execId = newExecId();
  if (l) l.execId = execId;
  try {
    return await runScript(sessionId, script, el, "", timeout, execId);
  } catch (e) {
    if (isApiError(e, "Canceled") || live.get(sessionId)?.canceled) throw new Canceled();
    throw e;
  } finally {
    if (l) l.execId = null;
  }
}

interface Ctx {
  engine: Engine;
  /** Usuario al que se entra (null = el conectado, o root). */
  user: UserCtx | null;
  /** Etiqueta del dueño para el informe (null = el conectado). */
  owner: string | null;
  el: Elevation;
}

/** Analiza el servidor. Devuelve el informe (ya guardado en el historial) o null si se canceló o falló. */
export async function startScan(o: ScanOptions): Promise<Report | null> {
  const { sessionId, settings } = o;
  if (isScanning(sessionId)) return null;
  const scanId = newExecId();
  live.set(sessionId, { scanId, execId: null, canceled: false });
  useVulnScan.setState((s) => ({
    runs: {
      ...s.runs,
      [sessionId]: {
        scanId,
        running: true,
        phases: PHASES.map((p) => ({ ...p, status: "pending", detail: null })),
        progress: "Empezando…",
        error: null,
        canceled: false,
        startedAt: Date.now(),
      },
    },
  }));
  const none: Elevation = { kind: "none" };
  const notes: ScanNote[] = [];
  const started = Date.now();
  const input: ScanInput = {
    serverId: o.profileId,
    detect: EMPTY,
    inventory: EMPTY,
    distroTool: null,
    distroOutput: null,
    images: [],
    elevated: false,
    useOsv: settings.useOsv,
    notes,
    serverMs: 0,
  };
  const unlisten = await vulnscan.onProgress((p) => {
    if (p.scanId !== scanId) return;
    setProgress(sessionId, p.text);
    if (p.phase === "osv" && p.total > 0) setPhase(sessionId, "osv", "running", `${p.done} de ${p.total}`);
  });

  try {
    // ── 1. Detectar ──
    setPhase(sessionId, "detect", "running");
    setProgress(sessionId, "Detectando el sistema…");
    const det = await exec(sessionId, { kind: "detect" }, none, 20);
    input.detect = raw(det);
    const plan: ScanPlan = await vulnscan.plan(det.stdout);
    if (!plan.complete) {
      setPhase(sessionId, "detect", "warn", "Salida incompleta");
    } else {
      setPhase(sessionId, "detect", "ok", plan.os || null);
    }

    // ── 2. Inventario ──
    setPhase(sessionId, "inventory", "running");
    setProgress(sessionId, "Leyendo paquetes y programas…");
    try {
      const inv = await exec(sessionId, { kind: "inventory" }, none, 60);
      input.inventory = raw(inv);
      setPhase(sessionId, "inventory", inv.timedOut ? "warn" : "ok", inv.timedOut ? "Tardó demasiado" : null);
    } catch (e) {
      if (e instanceof Canceled) throw e;
      notes.push({ phase: "inventory", level: "error", text: `Inventario: ${errorMessage(e)}` });
      setPhase(sessionId, "inventory", "error", errorMessage(e));
    }

    // ── 3. Herramienta de la distro ──
    if (!plan.distroTool) {
      setPhase(sessionId, "distro", "skipped", "No hay ninguna instalada en el servidor");
    } else if (!settings.useDistroTool) {
      setPhase(sessionId, "distro", "skipped", "Desactivada en las opciones");
    } else {
      setPhase(sessionId, "distro", "running", "La primera vez baja sus datos y puede tardar 1–2 minutos");
      setProgress(sessionId, `Ejecutando ${plan.distroTool} en el servidor…`);
      try {
        const d = await exec(sessionId, { kind: "distro", tool: plan.distroTool, codename: plan.codename || null }, none, 300);
        input.distroTool = plan.distroTool;
        input.distroOutput = raw(d);
        setPhase(sessionId, "distro", d.timedOut ? "warn" : "ok", d.timedOut ? "Tardó demasiado" : null);
      } catch (e) {
        if (e instanceof Canceled) throw e;
        notes.push({ phase: "distro", level: "warn", text: `${plan.distroTool}: ${errorMessage(e)}` });
        setPhase(sessionId, "distro", "warn", errorMessage(e));
      }
    }

    // ── 4. Contenedores e imágenes ──
    input.elevated = plan.isRoot;
    if (!settings.scanImages) {
      setPhase(sessionId, "images", "skipped", "Desactivado en las opciones");
    } else {
      setPhase(sessionId, "images", "running");
      const ctxs = await imageContexts(o, plan, notes);
      input.elevated = plan.isRoot || ctxs.some((c) => c.el.kind !== "none");
      if (!ctxs.length) {
        setPhase(sessionId, "images", "skipped", "No hay Podman ni Docker accesibles");
      } else {
        const res = await scanImages(sessionId, ctxs, plan, settings, input.images, notes);
        setPhase(sessionId, "images", res.failed ? "warn" : "ok", res.text);
      }
    }

    // ── 5 y 6. OSV y juntar (motor) ──
    if (live.get(sessionId)?.canceled) throw new Canceled();
    setPhase(sessionId, "osv", settings.useOsv ? "running" : "skipped", settings.useOsv ? null : "Desactivado: solo herramientas del servidor");
    setProgress(sessionId, "Consultando OSV.dev y juntando resultados…");
    input.serverMs = Date.now() - started;
    let report: Report;
    try {
      report = await vulnscan.analyze(input, scanId);
    } catch (e) {
      if (isApiError(e, "Canceled") || live.get(sessionId)?.canceled) throw new Canceled();
      throw e;
    }
    if (settings.useOsv) {
      const osv = report.sources.find((s) => s.id === "osv");
      setPhase(sessionId, "osv", osv?.used ? "ok" : "warn", osv?.used ? null : (osv?.note ?? null));
    }
    useVulnScan.getState().setReport(sessionId, report);
    patchRun(sessionId, (r) => ({ ...r, running: false, progress: "Terminado" }));
    return report;
  } catch (e) {
    const canceled = e instanceof Canceled;
    patchRun(sessionId, (r) => ({
      ...r,
      running: false,
      canceled,
      error: canceled ? null : errorMessage(e),
      progress: canceled ? "Cancelado" : "Error",
      phases: r.phases.map((p) => (p.status === "running" ? { ...p, status: canceled ? "skipped" : "error" } : p)),
    }));
    return null;
  } finally {
    unlisten();
    live.delete(sessionId);
  }
}

/** Con qué motores y usuarios se miran las imágenes. */
async function imageContexts(o: ScanOptions, plan: ScanPlan, notes: ScanNote[]): Promise<Ctx[]> {
  const none: Elevation = { kind: "none" };
  // Conectado como root: ya se ve todo sin elevar.
  const el = plan.isRoot ? none : o.elevation && o.elevation.kind !== "none" ? o.elevation : null;
  const own = (): Ctx[] => [
    ...(plan.podman ? [{ engine: "podman" as const, user: null, owner: null, el: none }] : []),
    ...(plan.docker ? [{ engine: "docker" as const, user: null, owner: null, el: none }] : []),
  ];
  // Sin sudo: solo lo del usuario conectado (el motor ya añade el aviso al informe).
  if (!el) return own();
  let users: UsersView;
  try {
    setProgress(o.sessionId, "Buscando usuarios con contenedores…");
    users = await loadStoreUsers(o.sessionId, el);
  } catch (e) {
    if (live.get(o.sessionId)?.canceled) throw new Canceled();
    const msg = e instanceof ElevationError ? e.message : errorMessage(e);
    notes.push({ phase: "images", level: "warn", text: `No se pudo usar sudo para ver los contenedores de todos (${msg}); solo los tuyos` });
    return own();
  }
  const chosen = o.settings.usersByServer[o.profileId] ?? [];
  const out: Ctx[] = [];
  if (users.rootPodman) out.push({ engine: "podman", user: null, owner: "root", el });
  if (users.rootDocker) out.push({ engine: "docker", user: null, owner: "root", el });
  for (const u of users.users) {
    if (chosen.length && !chosen.includes(u.name)) continue;
    const ctx: UserCtx = { name: u.name, uid: u.uid, home: u.home };
    if (u.podman) out.push({ engine: "podman", user: ctx, owner: u.name, el });
    if (u.docker) out.push({ engine: "docker", user: ctx, owner: u.name, el });
  }
  return out;
}

async function scanImages(
  sessionId: string,
  ctxs: Ctx[],
  plan: ScanPlan,
  settings: VulnScanSettings,
  images: ImageRaw[],
  notes: ScanNote[],
): Promise<{ text: string; failed: boolean }> {
  // Primero los listados (para saber cuántas imágenes hay en total).
  const todo: { ctx: Ctx; id: string; tag: string }[] = [];
  let failed = false;
  for (const ctx of ctxs) {
    const who = ctx.owner ?? "tu usuario";
    setProgress(sessionId, `Listando imágenes de ${ctx.engine} (${who})…`);
    try {
      const r = await exec(sessionId, { kind: "images", engine: ctx.engine, user: ctx.user }, ctx.el, 60);
      images.push({ engine: ctx.engine, user: ctx.owner, listing: r.stdout, imageId: "", output: null, error: null });
      const v = await vulnscan.parseImages(ctx.engine, r.stdout, settings.imageLimit);
      if (v.error) failed = true;
      for (const i of v.selected) todo.push({ ctx, id: i.id, tag: i.tags[0] ?? i.id });
    } catch (e) {
      if (e instanceof Canceled) throw e;
      failed = true;
      notes.push({ phase: "images", level: "warn", text: `${ctx.engine} de ${who}: ${errorMessage(e)}` });
    }
  }
  const n = todo.length;
  for (let i = 0; i < n; i++) {
    const { ctx, id, tag } = todo[i];
    const text = `Imagen ${i + 1} de ${n} (${tag})`;
    setPhase(sessionId, "images", "running", text);
    setProgress(sessionId, `${text}…`);
    const trivy = settings.useTrivy && !!plan.trivy && ctx.user === null;
    try {
      const r = await exec(sessionId, { kind: "image", engine: ctx.engine, user: ctx.user, imageId: id, trivy }, ctx.el, trivy ? 180 : 120);
      images.push({ engine: ctx.engine, user: ctx.owner, listing: null, imageId: id, output: raw(r), error: r.timedOut ? "tardó demasiado" : null });
      if (r.timedOut) failed = true;
    } catch (e) {
      if (e instanceof Canceled) throw e;
      failed = true;
      images.push({ engine: ctx.engine, user: ctx.owner, listing: null, imageId: id, output: null, error: errorMessage(e) });
    }
  }
  return { text: n === 0 ? "No hay imágenes que analizar" : `${n} ${n === 1 ? "imagen" : "imágenes"}`, failed };
}
