// Atajos de teclado en uso: leen los ajustes en el momento (los cambios valen al instante).
// Los manejadores de teclado preguntan aquí en vez de comparar teclas fijas.
import { isMac } from "../../lib/platform";
import { useSettings } from "../../stores/settings";
import {
  actionById,
  comboMatches,
  formatCombo,
  resolveCombo,
  terminalOwns,
  withBinding,
  type ShortcutOverrides,
} from "./keys";

let capturing = false;
/** Mientras se captura un atajo nuevo en Ajustes, ninguna acción se dispara. */
export function setShortcutCapture(on: boolean) {
  capturing = on;
}

function overrides(): ShortcutOverrides | undefined {
  return useSettings.getState().settings.shortcuts;
}

/** Atajo actual de una acción (texto canónico, "" = sin atajo). */
export function currentCombo(id: string): string {
  return resolveCombo(id, overrides(), isMac);
}

function inTerminal(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.(".xterm");
}

/** ¿El evento es el atajo de esta acción? Los atajos globales que son de la shell
 *  (Ctrl+letra, Alt+letra) no se toman con el foco en la terminal. */
export function matchesShortcut(id: string, e: KeyboardEvent): boolean {
  if (capturing) return false;
  const combo = currentCombo(id);
  if (!comboMatches(combo, e)) return false;
  if (actionById(id)?.scope === "global" && terminalOwns(combo) && inTerminal(e)) return false;
  return true;
}

/** Texto del atajo actual ("Ctrl+B", "⌘B"; "" si no tiene). */
export function shortcutText(id: string): string {
  return formatCombo(currentCombo(id), isMac);
}

/** Igual que `shortcutText`, pero se actualiza al cambiar los ajustes. */
export function useShortcutText(id: string): string {
  const combo = useSettings((s) => resolveCombo(id, s.settings.shortcuts, isMac));
  return formatCombo(combo, isMac);
}

/** " (Ctrl+B)" para añadir a un título; "" si la acción no tiene atajo. */
export function withShortcut(text: string, shortcut: string): string {
  return shortcut ? `${text} (${shortcut})` : text;
}

/** Asigna un atajo (y guarda solo lo distinto de los valores por defecto). */
export function setShortcut(id: string, combo: string) {
  const s = useSettings.getState();
  s.update({ shortcuts: withBinding(s.settings.shortcuts, id, combo, isMac) });
}
