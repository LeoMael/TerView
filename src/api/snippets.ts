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
  /**
   * Igual que `exec`, pero escribe `stdin` en la entrada estándar del comando y luego envía EOF.
   * Para contraseñas (sudo -S, chpasswd): nunca las pongas en `command`.
   */
  execStdin: (sessionId: string, command: string, stdin: string, timeoutSecs = 30) =>
    call<ExecResult>("exec_capture_stdin", { sessionId, command, stdin, timeoutSecs }),
};
