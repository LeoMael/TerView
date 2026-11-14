import { call } from "./core";

/** Archivos de texto LOCALES elegidos por el usuario (máx. 5 MB). Rutas completas. */
export const localfs = {
  /** Guarda de forma atómica (crea o reemplaza el archivo). */
  writeText: (path: string, content: string) => call<void>("local_write_text", { path, content }),
  /** Guarda bytes (imagen exportada, máx. 20 MB). */
  writeBytes: (path: string, data: Uint8Array) => call<void>("local_write_bytes", { path, data: Array.from(data) }),
  /** Lee como texto UTF-8. */
  readText: (path: string) => call<string>("local_read_text", { path }),
};
