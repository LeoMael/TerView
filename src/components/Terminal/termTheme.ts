// Tema de xterm.js a partir de las variables CSS de la app.
import type { ITheme } from "@xterm/xterm";
import type { ISearchOptions } from "@xterm/addon-search";
import { currentPalette, PALETTE_ANSI } from "../../styles/themes";

type ISearchDecorationOptions = NonNullable<ISearchOptions["decorations"]>;

type Rgb = [number, number, number];

function parseColor(value: string): Rgb | null {
  const v = value.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) {
    const h = m[1];
    return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)) as Rgb;
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (m) {
    const h = m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function withAlpha(color: string, alpha: number, fallback: string): string {
  const rgb = parseColor(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : fallback;
}

const DARK_ANSI: ITheme = {
  black: "#1e293b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#cbd5e1",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

const LIGHT_ANSI: ITheme = {
  black: "#0f172a",
  red: "#dc2626",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#9333ea",
  cyan: "#0e7490",
  white: "#64748b",
  brightBlack: "#475569",
  brightRed: "#ef4444",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#a855f7",
  brightCyan: "#0891b2",
  brightWhite: "#94a3b8",
};

/** Lee las variables actuales y arma el tema. El fondo de terminal puede ser oscuro
 *  aun con la app en tema claro: la paleta se elige según el propio fondo. */
export function buildTermTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;

  const background = get("--bg-terminal", "#020617");
  const bgRgb = parseColor(background) ?? [2, 6, 23];
  const darkBg = luminance(bgRgb) < 0.4;

  const text = get("--text", darkBg ? "#e2e8f0" : "#0f172a");
  const textRgb = parseColor(text);
  const textFits = textRgb ? luminance(textRgb) > 0.4 === darkBg : false;
  const foreground = textFits ? text : darkBg ? "#e2e8f0" : "#0f172a";

  const accent = get("--accent", "#38bdf8");

  return {
    // Cada apariencia puede traer su paleta ANSI; si no, la genérica según el fondo.
    ...(PALETTE_ANSI[currentPalette()] ?? (darkBg ? DARK_ANSI : LIGHT_ANSI)),
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, 0.35, "rgba(56, 189, 248, 0.35)"),
    selectionInactiveBackground: withAlpha(accent, 0.2, "rgba(56, 189, 248, 0.2)"),
    scrollbarSliderBackground: darkBg ? "rgba(148, 163, 184, 0.25)" : "rgba(71, 85, 105, 0.25)",
    scrollbarSliderHoverBackground: darkBg ? "rgba(148, 163, 184, 0.4)" : "rgba(71, 85, 105, 0.4)",
    scrollbarSliderActiveBackground: darkBg ? "rgba(148, 163, 184, 0.55)" : "rgba(71, 85, 105, 0.55)",
  };
}

/** Colores de las coincidencias de búsqueda (xterm exige #RRGGBB). */
export function buildSearchDecorations(): ISearchDecorationOptions {
  const css = getComputedStyle(document.documentElement);
  const bg = parseColor(css.getPropertyValue("--bg-terminal").trim() || "#020617") ?? [2, 6, 23];
  return luminance(bg) < 0.4
    ? {
        matchBackground: "#5c4a0b",
        matchBorder: "#a16207",
        matchOverviewRuler: "#facc15",
        activeMatchBackground: "#b45309",
        activeMatchBorder: "#facc15",
        activeMatchColorOverviewRuler: "#f97316",
      }
    : {
        matchBackground: "#fde68a",
        matchBorder: "#f59e0b",
        matchOverviewRuler: "#ca8a04",
        activeMatchBackground: "#fdba74",
        activeMatchBorder: "#c2410c",
        activeMatchColorOverviewRuler: "#ea580c",
      };
}

/** Llama a `cb` cuando cambia el tema de la app (atributos data-theme / data-palette, clase o estilo de <html>). */
export function onAppThemeChange(cb: () => void): () => void {
  const obs = new MutationObserver(() => cb());
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "class", "style"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => {
    obs.disconnect();
    mq.removeEventListener("change", cb);
  };
}
