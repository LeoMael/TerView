// Atajos de teclado: registro de acciones y funciones puras (sin React ni stores) para
// normalizar combinaciones, compararlas con eventos, mostrarlas y detectar conflictos.
// Una combinación se guarda como texto canónico: "Ctrl+Alt+Shift+Meta+Tecla" (en ese orden);
// "Meta" es ⌘ en macOS. "" = sin atajo.

export type ShortcutScope = "global" | "terminal" | "explorer" | "editor";

export interface ShortcutAction {
  id: string;
  /** Nombre en español para Ajustes. */
  label: string;
  group: "Generales" | "Terminal" | "Explorador" | "Editor";
  /** Dónde funciona: global (toda la ventana) o solo con el foco en esa zona. */
  scope: ShortcutScope;
  /** Atajo por defecto en Linux y Windows. */
  def: string;
  /** Atajo por defecto en macOS (si no se indica, el mismo). */
  mac?: string;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "app.palette", label: "Paleta de comandos", group: "Generales", scope: "global", def: "Ctrl+Shift+P", mac: "Shift+Meta+P" },
  { id: "tabs.next", label: "Pestaña siguiente", group: "Generales", scope: "global", def: "Ctrl+Tab" },
  { id: "tabs.prev", label: "Pestaña anterior", group: "Generales", scope: "global", def: "Ctrl+Shift+Tab" },
  { id: "tabs.nextConn", label: "Conexión siguiente", group: "Generales", scope: "global", def: "Ctrl+PageDown" },
  { id: "tabs.prevConn", label: "Conexión anterior", group: "Generales", scope: "global", def: "Ctrl+PageUp" },
  { id: "tabs.close", label: "Cerrar la pestaña actual", group: "Generales", scope: "global", def: "Ctrl+W", mac: "Meta+W" },
  { id: "app.sidebar", label: "Mostrar u ocultar la barra lateral", group: "Generales", scope: "global", def: "Ctrl+B", mac: "Meta+B" },
  { id: "session.terminal", label: "Mostrar u ocultar la terminal", group: "Generales", scope: "global", def: "Ctrl+`" },
  { id: "session.split", label: "Dividir o quitar la división", group: "Generales", scope: "global", def: "Ctrl+Shift+M" },
  { id: "app.settings", label: "Ajustes", group: "Generales", scope: "global", def: "Ctrl+,", mac: "Meta+," },
  { id: "app.lock", label: "Bloquear TerView", group: "Generales", scope: "global", def: "Ctrl+Shift+L", mac: "Shift+Meta+L" },
  { id: "term.copy", label: "Copiar", group: "Terminal", scope: "terminal", def: "Ctrl+Shift+C" },
  { id: "term.paste", label: "Pegar", group: "Terminal", scope: "terminal", def: "Ctrl+Shift+V" },
  { id: "term.find", label: "Buscar", group: "Terminal", scope: "terminal", def: "Ctrl+Shift+F" },
  { id: "explorer.path", label: "Escribir una ruta", group: "Explorador", scope: "explorer", def: "Ctrl+L", mac: "Meta+L" },
  { id: "explorer.filter", label: "Filtrar por nombre", group: "Explorador", scope: "explorer", def: "Ctrl+F", mac: "Meta+F" },
  { id: "explorer.selectAll", label: "Seleccionar todo", group: "Explorador", scope: "explorer", def: "Ctrl+A", mac: "Meta+A" },
  { id: "explorer.up", label: "Subir de carpeta", group: "Explorador", scope: "explorer", def: "Alt+ArrowUp" },
  { id: "explorer.back", label: "Atrás", group: "Explorador", scope: "explorer", def: "Alt+ArrowLeft" },
  { id: "explorer.forward", label: "Adelante", group: "Explorador", scope: "explorer", def: "Alt+ArrowRight" },
  { id: "explorer.rename", label: "Renombrar", group: "Explorador", scope: "explorer", def: "F2" },
  { id: "explorer.delete", label: "Eliminar", group: "Explorador", scope: "explorer", def: "Delete" },
  { id: "explorer.refresh", label: "Refrescar", group: "Explorador", scope: "explorer", def: "F5" },
  { id: "editor.save", label: "Guardar el archivo en el servidor", group: "Editor", scope: "editor", def: "Ctrl+S", mac: "Meta+S" },
];

export const SHORTCUT_GROUPS: ShortcutAction["group"][] = ["Generales", "Terminal", "Explorador", "Editor"];

const BY_ID = new Map(SHORTCUT_ACTIONS.map((a) => [a.id, a]));
export const actionById = (id: string): ShortcutAction | undefined => BY_ID.get(id);

/** Cambios del usuario: id → combinación ("" = sin atajo). */
export type ShortcutOverrides = Record<string, string>;

// ───────── Teclas ─────────

const MODS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Mod = (typeof MODS)[number];

/** Nombre de tecla a partir de `KeyboardEvent.code` (independiente de la distribución del teclado). */
const CODE_NAMES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  NumpadEnter: "Enter",
};

const NAMED = new Set([
  "Tab", "Enter", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
]);
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "Super", "Hyper", "CapsLock", "Fn"]);

/** Normaliza el nombre de la tecla principal ("p" → "P", "esc" → "Escape"); "" si no es válida. */
export function normalizeKey(raw: string): string {
  if (!raw) return "";
  if (raw === " ") return "Space";
  if (raw.length === 1) return raw.toUpperCase();
  const low = raw.toLowerCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(low)) return low.toUpperCase();
  const alias: Record<string, string> = { esc: "Escape", del: "Delete", supr: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", return: "Enter", spacebar: "Space" };
  if (alias[low]) return alias[low];
  for (const n of NAMED) if (n.toLowerCase() === low) return n;
  return "";
}

/** Combinación canónica a partir de un texto ("shift+ctrl+p" → "Ctrl+Shift+P"); "" si no es válida. */
export function normalizeCombo(text: string): string {
  if (!text) return "";
  // "+" como tecla: "Ctrl++" → partes ["Ctrl", "", ""].
  const parts = text.split("+");
  let key = parts.pop() ?? "";
  if (key === "" && parts.length && parts[parts.length - 1] === "") {
    parts.pop();
    key = "+";
  }
  const mods = new Set<Mod>();
  for (const p of parts) {
    const l = p.trim().toLowerCase();
    if (l === "ctrl" || l === "control") mods.add("Ctrl");
    else if (l === "alt" || l === "option") mods.add("Alt");
    else if (l === "shift" || l === "mayús" || l === "mayus") mods.add("Shift");
    else if (l === "meta" || l === "cmd" || l === "command" || l === "super") mods.add("Meta");
    else return "";
  }
  const k = normalizeKey(key.trim() || key);
  if (!k) return "";
  return [...MODS.filter((m) => mods.has(m)), k].join("+");
}

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function modPrefix(e: KeyLike): string {
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean).join("+");
}

/** Tecla según la posición física (`code`): "KeyP" → "P", "Digit1" → "1", "Backquote" → "`". */
function keyFromCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  return normalizeKey(code);
}

/** Es solo una tecla modificadora (Ctrl, Shift…): aún no hay combinación completa. */
export function isModifierOnly(e: { key: string }): boolean {
  return MODIFIER_KEYS.has(e.key);
}

/** Combinaciones que representa un evento: por posición física y por carácter (pueden coincidir). */
export function eventCombos(e: KeyLike): string[] {
  if (isModifierOnly(e)) return [];
  const pre = modPrefix(e);
  const out: string[] = [];
  for (const k of [keyFromCode(e.code), normalizeKey(e.key)]) {
    if (!k) continue;
    const c = pre ? `${pre}+${k}` : k;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Combinación principal de un evento (para capturar un atajo nuevo). */
export function eventCombo(e: KeyLike): string {
  return eventCombos(e)[0] ?? "";
}

// ───────── Valores efectivos ─────────

export function defaultCombo(a: ShortcutAction, mac: boolean): string {
  return mac && a.mac !== undefined ? a.mac : a.def;
}

/** Atajo efectivo de una acción: el del usuario (si es válido) o el de por defecto. */
export function resolveCombo(id: string, overrides: ShortcutOverrides | undefined, mac: boolean): string {
  const a = BY_ID.get(id);
  if (!a) return "";
  const o = overrides?.[id];
  if (o === "") return "";
  if (typeof o === "string") {
    const n = normalizeCombo(o);
    if (n) return n;
  }
  return defaultCombo(a, mac);
}

/** Atajos efectivos de todas las acciones. */
export function resolveAll(overrides: ShortcutOverrides | undefined, mac: boolean): Record<string, string> {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, resolveCombo(a.id, overrides, mac)]));
}

/** Limpia lo guardado: quita acciones desconocidas, combinaciones inválidas y las iguales al valor por defecto. */
export function cleanOverrides(overrides: unknown, mac: boolean): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!overrides || typeof overrides !== "object") return out;
  for (const [id, v] of Object.entries(overrides as Record<string, unknown>)) {
    const a = BY_ID.get(id);
    if (!a || typeof v !== "string") continue;
    const n = v === "" ? "" : normalizeCombo(v);
    if (v !== "" && !n) continue;
    if (n === defaultCombo(a, mac)) continue;
    out[id] = n;
  }
  return out;
}

/** Nuevos cambios tras asignar `combo` a `id` (solo se guarda lo distinto del valor por defecto). */
export function withBinding(overrides: ShortcutOverrides | undefined, id: string, combo: string, mac: boolean): ShortcutOverrides {
  const a = BY_ID.get(id);
  const next = { ...(overrides ?? {}) };
  if (!a) return next;
  const n = combo === "" ? "" : normalizeCombo(combo);
  if (n === defaultCombo(a, mac)) delete next[id];
  else next[id] = n;
  return next;
}

/** ¿El evento corresponde a esta combinación? */
export function comboMatches(combo: string, e: KeyLike): boolean {
  return !!combo && eventCombos(e).includes(combo);
}

// ───────── Mostrar ─────────

const KEY_LABELS: Record<string, string> = {
  PageUp: "RePág",
  PageDown: "AvPág",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Delete: "Supr",
  Backspace: "Retroceso",
  Escape: "Esc",
  Space: "Espacio",
  Insert: "Insert",
};

/** Texto de una combinación: "Ctrl+Shift+P" o, en macOS, "⌘⇧P". */
export function formatCombo(combo: string, mac: boolean): string {
  if (!combo) return "";
  const parts = combo === "+" ? ["+"] : combo.split(/\+(?!$)/);
  const key = parts.pop() ?? "";
  const label = KEY_LABELS[key] ?? key;
  if (mac) {
    const sym: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
    // Orden habitual en macOS: ⌃⌥⇧⌘.
    return ["Ctrl", "Alt", "Shift", "Meta"].filter((m) => parts.includes(m)).map((m) => sym[m]).join("") + label;
  }
  return [...parts.map((m) => (m === "Meta" ? "Super" : m)), label].join("+");
}

/** Partes de la combinación para dibujarlas como teclas. */
export function comboKeys(combo: string, mac: boolean): string[] {
  if (!combo) return [];
  if (mac) return [formatCombo(combo, true)];
  return formatCombo(combo, false).split(/\+(?!$)/);
}

// ───────── Conflictos y avisos ─────────

function parts(combo: string): { mods: Set<string>; key: string } {
  const p = combo.split(/\+(?!$)/);
  const key = p.pop() ?? "";
  return { mods: new Set(p), key };
}

/** Dos acciones pueden compartir atajo si funcionan en zonas distintas (terminal, explorador, editor). */
function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  return a === "global" || b === "global" || a === b;
}

/** Acciones que ya usan `combo` y chocarían con `id`. */
export function findConflicts(id: string, combo: string, overrides: ShortcutOverrides | undefined, mac: boolean): ShortcutAction[] {
  const me = BY_ID.get(id);
  if (!me || !combo) return [];
  return SHORTCUT_ACTIONS.filter(
    (a) => a.id !== id && scopesOverlap(me.scope, a.scope) && resolveCombo(a.id, overrides, mac) === combo,
  );
}

/** Teclas con Ctrl (sin Mayús) que usa la terminal: no conviene quitárselas. */
const TERMINAL_KEYS: Record<string, string> = {
  C: "interrumpe el programa",
  D: "cierra la sesión (fin de entrada)",
  Z: "suspende el programa",
  L: "limpia la pantalla",
  R: "busca en el historial",
  A: "va al inicio de la línea",
  E: "va al final de la línea",
  U: "borra la línea",
  K: "borra hasta el final",
  W: "borra la palabra anterior",
  B: "es la tecla de tmux",
  S: "detiene la salida",
  Q: "reanuda la salida",
  V: "inserta el siguiente carácter tal cual",
};

/** Con el foco en la terminal, ¿esta combinación es de la shell? (Ctrl+letra o Alt+letra sin Mayús.) */
export function terminalOwns(combo: string): boolean {
  const { mods, key } = parts(combo);
  if (mods.has("Shift") || mods.has("Meta")) return false;
  const letter = /^[A-Z]$/.test(key) || key === "[" || key === "]" || key === "\\" || key === "/";
  if (!letter) return false;
  return mods.has("Ctrl") || (mods.has("Alt") && !mods.has("Ctrl"));
}

/** Avisos sobre una combinación: choques con la terminal, el sistema o la escritura. */
export function comboWarnings(combo: string, scope: ShortcutScope, mac: boolean): string[] {
  if (!combo) return [];
  const { mods, key } = parts(combo);
  const out: string[] = [];
  const label = formatCombo(combo, mac);
  const onlyCtrl = mods.has("Ctrl") && !mods.has("Shift") && !mods.has("Alt") && !mods.has("Meta");
  if (onlyCtrl && TERMINAL_KEYS[key]) {
    out.push(`En la terminal, ${label} ${TERMINAL_KEYS[key]}.`);
  } else if (scope === "terminal" && terminalOwns(combo)) {
    out.push(`${label} lo usan programas de la terminal (shell, editores).`);
  } else if (scope === "global" && terminalOwns(combo)) {
    out.push(`Con el foco en la terminal, ${label} será para la terminal.`);
  }
  const sys: Record<string, string> = mac
    ? { "Meta+Q": "cierra la aplicación", "Meta+H": "oculta la ventana", "Meta+M": "minimiza la ventana", "Meta+Tab": "cambia de aplicación", "Meta+Space": "abre Spotlight", "Meta+C": "copia", "Meta+V": "pega", "Meta+X": "corta", "Meta+Z": "deshace" }
    : { "Alt+F4": "cierra la ventana", "Alt+Tab": "cambia de ventana", "Ctrl+Alt+Delete": "es del sistema", "Ctrl+C": "copia en los campos de texto", "Ctrl+V": "pega en los campos de texto", "Ctrl+X": "corta en los campos de texto", "Ctrl+Z": "deshace en los campos de texto", "Ctrl+R": "recargaría la ventana", "F5": "recargaría la ventana" };
  if (sys[combo] && !(combo === "F5" && scope === "explorer")) out.push(`${label} ${sys[combo]}.`);
  else if (!mac && mods.has("Meta")) out.push("Las combinaciones con la tecla Super suelen ser del sistema.");
  const plain = mods.size === 0 || (mods.size === 1 && mods.has("Shift"));
  if (plain && !/^F\d+$/.test(key) && (key.length === 1 || scope !== "explorer")) out.push("Sin Ctrl ni Alt, la tecla ya no se podría escribir.");
  return out;
}
