// Ajustes de la app. BASE compartida.
import { create } from "zustand";
import { settingsApi } from "../api/profiles";
import type { Settings } from "../api/types";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  terminalFontSize: 14,
  terminalFontFamily: "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', monospace",
  transferConcurrency: 4,
  showHiddenFiles: false,
  confirmDelete: true,
  editorMaxBytes: 5 * 1024 * 1024,
  layout: {},
  keepaliveSecs: 10,
  autoReconnect: true,
  reconnectAttempts: 5,
  editorFontSize: 14,
  editorFontFamily: "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', monospace",
  sshConfigSync: false,
  transferConflict: "overwrite",
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /** Cambia y guarda (con pequeño retardo para no escribir en cada tecla). */
  update: (patch: Partial<Settings>) => void;
  /** Guarda tamaños de paneles de un layout. */
  setLayout: (key: string, sizes: number[]) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const s = await settingsApi.load();
      set({ settings: { ...DEFAULT_SETTINGS, ...s }, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  update: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      settingsApi.save(get().settings).catch(() => {});
    }, 400);
  },
  setLayout: (key, sizes) => get().update({ layout: { ...get().settings.layout, [key]: sizes } }),
}));
