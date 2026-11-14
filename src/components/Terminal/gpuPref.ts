// Preferencia «Aceleración por GPU en la terminal» (xterm.js con WebGL).
// Se guarda en localStorage y no en Settings: Settings es un tipo compartido con el motor (Rust)
// y esta opción solo afecta al dibujado de la interfaz. Módulo pequeño a propósito: lo usan los
// Ajustes sin arrastrar xterm.js.

const KEY = "sshorus.terminal.gpu";
const listeners = new Set<(on: boolean) => void>();

/** true salvo que el usuario la haya desactivado. */
export function getTerminalGpu(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setTerminalGpu(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* sin almacenamiento: vale solo para esta sesión */
  }
  for (const l of listeners) l(on);
}

/** Avisa cuando cambia (las terminales abiertas se adaptan al momento). */
export function onTerminalGpuChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** WebGL no se pudo crear (sin soporte en este equipo): no se vuelve a intentar hasta reiniciar. */
let webglUnsupported = false;
export function markWebglUnsupported(): void {
  webglUnsupported = true;
}
export function isWebglUnsupported(): boolean {
  return webglUnsupported;
}
