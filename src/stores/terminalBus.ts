// Puente para escribir en la terminal activa de una sesión desde otros componentes
// (p. ej. la Biblioteca de comandos). BASE compartida.
//   TerminalArea registra su terminal activa con registerTerminalWriter(sessionId, fn).
//   Otros llaman a sendToTerminal(sessionId, texto, ejecutar).

type Writer = (text: string) => void;

const writers = new Map<string, Writer>();

/** Registra (o reemplaza) el escritor de la terminal activa de la sesión. Devuelve función para quitarlo. */
export function registerTerminalWriter(sessionId: string, writer: Writer): () => void {
  writers.set(sessionId, writer);
  return () => {
    if (writers.get(sessionId) === writer) writers.delete(sessionId);
  };
}

export function hasTerminal(sessionId: string): boolean {
  return writers.has(sessionId);
}

/**
 * Escribe `text` en la terminal activa de la sesión. Si `execute`, añade Enter ("\r").
 * Devuelve false si la sesión no tiene terminal abierta.
 */
export function sendToTerminal(sessionId: string, text: string, execute: boolean): boolean {
  const w = writers.get(sessionId);
  if (!w) return false;
  w(execute ? `${text}\r` : text);
  return true;
}
