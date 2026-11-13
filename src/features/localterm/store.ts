// Pestañas de terminal local («Este equipo»). Van en la misma barra que las de servidor y comparten
// la pestaña activa (`useTabs.activeTabId`), pero se guardan aparte: así nada de lo que trabaja con
// conexiones SSH (privilegios, monitor, transferencias…) las confunde con un servidor.
import { create } from "zustand";
import type { AiLaunch } from "../../api/localterm";
import type { TermController, TermStatus } from "../../components/Terminal/termController";
import { useTabs } from "../../stores/tabs";
import { pickNeighbor, titleFor, type LocalKind } from "./logic";

export interface LocalTab {
  /** Empieza por «local-» (nunca choca con un sessionId). */
  id: string;
  kind: LocalKind;
  title: string;
  /** Carpeta de inicio (null = carpeta personal). */
  cwd: string | null;
  /** Qué se lanza al abrir por primera vez (null = la shell). Al terminar, Enter abre una shell. */
  launch: AiLaunch | null;
  /** Líneas informativas que se muestran al abrir (no llegan al programa). */
  intro: string[];
  /** Se escribe en la shell al abrirla (p. ej. el comando de instalación, ya con Enter). */
  initialInput: string | null;
  /** Texto para pegar en el asistente en cuanto esté listo («Enviar a la IA»). */
  pendingPaste: string | null;
  status: TermStatus;
  /** Se abrió con el MCP de TerView. */
  mcp: boolean;
  /** El asistente sigue abierto (no ha salido a la shell): «Enviar a la IA» pega aquí. */
  aiAlive: boolean;
}

interface LocalTabsState {
  tabs: LocalTab[];
}

export const useLocalTabs = create<LocalTabsState>(() => ({ tabs: [] }));

let seq = 0;

export interface OpenLocalOpts {
  kind?: LocalKind;
  cwd?: string | null;
  launch?: AiLaunch | null;
  intro?: string[];
  initialInput?: string | null;
  pendingPaste?: string | null;
}

/** Abre una pestaña local y la muestra. Devuelve su id. */
export function openLocalTab(opts: OpenLocalOpts = {}): string {
  const kind = opts.kind ?? "shell";
  const cwd = opts.cwd ?? null;
  const tab: LocalTab = {
    id: `local-${++seq}-${Date.now().toString(36)}`,
    kind,
    title: titleFor(kind, cwd),
    cwd,
    launch: opts.launch ?? null,
    intro: opts.intro ?? [],
    initialInput: opts.initialInput ?? null,
    pendingPaste: opts.pendingPaste ?? null,
    status: "opening",
    mcp: false,
    aiAlive: false,
  };
  useLocalTabs.setState((s) => ({ tabs: [...s.tabs, tab] }));
  useTabs.getState().setActive(tab.id);
  return tab.id;
}

export function updateLocalTab(id: string, patch: Partial<LocalTab>) {
  useLocalTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function isLocalTabId(id: string | null | undefined): boolean {
  return !!id && useLocalTabs.getState().tabs.some((t) => t.id === id);
}

/** Todas las pestañas en el orden de la barra: primero las de servidor, luego las locales. */
export function allTabIds(): string[] {
  return [...useTabs.getState().tabs.map((t) => t.id), ...useLocalTabs.getState().tabs.map((t) => t.id)];
}

/** Cierra la pestaña: al desmontarse su vista se termina el programa y todo lo que lanzó. */
export function closeLocalTab(id: string) {
  const ids = allTabIds();
  const next = pickNeighbor(ids, id);
  useLocalTabs.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
  controllers.delete(id);
  if (useTabs.getState().activeTabId === id) useTabs.setState({ activeTabId: next });
}

export function moveLocalTab(id: string, toIndex: number) {
  useLocalTabs.setState((s) => {
    const from = s.tabs.findIndex((t) => t.id === id);
    if (from < 0) return s;
    const tabs = [...s.tabs];
    const [t] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, t);
    return { tabs };
  });
}

// ───────── Controladores (para pegar texto desde fuera) ─────────

const controllers = new Map<string, TermController>();

export function setLocalController(id: string, c: TermController | null) {
  if (c) controllers.set(id, c);
  else controllers.delete(id);
}

export function getLocalController(id: string): TermController | null {
  return controllers.get(id) ?? null;
}

// ───────── Pestaña de servidor que se miraba (para el contexto) ─────────

let lastSshTab: string | null = null;

/** Última pestaña de servidor activa (aunque ahora se mire una local). */
export function lastSshTabId(): string | null {
  const tabs = useTabs.getState().tabs;
  return tabs.some((t) => t.id === lastSshTab) ? lastSshTab : null;
}

let initialized = false;

/** Llamar una vez al iniciar la app. */
export function initLocalTabs() {
  if (initialized) return;
  initialized = true;
  useTabs.subscribe((s, prev) => {
    if (s.activeTabId !== prev.activeTabId && s.tabs.some((t) => t.id === s.activeTabId)) {
      lastSshTab = s.activeTabId;
    }
    // Al cerrar la última pestaña de servidor activa, mostrar una local si la hay.
    if (s.activeTabId === null && prev.activeTabId !== null) {
      const local = useLocalTabs.getState().tabs;
      if (local.length > 0) useTabs.setState({ activeTabId: local[local.length - 1].id });
    }
  });
}
