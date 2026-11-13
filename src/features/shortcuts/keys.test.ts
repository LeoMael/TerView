// Pruebas del registro de atajos (funciones puras).
// Ejecutar: npx rolldown src/features/shortcuts/keys.test.ts -p node -f esm -o /tmp/keys.mjs && node /tmp/keys.mjs
import {
  SHORTCUT_ACTIONS,
  cleanOverrides,
  comboMatches,
  comboWarnings,
  eventCombo,
  eventCombos,
  findConflicts,
  formatCombo,
  normalizeCombo,
  resolveAll,
  resolveCombo,
  terminalOwns,
  withBinding,
} from "./keys";

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}

function ev(key: string, code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) {
  return { key, code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta };
}

// Normalizar
eq(normalizeCombo("shift+ctrl+p"), "Ctrl+Shift+P", "orden y mayúsculas");
eq(normalizeCombo("Cmd+Shift+l"), "Shift+Meta+L", "cmd = Meta");
eq(normalizeCombo("Ctrl+pagedown"), "Ctrl+PageDown", "tecla con nombre");
eq(normalizeCombo("Ctrl++"), "Ctrl++", "el + como tecla");
eq(normalizeCombo("f5"), "F5", "tecla de función sola");
eq(normalizeCombo("Ctrl+Hiper+X"), "", "modificador desconocido");
eq(normalizeCombo("Ctrl+"), "", "sin tecla");
eq(normalizeCombo("Ctrl+Shift"), "", "solo modificadores");

// Eventos
eq(eventCombo(ev("P", "KeyP", { ctrl: true, shift: true })), "Ctrl+Shift+P", "Ctrl+Shift+P");
eq(eventCombos(ev("º", "Backquote", { ctrl: true })), ["Ctrl+`", "Ctrl+º"], "teclado español: posición y carácter");
eq(eventCombos(ev("Control", "ControlLeft", { ctrl: true })), [], "solo un modificador");
eq(eventCombo(ev("Tab", "Tab", { ctrl: true, shift: true })), "Ctrl+Shift+Tab", "Ctrl+Shift+Tab");
eq(comboMatches("Ctrl+,", ev(",", "Comma", { ctrl: true })), true, "Ctrl+,");
eq(comboMatches("Ctrl+W", ev("w", "KeyW", { ctrl: true, alt: true })), false, "Alt de más no coincide");
eq(comboMatches("Ctrl+Shift+F", ev("F", "KeyF", { ctrl: true, shift: true })), true, "búsqueda en terminal");
eq(comboMatches("", ev("a", "KeyA")), false, "sin atajo nunca coincide");

// macOS frente al resto
eq(resolveCombo("app.palette", {}, false), "Ctrl+Shift+P", "paleta Linux");
eq(resolveCombo("app.palette", {}, true), "Shift+Meta+P", "paleta macOS");
eq(resolveCombo("tabs.next", {}, true), "Ctrl+Tab", "pestañas usan Ctrl también en macOS");
eq(formatCombo("Shift+Meta+P", true), "⇧⌘P", "texto macOS");
eq(formatCombo("Ctrl+PageDown", false), "Ctrl+AvPág", "texto Linux");
eq(formatCombo("Alt+ArrowUp", false), "Alt+↑", "flecha");

// Migración: ajustes viejos sin atajos = los de por defecto; nada de basura guardada
const defaults = resolveAll(undefined, false);
eq(resolveAll({}, false), defaults, "{} = por defecto");
eq(cleanOverrides(undefined, false), {}, "sin campo");
eq(cleanOverrides({ "app.palette": "Ctrl+Shift+P", "x.y": "Ctrl+Q", "tabs.close": 3, "app.sidebar": "Ctrl+Bogus+B" }, false), {}, "iguales, desconocidas e inválidas se quitan");
eq(cleanOverrides({ "app.sidebar": "ctrl+alt+b", "tabs.close": "" }, false), { "app.sidebar": "Ctrl+Alt+B", "tabs.close": "" }, "se normalizan y se respeta «sin atajo»");
eq(resolveCombo("app.sidebar", { "app.sidebar": "Ctrl+Bogus" }, false), "Ctrl+B", "inválido → por defecto");
eq(defaults["explorer.rename"], "F2", "F2");
eq(SHORTCUT_ACTIONS.length, new Set(SHORTCUT_ACTIONS.map((a) => a.id)).size, "ids únicos");

// Guardar solo diferencias
eq(withBinding({}, "app.sidebar", "Ctrl+Alt+B", false), { "app.sidebar": "Ctrl+Alt+B" }, "cambio");
eq(withBinding({ "app.sidebar": "Ctrl+Alt+B" }, "app.sidebar", "Ctrl+B", false), {}, "volver al de por defecto lo quita");
eq(withBinding({}, "tabs.close", "", false), { "tabs.close": "" }, "sin atajo se guarda");

// Conflictos
eq(findConflicts("app.sidebar", "Ctrl+Shift+P", {}, false).map((a) => a.id), ["app.palette"], "global contra global");
eq(findConflicts("explorer.filter", "Ctrl+Shift+F", {}, false).map((a) => a.id), [], "explorador y terminal no chocan");
eq(findConflicts("app.sidebar", "Ctrl+Shift+F", {}, false).map((a) => a.id), ["term.find"], "global contra terminal");
eq(findConflicts("app.palette", "Ctrl+Shift+P", {}, false).map((a) => a.id), [], "consigo misma no");
eq(findConflicts("app.sidebar", "Ctrl+Shift+P", { "app.palette": "" }, false).map((a) => a.id), [], "si la otra quedó sin atajo");

// Terminal y sistema
eq(terminalOwns("Ctrl+W"), true, "Ctrl+W es de la shell");
eq(terminalOwns("Ctrl+Shift+W"), false, "con Mayús no");
eq(terminalOwns("Ctrl+`"), false, "Ctrl+` no");
eq(terminalOwns("Meta+W"), false, "⌘W no");
eq(comboWarnings("Ctrl+C", "global", false).length > 0, true, "Ctrl+C avisa");
eq(comboWarnings("Ctrl+Shift+K", "global", false), [], "Ctrl+Shift+K sin avisos");
eq(comboWarnings("Alt+F4", "global", false).length, 1, "Alt+F4 del sistema");
eq(comboWarnings("Meta+Q", "global", true).length, 1, "⌘Q del sistema");
eq(comboWarnings("J", "global", false).length, 1, "letra sola avisa");
eq(comboWarnings("F2", "explorer", false), [], "F2 en el explorador");

console.log(`keys: ${passed} comprobaciones OK`);
