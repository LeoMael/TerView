// Apariencia efectiva de la app, resolviendo "system" con matchMedia.
// App (y la ventana de editor) llaman a initThemeSync() una vez; el resto lee useAppTheme().
//   <html data-theme>   = modo base "dark" | "light" (reglas propias del modo claro).
//   <html data-palette> = apariencia concreta (tokens de theme.css).
// Acento y tamaño de letra de la interfaz van como estilo en línea de <html>.
import { create } from "zustand";
import { useSettings } from "../../stores/settings";
import { applyAccent, applyUiFontSize, normalizeTheme, paletteInfo, type PaletteId, type ThemeMode } from "../../styles/themes";

export type EffectiveTheme = ThemeMode;

export const useAppTheme = create<{ theme: EffectiveTheme; palette: PaletteId }>(() => ({ theme: "dark", palette: "dark" }));

let started = false;

/** Aplica la apariencia a <html> y la mantiene sincronizada. Devuelve función de limpieza. */
export function initThemeSync(): () => void {
  if (started) return () => {};
  started = true;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const s = useSettings.getState().settings;
    const pref = normalizeTheme(s.theme);
    const palette: PaletteId = pref === "system" ? (mq.matches ? "dark" : "light") : pref;
    const mode = paletteInfo(palette)?.mode ?? "dark";
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.dataset.palette = palette;
    applyAccent(s.accent ?? "", mode);
    applyUiFontSize(s.uiFontSize ?? 13);
    const cur = useAppTheme.getState();
    if (cur.theme !== mode || cur.palette !== palette) useAppTheme.setState({ theme: mode, palette });
  };
  apply();
  const unsub = useSettings.subscribe((s, prev) => {
    const a = s.settings;
    const b = prev.settings;
    if (a.theme !== b.theme || a.accent !== b.accent || a.uiFontSize !== b.uiFontSize) apply();
  });
  mq.addEventListener("change", apply);
  return () => {
    started = false;
    unsub();
    mq.removeEventListener("change", apply);
  };
}
