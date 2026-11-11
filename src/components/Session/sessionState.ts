// Estado compartido de las sesiones: archivos con cambios sin guardar y cierre/reconexión de pestañas.
import { create } from "zustand";
import { useTabs } from "../../stores/tabs";
import { ssh } from "../../api/ssh";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { connectToServer } from "../../features/connect";
import { confirmDialog } from "../ui/dialogs";
import { basename } from "../../lib/paths";

interface DirtyState {
  /** sessionId → rutas con cambios sin guardar */
  dirty: Record<string, string[]>;
  setDirty: (sessionId: string, path: string, dirty: boolean) => void;
  clearSession: (sessionId: string) => void;
}

export const useEditorDirty = create<DirtyState>((set) => ({
  dirty: {},
  setDirty: (sessionId, path, dirty) =>
    set((s) => {
      const cur = s.dirty[sessionId] ?? [];
      const has = cur.includes(path);
      if (dirty === has) return s;
      const next = dirty ? [...cur, path] : cur.filter((p) => p !== path);
      return { dirty: { ...s.dirty, [sessionId]: next } };
    }),
  clearSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.dirty)) return s;
      const rest = { ...s.dirty };
      delete rest[sessionId];
      return { dirty: rest };
    }),
}));

// ── Carpeta actual del explorador de cada sesión (para reconectar en el mismo sitio) ──
const currentPaths = new Map<string, string>();

/** El explorador informa la carpeta que muestra. */
export function setSessionPath(sessionId: string, path: string) {
  currentPaths.set(sessionId, path);
}

/** Carpeta actual de la pestaña (o la inicial si el explorador aún no informó ninguna). */
export function tabCurrentPath(tab: { sessionId: string; initialPath: string | null }): string | null {
  return currentPaths.get(tab.sessionId) ?? tab.initialPath;
}

/** Cierra una pestaña de conexión, pidiendo confirmación si hay archivos sin guardar. */
export async function requestCloseTab(tabId: string): Promise<boolean> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const dirty = useEditorDirty.getState().dirty[tab.sessionId] ?? [];
  if (dirty.length > 0) {
    const names = dirty.map((p) => basename(p));
    const ok = await confirmDialog({
      title: "Cambios sin guardar",
      message:
        dirty.length === 1
          ? `«${names[0]}» tiene cambios sin guardar en «${tab.title}». ¿Cerrar la conexión y descartarlos?`
          : `${dirty.length} archivos tienen cambios sin guardar en «${tab.title}» (${names.slice(0, 4).join(", ")}${
              dirty.length > 4 ? "…" : ""
            }). ¿Cerrar la conexión y descartarlos?`,
      confirmText: "Cerrar y descartar",
      danger: true,
    });
    if (!ok) return false;
  }
  useEditorDirty.getState().clearSession(tab.sessionId);
  currentPaths.delete(tab.sessionId);
  await useTabs.getState().closeTab(tabId);
  return true;
}

/** Mueve una pestaña a otra posición (arrastrar para reordenar). */
export function moveTab(tabId: string, toIndex: number) {
  useTabs.setState((s) => {
    const from = s.tabs.findIndex((t) => t.id === tabId);
    if (from < 0 || from === toIndex) return s;
    const tabs = [...s.tabs];
    const [t] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, t);
    return { tabs };
  });
}

const reconnecting = new Set<string>();

/** Deja de reintentar una reconexión automática: la pestaña queda desconectada (con «Reconectar»). */
export async function cancelReconnect(tabId: string): Promise<void> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.status !== "reconnecting") return;
  try {
    await ssh.disconnect(tab.sessionId);
  } catch {
    /* ya estaba cerrada */
  }
  useTabs.getState().markClosed(tab.sessionId, "reconexión cancelada");
}

/** Reconecta una pestaña cerrada: abre una nueva conexión en la misma carpeta y cierra la vieja. */
export async function reconnectTab(tabId: string): Promise<void> {
  if (reconnecting.has(tabId)) return;
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const initialPath = tabCurrentPath(tab);
  const profile = useProfiles.getState().servers.find((s) => s.id === tab.profileId);
  if (!profile) {
    toast.error("No se puede reconectar", "El servidor ya no existe en tu lista.");
    return;
  }
  const dirty = useEditorDirty.getState().dirty[tab.sessionId] ?? [];
  if (dirty.length > 0) {
    const ok = await confirmDialog({
      title: "Cambios sin guardar",
      message: `Hay ${dirty.length === 1 ? "un archivo" : `${dirty.length} archivos`} con cambios sin guardar en esta conexión. Al reconectar se abrirá una pestaña nueva y esos cambios se perderán. Copia lo que necesites antes de seguir.`,
      confirmText: "Reconectar igualmente",
      danger: true,
    });
    if (!ok) return;
  }
  reconnecting.add(tabId);
  try {
    const oldIndex = useTabs.getState().tabs.findIndex((t) => t.id === tabId);
    const before = new Set(useTabs.getState().tabs.map((t) => t.id));
    const ok = await connectToServer(profile, { initialPath });
    if (!ok) return;
    const fresh = useTabs.getState().tabs.find((t) => !before.has(t.id));
    useEditorDirty.getState().clearSession(tab.sessionId);
    currentPaths.delete(tab.sessionId);
    await useTabs.getState().closeTab(tabId);
    if (fresh) {
      moveTab(fresh.id, oldIndex);
      useTabs.getState().setActive(fresh.id);
    }
  } finally {
    reconnecting.delete(tabId);
  }
}
