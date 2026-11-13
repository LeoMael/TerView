// Apariencias de TerView: nombres, modo base, miniatura y colores ANSI de la terminal.
// Los tokens de la interfaz están en theme.css (bloques :root[data-palette="…"]); aquí solo lo que
// necesita TypeScript (selector de Ajustes, terminal y editor).
import type { ITheme } from "@xterm/xterm";

/** Apariencia concreta (sin «Sistema»). */
export type PaletteId = "dark" | "light" | "midnight" | "sand" | "fjord" | "contrast";
/** Lo que se guarda en los ajustes. */
export type ThemeId = PaletteId | "system";
export type ThemeMode = "dark" | "light";

export interface PaletteInfo {
  id: PaletteId;
  label: string;
  hint: string;
  mode: ThemeMode;
  /** Colores de la miniatura del selector. */
  preview: { bg: string; sunken: string; surface: string; border: string; text: string; muted: string; accent: string; terminal: string; termText: string };
}

export const PALETTES: PaletteInfo[] = [
  {
    id: "dark",
    label: "Oscuro",
    hint: "Pizarra con acento celeste. El de siempre.",
    mode: "dark",
    preview: { bg: "#0f172a", sunken: "#0b1220", surface: "#111827", border: "#334155", text: "#e2e8f0", muted: "#94a3b8", accent: "#38bdf8", terminal: "#020617", termText: "#4ade80" },
  },
  {
    id: "light",
    label: "Claro",
    hint: "Fondo blanco y gris azulado; terminal oscura.",
    mode: "light",
    preview: { bg: "#f8fafc", sunken: "#eef2f7", surface: "#ffffff", border: "#cbd5e1", text: "#0f172a", muted: "#475569", accent: "#0284c7", terminal: "#0b1220", termText: "#4ade80" },
  },
  {
    id: "midnight",
    label: "Medianoche",
    hint: "Azul profundo con acento lavanda.",
    mode: "dark",
    preview: { bg: "#0c1229", sunken: "#080d1f", surface: "#111936", border: "#33406f", text: "#e7eafb", muted: "#a9b3db", accent: "#8fa2ff", terminal: "#060a1a", termText: "#5eead4" },
  },
  {
    id: "sand",
    label: "Arena",
    hint: "Papel cálido y verde azulado; también la terminal es clara.",
    mode: "light",
    preview: { bg: "#f6f0e1", sunken: "#ede4cf", surface: "#fffbf2", border: "#cdbd9b", text: "#3a2e1c", muted: "#66553b", accent: "#0f766e", terminal: "#fbf6ea", termText: "#4d7c0f" },
  },
  {
    id: "fjord",
    label: "Fiordo",
    hint: "Gris pizarra suave y tonos escarcha, poco contraste.",
    mode: "dark",
    preview: { bg: "#2a303b", sunken: "#242934", surface: "#303744", border: "#525d70", text: "#e6eaf1", muted: "#b6bfcd", accent: "#7cc4d6", terminal: "#21262f", termText: "#a9cc8c" },
  },
  {
    id: "contrast",
    label: "Alto contraste",
    hint: "Negro puro, texto blanco y acento amarillo.",
    mode: "dark",
    preview: { bg: "#000000", sunken: "#000000", surface: "#0b0b0b", border: "#9e9e9e", text: "#ffffff", muted: "#e2e2e2", accent: "#ffd60a", terminal: "#000000", termText: "#5cff8a" },
  },
];

export function paletteInfo(id: string): PaletteInfo | undefined {
  return PALETTES.find((p) => p.id === id);
}

/** Valor guardado → valor válido (los ajustes viejos solo tenían "dark" | "light" | "system"). */
export function normalizeTheme(v: unknown): ThemeId {
  return v === "system" || (typeof v === "string" && paletteInfo(v)) ? (v as ThemeId) : "dark";
}

type Ansi = Pick<
  ITheme,
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"
>;

/** Colores ANSI propios de cada apariencia (sin entrada: los genéricos según el fondo de la terminal). */
export const PALETTE_ANSI: Partial<Record<PaletteId, Ansi>> = {
  midnight: {
    black: "#1b2550", red: "#fb7185", green: "#5eead4", yellow: "#fcd34d", blue: "#8fa2ff", magenta: "#d8b4fe", cyan: "#67e8f9", white: "#c7cdec",
    brightBlack: "#6b77a8", brightRed: "#fda4af", brightGreen: "#99f6e4", brightYellow: "#fde68a", brightBlue: "#b4c1ff", brightMagenta: "#e9d5ff", brightCyan: "#a5f3fc", brightWhite: "#f5f6fd",
  },
  sand: {
    black: "#3a2e1c", red: "#b91c1c", green: "#4d7c0f", yellow: "#946200", blue: "#1e5fa8", magenta: "#9d2a8e", cyan: "#0f766e", white: "#76644a",
    brightBlack: "#66553b", brightRed: "#c2410c", brightGreen: "#3f6212", brightYellow: "#a16207", brightBlue: "#2563eb", brightMagenta: "#7e22ce", brightCyan: "#0e7490", brightWhite: "#8d7b5c",
  },
  fjord: {
    black: "#3b4252", red: "#e3848c", green: "#a9cc8c", yellow: "#ead07e", blue: "#86a9d4", magenta: "#c4a3cc", cyan: "#7cc4d6", white: "#dde3ec",
    brightBlack: "#6c778c", brightRed: "#eea2a8", brightGreen: "#c0dba8", brightYellow: "#f2dea0", brightBlue: "#a5c1e3", brightMagenta: "#d6bddc", brightCyan: "#a1d6e3", brightWhite: "#f2f5f9",
  },
  contrast: {
    black: "#000000", red: "#ff7070", green: "#5cff8a", yellow: "#ffe14d", blue: "#7cb7ff", magenta: "#ff8cf0", cyan: "#5ff2ff", white: "#e2e2e2",
    brightBlack: "#9e9e9e", brightRed: "#ffa3a3", brightGreen: "#9dffb8", brightYellow: "#fff08f", brightBlue: "#b0d3ff", brightMagenta: "#ffb8f6", brightCyan: "#a3f8ff", brightWhite: "#ffffff",
  },
};

/** Apariencia aplicada ahora (atributo data-palette de <html>). */
export function currentPalette(): PaletteId {
  const p = document.documentElement.dataset.palette;
  return p && paletteInfo(p) ? (p as PaletteId) : "dark";
}

// ───────── Color de acento elegible ─────────

export type AccentId = "" | "blue" | "violet" | "green" | "amber" | "rose" | "teal";

/** Cada acento con una variante para fondos oscuros y otra para claros (contraste AA sobre la superficie). */
export const ACCENTS: { id: Exclude<AccentId, "">; label: string; dark: string; light: string }[] = [
  { id: "blue", label: "Azul", dark: "#60a5fa", light: "#1d4ed8" },
  { id: "violet", label: "Violeta", dark: "#a78bfa", light: "#6d28d9" },
  { id: "green", label: "Verde", dark: "#4ade80", light: "#15803d" },
  { id: "amber", label: "Ámbar", dark: "#fbbf24", light: "#b45309" },
  { id: "rose", label: "Rosa", dark: "#fb7185", light: "#be123c" },
  { id: "teal", label: "Turquesa", dark: "#2dd4bf", light: "#0f766e" },
];

type Rgb = [number, number, number];
const hexRgb = (h: string): Rgb | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  return m ? ([0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb) : null;
};
const rgbHex = (c: number[]) => "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const mixRgb = (a: Rgb, b: Rgb, p: number) => a.map((x, i) => x * p + b[i] * (1 - p));

const ACCENT_PROPS = [
  "--accent", "--accent-strong", "--accent-bg", "--accent-contrast",
  "--mix-accent-10", "--mix-accent-12", "--mix-accent-16", "--mix-accent-22", "--mix-accent-25", "--mix-accent-35", "--mix-accent-45",
  "--mix-accent-7-surface-2", "--mix-accent-75-text-muted",
];

/** Pone (o quita, con "") el acento elegido encima de la apariencia, recalculando sus mezclas. */
export function applyAccent(accent: string, mode: ThemeMode) {
  const root = document.documentElement;
  for (const p of ACCENT_PROPS) root.style.removeProperty(p);
  const a = ACCENTS.find((x) => x.id === accent);
  if (!a) return;
  const css = getComputedStyle(root);
  const color = mode === "dark" ? a.dark : a.light;
  const rgb = hexRgb(color)!;
  const bg = hexRgb(css.getPropertyValue("--bg").trim()) ?? (mode === "dark" ? [15, 23, 42] : [248, 250, 252]);
  const s2 = hexRgb(css.getPropertyValue("--surface-2").trim()) ?? bg;
  const muted = hexRgb(css.getPropertyValue("--text-muted").trim()) ?? bg;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--accent", color);
  set("--accent-strong", rgbHex(mixRgb(rgb, [0, 0, 0], 0.85)));
  set("--accent-bg", rgbHex(mixRgb(rgb, bg, mode === "dark" ? 0.28 : 0.16)));
  set("--accent-contrast", mode === "dark" ? rgbHex(bg) : "#ffffff");
  for (const n of [10, 12, 16, 22, 25, 35, 45]) set(`--mix-accent-${n}`, `rgb(${rgb.join(" ")} / ${n / 100})`);
  set("--mix-accent-7-surface-2", rgbHex(mixRgb(rgb, s2, 0.07)));
  set("--mix-accent-75-text-muted", rgbHex(mixRgb(rgb, muted, 0.75)));
}

/** Tamaño de letra de la interfaz (13 px por defecto): ajusta --fs, --fs-sm y --fs-lg. */
export function applyUiFontSize(px: number) {
  const root = document.documentElement;
  if (!px || px === 13) {
    for (const p of ["--fs", "--fs-sm", "--fs-lg"]) root.style.removeProperty(p);
    return;
  }
  root.style.setProperty("--fs", `${px}px`);
  root.style.setProperty("--fs-sm", `${px - 1}px`);
  root.style.setProperty("--fs-lg", `${px + 2}px`);
}
