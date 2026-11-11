// Acciones comunes del panel y la paleta: enviar a la terminal y ejecutar aparte.
import type { ReactNode } from "react";
import { createElement } from "react";
import { snippets } from "../../api/snippets";
import type { ExecResult } from "../../api/types";
import { confirmDialog } from "../ui/dialogs";
import { hasTerminal, sendToTerminal } from "../../stores/terminalBus";
import { toast } from "../../stores/toasts";
import type { CommandItem } from "./state";

export const CAPTURE_TIMEOUT_SECS = 30;

export const OPEN_PALETTE_EVENT = "terview:open-command-palette";

/** Abre la paleta de comandos desde cualquier parte. */
export function openPalette() {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}

export type RunMode = "insert" | "run" | "capture";

/** Motivo por el que no se puede "Ejecutar y ver resultado" (o null). */
export function captureBlockedReason(item: CommandItem): string | null {
  if (item.sudo) return "Requiere contraseña: usa la terminal";
  if (item.interactive) return "Es interactivo o no termina: usa la terminal";
  return null;
}

export async function confirmDangerous(item: CommandItem, command: string): Promise<boolean> {
  if (!item.dangerous) return true;
  const message: ReactNode = createElement(
    "div",
    null,
    createElement("p", { style: { margin: "0 0 8px" } }, "Este comando puede borrar datos o cortar servicios."),
    createElement("pre", { className: "cmd-confirm-pre" }, command),
  );
  return confirmDialog({ title: `¿Ejecutar «${item.name}»?`, message, confirmText: "Ejecutar", danger: true });
}

/** Inserta o ejecuta en la terminal activa de la sesión. Devuelve true si se envió. */
export async function toTerminal(sessionId: string, item: CommandItem, command: string, execute: boolean) {
  if (!hasTerminal(sessionId)) {
    toast.info("Abre una terminal primero", "El comando se escribe en la terminal activa de esta conexión.");
    return false;
  }
  if (execute && !(await confirmDangerous(item, command))) return false;
  // Comandos multilínea: la terminal los recibe tal cual (heredocs incluidos).
  if (!sendToTerminal(sessionId, command, execute)) {
    toast.info("Abre una terminal primero");
    return false;
  }
  return true;
}

/** Ejecuta aparte (canal exec). La confirmación de peligrosos la hace quien llama. */
export function captureExec(sessionId: string, command: string): Promise<ExecResult> {
  return snippets.exec(sessionId, command, CAPTURE_TIMEOUT_SECS);
}
