import { call } from "./core";
import type { ExecResult, Snippet } from "./types";

export const snippets = {
  /** "Mis comandos" guardados. */
  load: () => call<Snippet[]>("snippets_load"),
  /** Crea o actualiza (id "" = nuevo). */
  save: (snippet: Snippet) => call<Snippet>("snippets_save", { snippet }),
  delete: (id: string) => call<void>("snippets_delete", { id }),
  /**
   * Ejecuta un comando aparte (canal exec) y captura la salida. Si vence `timeoutSecs`, el proceso
   * remoto se detiene y el resultado llega con `timedOut`.
   * `execId` (opcional, único; p. ej. `newExecId()`) permite cancelarlo con `cancelExec`: entonces
   * se detiene también en el servidor y la promesa falla con el error `Canceled`.
   */
  exec: (sessionId: string, command: string, timeoutSecs = 30, execId?: string) =>
    call<ExecResult>("exec_capture", { sessionId, command, timeoutSecs, execId }),
  /**
   * Igual que `exec`, pero escribe `stdin` en la entrada estándar del comando y luego envía EOF.
   * Para contraseñas (sudo -S, chpasswd): nunca las pongas en `command`.
   */
  execStdin: (sessionId: string, command: string, stdin: string, timeoutSecs = 30, execId?: string) =>
    call<ExecResult>("exec_capture_stdin", { sessionId, command, stdin, timeoutSecs, execId }),
  /**
   * Ejecuta un comando escrito por el usuario (con uno o varios `sudo`, tuberías…) dando `password` a cada
   * sudo desde un envoltorio del motor (askpass + FIFO, ver src-tauri/src/snippets/sudo.rs): nunca va en la
   * línea de comandos. Se comprueba una vez antes: si sudo la rechaza no se ejecuta nada y llega
   * `sudoFailure: "bad-password"`.
   */
  execSudo: (sessionId: string, command: string, password: string, timeoutSecs = 30, execId?: string) =>
    call<SudoExecResult>("exec_capture_sudo", { sessionId, command, password, timeoutSecs, execId }),
  /** Cancela una ejecución con `execId` y detiene el proceso remoto. false si ya había terminado. */
  cancelExec: (execId: string) => call<boolean>("exec_cancel", { execId }),
};

/** Por qué sudo no llegó a ejecutar el comando de `execSudo`. */
export type SudoWrapFailure = "bad-password" | "denied" | "tty-required" | "no-temp" | "no-sudo";

export interface SudoExecResult extends ExecResult {
  /** null = sudo aceptó la contraseña (el resultado es el del comando). */
  sudoFailure: SudoWrapFailure | null;
}

/** Identificador nuevo para `exec` / `execStdin` cuando se quiere poder cancelar. */
export function newExecId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Por si el webview no ofrece randomUUID: 16 bytes aleatorios en hexadecimal.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
