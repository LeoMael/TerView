// Estado de UI compartido entre componentes de distintos dueños. BASE compartida.
import { create } from "zustand";
import type { Project, ServerProfile } from "../api/types";

/** Opciones del editor de servidor cuando se abre desde un proyecto. */
export interface ServerEditorOptions {
  /** Proyecto desde el que se abre: el selector «Proyecto» empieza en él. */
  projectId?: string | null;
  /** Se llama tras guardar, con el servidor y el proyecto elegido ("" = ninguno). */
  onSaved?: (server: ServerProfile, projectId: string) => void;
}

interface UiState {
  /** Editor de servidor: null = cerrado; server.id "" = nuevo. */
  serverEditor: ({ server: ServerProfile | null } & ServerEditorOptions) | null;
  openServerEditor: (server?: ServerProfile | null, opts?: ServerEditorOptions) => void;
  closeServerEditor: () => void;

  /** Editor de proyecto: null = cerrado. */
  projectEditor: { project: Project | null } | null;
  openProjectEditor: (project?: Project | null) => void;
  closeProjectEditor: () => void;

  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useUi = create<UiState>((set) => ({
  serverEditor: null,
  openServerEditor: (server = null, opts = {}) => set({ serverEditor: { server, ...opts } }),
  closeServerEditor: () => set({ serverEditor: null }),
  projectEditor: null,
  openProjectEditor: (project = null) => set({ projectEditor: { project } }),
  closeProjectEditor: () => set({ projectEditor: null }),
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
