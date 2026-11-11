// Tema efectivo de la app ("dark" | "light"), resolviendo "system" con matchMedia.
// App llama a initThemeSync() una vez; el resto lee useAppTheme().
import { create } from "zustand";
import { useSettings } from "../../stores/settings";

export type EffectiveTheme = "dark" | "light";

export const useAppTheme = create<{ theme: EffectiveTheme }>(() => ({ theme: "dark" }));

let started = false;

/** Aplica el tema a <html data-theme> y lo mantiene sincronizado. Devuelve función de limpieza. */
export function initThemeSync(): () => void {
  if (started) return () => {};
  started = true;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const pref = useSettings.getState().settings.theme;
    const eff: EffectiveTheme = pref === "system" ? (mq.matches ? "dark" : "light") : pref;
    document.documentElement.dataset.theme = eff;
    if (useAppTheme.getState().theme !== eff) useAppTheme.setState({ theme: eff });
  };
  apply();
  const unsub = useSettings.subscribe((s, prev) => {
    if (s.settings.theme !== prev.settings.theme) apply();
  });
  mq.addEventListener("change", apply);
  return () => {
    started = false;
    unsub();
    mq.removeEventListener("change", apply);
  };
}
