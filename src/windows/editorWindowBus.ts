// Comunicación entre la ventana principal y las ventanas de editor aparte (eventos de Tauri).
// Módulo pequeño y sin dependencias pesadas: lo importan las dos ventanas.
//
//   principal → editor   EV_EDW_STATUS          estado de la conexión (respuesta a HELLO y en cada cambio)
//                        EV_EDW_SETTINGS        ajustes actualizados (tema, fuente del editor…)
//                        EV_EDW_REQUEST_RETURN  «tráelo de vuelta»: la ventana decide (puede tener cambios sin guardar)
//   editor → principal   EV_EDW_HELLO           la ventana está lista y pide el estado de la conexión
//                        EV_EDW_DIRTY           el archivo tiene / ya no tiene cambios sin guardar
//                        EV_EDW_RETURN          el archivo vuelve como pestaña (botón «Volver» o cierre de la ventana)
//                        EV_EDW_OPEN_SETTINGS   abrir Ajustes en la principal
import type { Settings } from "../api/types";

export const EV_EDW_HELLO = "editor-window://hello";
export const EV_EDW_STATUS = "editor-window://status";
export const EV_EDW_SETTINGS = "editor-window://settings";
export const EV_EDW_DIRTY = "editor-window://dirty";
export const EV_EDW_RETURN = "editor-window://return";
export const EV_EDW_REQUEST_RETURN = "editor-window://request-return";
export const EV_EDW_OPEN_SETTINGS = "editor-window://open-settings";

/** Etiqueta de la ventana principal (tauri.conf.json). */
export const MAIN_WINDOW = "main";
/** Prefijo de las ventanas de editor (la capability `editor-window` usa `editor-*`). */
export const EDITOR_WINDOW_PREFIX = "editor-";

export type SessionStatus = "connected" | "reconnecting" | "closed";

/** Identifica el archivo de una ventana. */
export interface EditorFileRef {
  sessionId: string;
  path: string;
}

export interface EdwHello extends EditorFileRef {
  label: string;
}
export interface EdwStatus {
  status: SessionStatus;
  reason: string | null;
}
export interface EdwDirty extends EditorFileRef {
  dirty: boolean;
}
export interface EdwReturn extends EditorFileRef {
  /** true: activar la pestaña y enfocar la ventana principal («Volver a la pestaña principal»). */
  focus: boolean;
}
export type EdwSettings = Settings;

/** FNV-1a de 32 bits en hexadecimal (etiquetas estables y válidas para Tauri). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Etiqueta única de la ventana de un archivo: siempre la misma para la misma sesión y ruta. */
export function editorWindowLabel(sessionId: string, path: string): string {
  return `${EDITOR_WINDOW_PREFIX}${hash(sessionId)}${hash(path)}`;
}

/** Parámetros de la URL de una ventana de editor (`index.html?view=editor&…`). */
export interface EditorWindowParams extends EditorFileRef {
  server: string;
}

export function editorWindowUrl(p: EditorWindowParams): string {
  const q = new URLSearchParams({ view: "editor", session: p.sessionId, path: p.path, server: p.server });
  return `index.html?${q.toString()}`;
}

export function parseEditorWindowParams(search: string): EditorWindowParams | null {
  const q = new URLSearchParams(search);
  if (q.get("view") !== "editor") return null;
  const sessionId = q.get("session");
  const path = q.get("path");
  if (!sessionId || !path) return null;
  return { sessionId, path, server: q.get("server") ?? "" };
}

/** Título de la ventana: «archivo — servidor — TerView». */
export function editorWindowTitle(fileName: string, server: string): string {
  return [fileName, server, "TerView"].filter(Boolean).join(" — ");
}
