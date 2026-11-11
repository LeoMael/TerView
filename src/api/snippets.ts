import { call } from "./core";
import type { ExecResult, Snippet } from "./types";

export const snippets = {
  /** "Mis comandos" guardados. */
  load: () => call<Snippet[]>("snippets_load"),
  /** Crea o actualiza (id "" = nuevo). */
  save: (snippet: Snippet) => call<Snippet>("snippets_save", { snippet }),
  delete: (id: string) => call<void>("snippets_delete", { id }),
  /** Ejecuta un comando aparte (canal exec) y captura la salida. */
  exec: (sessionId: string, command: string, timeoutSecs = 30) =>
    call<ExecResult>("exec_capture", { sessionId, command, timeoutSecs }),
};
