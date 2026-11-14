// Preferencia «Al abrir un archivo»: en una pestaña más (por defecto), dividido junto al explorador o en ventana aparte.
// Se guarda en localStorage y no en Settings: Settings es un tipo compartido con el motor (Rust)
// y esta opción solo afecta a la interfaz (igual que gpuPref de la terminal).

export type EditorOpenMode = "tab" | "split" | "window";

const KEY = "sshorus.editor.openMode";
/** Versión del valor guardado: sin ella, el valor viene de la versión de prueba en la que «dividido» era lo normal. */
const VERSION_KEY = "sshorus.editor.openMode.v";
const VERSION = "2";
const MODES: EditorOpenMode[] = ["tab", "split", "window"];
/** Copia en memoria por si localStorage no está disponible. */
let fallback: EditorOpenMode = "tab";
let migrated = false;

/**
 * Migración única: antes el editor se abría siempre dividido («split», o «maximized»). Como no se puede saber
 * si «split» se eligió a propósito o era el valor por defecto, ambos pasan a «tab»; «window» se conserva.
 */
function migrate(): void {
  if (migrated) return;
  migrated = true;
  try {
    if (localStorage.getItem(VERSION_KEY) === VERSION) return;
    const old = localStorage.getItem(KEY);
    if (old !== null && old !== "window") localStorage.setItem(KEY, "tab");
    localStorage.setItem(VERSION_KEY, VERSION);
  } catch {
    /* sin almacenamiento */
  }
}

/** «tab» salvo que el usuario haya elegido otra cosa. */
export function getEditorOpenMode(): EditorOpenMode {
  migrate();
  try {
    const v = localStorage.getItem(KEY) as EditorOpenMode | null;
    return v && MODES.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function setEditorOpenMode(mode: EditorOpenMode): void {
  migrate();
  fallback = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* sin almacenamiento: vale solo para esta sesión */
  }
}
