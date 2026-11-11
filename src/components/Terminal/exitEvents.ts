// Reparte el evento global EV_TERMINAL_EXIT a cada terminal por su termId.
// El evento puede llegar antes de que `terminal.open` resuelva: se guarda hasta que alguien lo reclame.
import { listen } from "@tauri-apps/api/event";
import { EV_TERMINAL_EXIT, type TerminalExit } from "../../api/types";

type ExitHandler = (code: number | null) => void;

const handlers = new Map<string, ExitHandler>();
const early = new Map<string, number | null>();
let ready: Promise<unknown> | null = null;

/** Asegura que el oyente global está activo (resuelve cuando ya escucha). */
export function ensureExitListener(): Promise<unknown> {
  if (!ready) {
    ready = listen<TerminalExit>(EV_TERMINAL_EXIT, (e) => {
      const { termId, code } = e.payload;
      const h = handlers.get(termId);
      if (h) {
        handlers.delete(termId);
        h(code);
      } else {
        early.set(termId, code);
        // No acumular para siempre ids que nadie reclamará.
        if (early.size > 64) {
          const first = early.keys().next().value;
          if (first !== undefined) early.delete(first);
        }
      }
    }).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/** Registra el aviso de salida para `termId`. Devuelve la función para anularlo. */
export function onTerminalExit(termId: string, handler: ExitHandler): () => void {
  if (early.has(termId)) {
    const code = early.get(termId) ?? null;
    early.delete(termId);
    queueMicrotask(() => handler(code));
    return () => {};
  }
  handlers.set(termId, handler);
  return () => {
    if (handlers.get(termId) === handler) handlers.delete(termId);
  };
}
