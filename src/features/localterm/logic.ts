// Funciones puras de las pestañas locales (sin React ni Tauri), con pruebas en localterm.test.ts.
import { localBasename } from "../../lib/platform";

/** Qué corre en la pestaña local. */
export type LocalKind = "shell" | "claude" | "codex";

export const KIND_LABEL: Record<LocalKind, string> = {
  shell: "Terminal local",
  claude: "Claude Code",
  codex: "Codex",
};

/** Título de la pestaña: la carpeta para una terminal; «Claude Code · carpeta» para un asistente. */
export function titleFor(kind: LocalKind, cwd: string | null): string {
  const dir = cwd ? localBasename(cwd) : null;
  if (kind === "shell") return dir || "Este equipo";
  return dir ? `${KIND_LABEL[kind]} · ${dir}` : KIND_LABEL[kind];
}

/** Pestaña a mostrar al cerrar `id`: la de la izquierda, o la siguiente si era la primera. */
export function pickNeighbor(ids: readonly string[], id: string): string | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i - 1] ?? ids[i + 1] ?? null;
}
