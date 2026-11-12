// Marcas de tiempo del arranque (performance.mark). Sin dependencias: se importa desde main.tsx
// y no debe engordar el código inicial.

export const BOOT_MARKS = {
  /** main.tsx empieza a ejecutarse (HTML y código inicial ya descargados y analizados). */
  main: "tv:main",
  /** La interfaz principal se dibuja por primera vez. */
  firstRender: "tv:first-render",
  /** Ajustes y servidores cargados desde el motor: la app ya se puede usar. */
  appReady: "tv:app-ready",
} as const;

export type BootMarkName = (typeof BOOT_MARKS)[keyof typeof BOOT_MARKS];

export function markBoot(name: BootMarkName) {
  try {
    if (performance.getEntriesByName(name, "mark").length === 0) performance.mark(name);
  } catch {
    // Sin API de rendimiento: el panel mostrará «—».
  }
}

/** Milisegundos desde que se empezó a cargar la ventana hasta la marca, o null si aún no ocurrió. */
export function bootTime(name: BootMarkName): number | null {
  try {
    const e = performance.getEntriesByName(name, "mark")[0];
    return e ? e.startTime : null;
  } catch {
    return null;
  }
}
