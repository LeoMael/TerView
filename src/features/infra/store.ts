// Estado ligero del mapa de infraestructura (lo importan la barra lateral, la sesión y Administración;
// el lienzo se carga aparte).
import { create } from "zustand";
import type { NavTarget, ServerSnapshot } from "./graph";

interface ProjectMapState {
  open: boolean;
  projectId: string | null;
  /** Datos ya leídos (vista previa); si no, se leen al abrir. */
  preset: ServerSnapshot[] | null;
  nonce: number;
}

export const useProjectMap = create<ProjectMapState>(() => ({ open: false, projectId: null, preset: null, nonce: 0 }));

/** Abre el mapa de todo un proyecto (sus servidores conectados en un mismo lienzo). */
export function openProjectMap(projectId: string, preset: ServerSnapshot[] | null = null): void {
  useProjectMap.setState((s) => ({ open: true, projectId, preset, nonce: s.nonce + 1 }));
}

export function closeProjectMap(): void {
  useProjectMap.setState({ open: false, preset: null });
}

// ───────── «Ir a…» desde un nodo del mapa ─────────

export interface InfraNavRequest {
  sessionId: string;
  target: NavTarget;
  seq: number;
}

interface NavState {
  request: InfraNavRequest | null;
  open: (sessionId: string, target: NavTarget) => void;
  done: (seq: number) => void;
}

let seq = 0;

/** La sesión abre la pestaña (Administración o Contenedores) y Administración la sub-pestaña. */
export const useInfraNav = create<NavState>((set) => ({
  request: null,
  open: (sessionId, target) => set({ request: { sessionId, target, seq: ++seq } }),
  done: (s) => set((st) => (st.request?.seq === s ? { request: null } : st)),
}));
