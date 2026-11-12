// Ventanas de editor aparte, vistas desde la ventana principal.
// Mientras un archivo está en otra ventana, sale del grupo de editores de su sesión (queda en `detached`);
// al volver (botón «Volver», cerrar la ventana o «Traer aquí») reaparece como pestaña.
// Solo se usa en la ventana principal.
import { create } from "zustand";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTabs, type SessionTab } from "../../stores/tabs";
import { useSettings } from "../../stores/settings";
import { useUi } from "../../stores/ui";
import { toast } from "../../stores/toasts";
import { basename } from "../../lib/paths";
import { useEditorDirty } from "../Session/sessionState";
import { useAppTheme } from "../Settings/theme";
import {
  EV_EDW_DIRTY,
  EV_EDW_HELLO,
  EV_EDW_OPEN_SETTINGS,
  EV_EDW_REQUEST_RETURN,
  EV_EDW_RETURN,
  EV_EDW_SETTINGS,
  EV_EDW_STATUS,
  editorWindowLabel,
  editorWindowTitle,
  editorWindowUrl,
  type EdwDirty,
  type EdwHello,
  type EdwReturn,
  type EdwStatus,
} from "../../windows/editorWindowBus";

interface DetachedState {
  /** sessionId → rutas abiertas en ventanas aparte */
  bySession: Record<string, string[]>;
  /** Petición de mostrar un archivo que acaba de volver (la atiende su SessionView). */
  reveal: { sessionId: string; path: string; seq: number } | null;
}

export const useDetachedEditors = create<DetachedState>(() => ({ bySession: {}, reveal: null }));

/** Ventanas abiertas: etiqueta → archivo. */
const windows = new Map<string, { sessionId: string; path: string }>();

function addDetached(sessionId: string, path: string) {
  useDetachedEditors.setState((s) => {
    const cur = s.bySession[sessionId] ?? [];
    if (cur.includes(path)) return s;
    return { bySession: { ...s.bySession, [sessionId]: [...cur, path] } };
  });
}

function removeDetached(sessionId: string, path: string): boolean {
  const cur = useDetachedEditors.getState().bySession[sessionId];
  if (!cur?.includes(path)) return false;
  useDetachedEditors.setState((s) => ({
    bySession: { ...s.bySession, [sessionId]: (s.bySession[sessionId] ?? []).filter((p) => p !== path) },
  }));
  return true;
}

export function isDetached(sessionId: string, path: string): boolean {
  return useDetachedEditors.getState().bySession[sessionId]?.includes(path) ?? false;
}

function tabOf(sessionId: string): SessionTab | undefined {
  return useTabs.getState().tabs.find((t) => t.sessionId === sessionId);
}

function statusOf(sessionId: string): EdwStatus {
  const t = tabOf(sessionId);
  if (!t) return { status: "closed", reason: "la pestaña de conexión se cerró" };
  return { status: t.status, reason: t.status === "connected" ? null : t.closedReason };
}

/** El archivo vuelve a la ventana principal (idempotente: puede llegar por el evento y por el cierre). */
function handleReturn(r: EdwReturn) {
  windows.delete(editorWindowLabel(r.sessionId, r.path));
  const wasDetached = removeDetached(r.sessionId, r.path);
  useEditorDirty.getState().setDirty(r.sessionId, r.path, false);
  if (!wasDetached || !r.focus || !tabOf(r.sessionId)) return;
  const tab = tabOf(r.sessionId);
  if (tab) useTabs.getState().setActive(tab.id);
  useDetachedEditors.setState((s) => ({ reveal: { sessionId: r.sessionId, path: r.path, seq: (s.reveal?.seq ?? 0) + 1 } }));
  const w = getCurrentWindow();
  void w.unminimize().catch(() => {});
  void w.setFocus().catch(() => {});
}

let bridgeStarted = false;

/** Escucha a las ventanas de editor y les reenvía ajustes y estado de la conexión. Idempotente. */
export function initEditorWindowsBridge(): void {
  if (bridgeStarted) return;
  bridgeStarted = true;
  try {
    void listen<EdwHello>(EV_EDW_HELLO, (e) => {
      const { label, sessionId } = e.payload;
      void emitTo(label, EV_EDW_STATUS, statusOf(sessionId)).catch(() => {});
      void emitTo(label, EV_EDW_SETTINGS, useSettings.getState().settings).catch(() => {});
    });
    void listen<EdwDirty>(EV_EDW_DIRTY, (e) => {
      const { sessionId, path, dirty } = e.payload;
      if (isDetached(sessionId, path)) useEditorDirty.getState().setDirty(sessionId, path, dirty);
    });
    void listen<EdwReturn>(EV_EDW_RETURN, (e) => handleReturn(e.payload));
    void listen(EV_EDW_OPEN_SETTINGS, () => {
      useUi.getState().openSettings();
      const w = getCurrentWindow();
      void w.unminimize().catch(() => {});
      void w.setFocus().catch(() => {});
    });
  } catch {
    /* fuera de Tauri */
  }

  // Ajustes (tema, fuente…) → ventanas de editor.
  useSettings.subscribe((s, prev) => {
    if (s.settings === prev.settings || windows.size === 0) return;
    for (const label of windows.keys()) void emitTo(label, EV_EDW_SETTINGS, s.settings).catch(() => {});
  });

  // Pestañas: estado de la conexión → ventanas; pestaña cerrada → se cierran sus ventanas.
  useTabs.subscribe((s, prev) => {
    if (s.tabs === prev.tabs || windows.size === 0) return;
    const before = new Map(prev.tabs.map((t) => [t.sessionId, t]));
    const now = new Map(s.tabs.map((t) => [t.sessionId, t]));
    for (const [label, f] of [...windows]) {
      const t = now.get(f.sessionId);
      if (!t) {
        // La confirmación de cambios sin guardar ya la hizo requestCloseTab / reconnectTab.
        closeWindow(label, f.sessionId, f.path);
        continue;
      }
      const old = before.get(f.sessionId);
      if (old && (old.status !== t.status || old.closedReason !== t.closedReason)) {
        void emitTo(label, EV_EDW_STATUS, statusOf(f.sessionId)).catch(() => {});
      }
    }
  });
}

function closeWindow(label: string, sessionId: string, path: string) {
  windows.delete(label);
  removeDetached(sessionId, path);
  useEditorDirty.getState().setDirty(sessionId, path, false);
  void WebviewWindow.getByLabel(label)
    .then((w) => w?.destroy())
    .catch(() => {});
}

/** Color de fondo actual (evita el destello blanco al abrir la ventana en tema oscuro). */
function backgroundColor(): [number, number, number] | undefined {
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return undefined;
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/** Punto de la pantalla (píxeles lógicos) donde colocar la ventana nueva, p. ej. donde se soltó la pestaña. */
export interface WindowAt {
  screenX: number;
  screenY: number;
}

const WIN_W = 1000;
const WIN_H = 720;

/**
 * Posición de la ventana para que la pestaña soltada quede bajo el cursor. En Wayland las coordenadas de pantalla
 * no son fiables (a menudo 0) y el compositor decide dónde va la ventana: entonces se deja centrada.
 */
function placement(at: WindowAt | undefined): { x: number; y: number } | null {
  if (!at || !Number.isFinite(at.screenX) || !Number.isFinite(at.screenY)) return null;
  if (at.screenX <= 0 && at.screenY <= 0) return null;
  // Sin recortar a la pantalla principal: con varios monitores las coordenadas pueden ser negativas o enormes.
  return { x: Math.round(at.screenX - 140), y: Math.round(at.screenY - 20) };
}

/** Abre el archivo en una ventana nativa aparte (o enfoca la que ya lo tiene). */
export async function openInWindow(sessionId: string, path: string, at?: WindowAt): Promise<boolean> {
  initEditorWindowsBridge();
  const label = editorWindowLabel(sessionId, path);
  if (windows.has(label)) {
    await focusEditorWindow(sessionId, path);
    return true;
  }
  const tab = tabOf(sessionId);
  const server = tab?.title ?? "";
  windows.set(label, { sessionId, path });
  addDetached(sessionId, path);
  const pos = placement(at);
  try {
    const w = new WebviewWindow(label, {
      url: editorWindowUrl({ sessionId, path, server }),
      title: editorWindowTitle(basename(path), server),
      width: WIN_W,
      height: WIN_H,
      minWidth: 480,
      minHeight: 320,
      ...(pos ? { x: pos.x, y: pos.y } : { center: true }),
      focus: true,
      theme: useAppTheme.getState().theme,
      backgroundColor: backgroundColor(),
    });
    void w.once<string>("tauri://error", (e) => {
      windows.delete(label);
      removeDetached(sessionId, path);
      toast.error("No se pudo abrir la ventana", typeof e.payload === "string" ? e.payload : undefined);
    });
    // Respaldo: si la ventana desaparece sin avisar, el archivo vuelve igualmente.
    void w.once("tauri://destroyed", () => handleReturn({ sessionId, path, focus: false }));
    return true;
  } catch (e) {
    windows.delete(label);
    removeDetached(sessionId, path);
    toast.error("No se pudo abrir la ventana", e);
    return false;
  }
}

/** Trae al frente la ventana del archivo. */
export async function focusEditorWindow(sessionId: string, path: string): Promise<void> {
  try {
    const w = await WebviewWindow.getByLabel(editorWindowLabel(sessionId, path));
    if (!w) {
      // Ya no existe: el archivo vuelve a su pestaña.
      handleReturn({ sessionId, path, focus: false });
      return;
    }
    await w.unminimize().catch(() => {});
    await w.setFocus();
  } catch {
    /* fuera de Tauri */
  }
}

/** Pide a la ventana que devuelva el archivo (si tiene cambios sin guardar, pregunta allí). */
export async function requestReturn(sessionId: string, path: string): Promise<void> {
  const label = editorWindowLabel(sessionId, path);
  if (!windows.has(label)) {
    handleReturn({ sessionId, path, focus: true });
    return;
  }
  try {
    await emitTo(label, EV_EDW_REQUEST_RETURN, null);
  } catch {
    handleReturn({ sessionId, path, focus: true });
  }
}
