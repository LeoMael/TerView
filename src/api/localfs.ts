import { call } from "./core";

/** Archivos de texto LOCALES elegidos por el usuario (máx. 5 MB). Rutas completas. */
export const localfs = {
  /** Guarda de forma atómica (crea o reemplaza el archivo). */
  writeText: (path: string, content: string) => call<void>("local_write_text", { path, content }),
  /** Lee como texto UTF-8. */
  readText: (path: string) => call<string>("local_read_text", { path }),
};
