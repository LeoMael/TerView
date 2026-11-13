// Ajustes de la app. BASE compartida.
import { create } from "zustand";
import { settingsApi } from "../api/profiles";
import type { LocalAiSettings, Settings } from "../api/types";
import { DEFAULT_AI_SETTINGS, DEFAULT_VULNSCAN_SETTINGS } from "../api/vulnscan";
import { ACCENTS, normalizeTheme } from "../styles/themes";
import { cleanOverrides } from "../features/shortcuts/keys";
import { isMac } from "../lib/platform";

/** Fuente monoespaciada por defecto: Linux (JetBrains/Fira/Noto), Windows (Cascadia Mono, Consolas), macOS (Menlo). */
export const DEFAULT_MONO_FONT = "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', 'Cascadia Mono', Consolas, Menlo, monospace";
/** Valor por defecto de versiones anteriores (sin fuentes de Windows/macOS): se actualiza al cargar. */
const OLD_DEFAULT_MONO_FONT = "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', monospace";

export const DEFAULT_LOCAL_AI: LocalAiSettings = {
  mode: "both",
  includeServers: true,
  includeHosts: true,
  includeProjects: true,
  includeActive: true,
  includeDate: true,
  lastCwd: null,
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "",
  uiFontSize: 13,
  terminalFontSize: 14,
  terminalFontFamily: DEFAULT_MONO_FONT,
  transferConcurrency: 4,
  showHiddenFiles: false,
  confirmDelete: true,
  editorMaxBytes: 5 * 1024 * 1024,
  layout: {},
  keepaliveSecs: 10,
  autoReconnect: true,
  reconnectAttempts: 5,
  editorFontSize: 14,
  editorFontFamily: DEFAULT_MONO_FONT,
  sshConfigSync: false,
  transferConflict: "overwrite",
  terminalTmux: "auto",
  lockMinutes: 15,
  vaultPromptDismissed: false,
  vulnscan: DEFAULT_VULNSCAN_SETTINGS,
  ai: DEFAULT_AI_SETTINGS,
  localAi: DEFAULT_LOCAL_AI,
  shortcuts: {},
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
      const s: Settings = { ...DEFAULT_SETTINGS, ...(await settingsApi.load()) };
      // El valor por defecto viejo acababa en «monospace» (Courier New en Windows): se completa.
      if (s.terminalFontFamily === OLD_DEFAULT_MONO_FONT) s.terminalFontFamily = DEFAULT_MONO_FONT;
      if (s.editorFontFamily === OLD_DEFAULT_MONO_FONT) s.editorFontFamily = DEFAULT_MONO_FONT;
      // Apariencia desconocida (o de otra versión) → Oscuro; acento y letra fuera de rango → por defecto.
      s.theme = normalizeTheme(s.theme);
      if (s.accent && !ACCENTS.some((a) => a.id === s.accent)) s.accent = "";
      if (!(s.uiFontSize >= 12 && s.uiFontSize <= 16)) s.uiFontSize = 13;
      // Atajos: sin acciones desconocidas ni combinaciones inválidas (ajustes viejos: {} = los de por defecto).
      s.shortcuts = cleanOverrides(s.shortcuts, isMac);
      set({ settings: s, loaded: true });
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
