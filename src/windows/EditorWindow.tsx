// Ventana nativa aparte con un solo editor remoto (index.html?view=editor&session=…&path=…).
// No monta la interfaz principal ni sus stores globales: solo tema, ajustes, diálogos y avisos.
// La conexión vive en el motor, así que usa la misma sesión (sessionId) que la pestaña de origen.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CornerUpLeft, FileCode2, RotateCw, Unplug } from "lucide-react";
import {
  EV_SESSION_CLOSED,
  EV_SESSION_RECONNECTED,
  EV_SESSION_RECONNECTING,
  type SessionClosed,
  type SessionInfo,
  type SessionReconnecting,
} from "../api/types";
import { useSettings } from "../stores/settings";
import { initThemeSync } from "../components/Settings/theme";
import { DialogHost, confirmDialog } from "../components/ui/dialogs";
import { Toaster } from "../components/ui/Toaster";
import { basename } from "../lib/paths";
import type { RemoteEditorHandle } from "../components/Editor/RemoteEditor";
import {
  EV_EDW_DIRTY,
  EV_EDW_HELLO,
  EV_EDW_OPEN_SETTINGS,
  EV_EDW_REQUEST_RETURN,
  EV_EDW_RETURN,
  EV_EDW_SETTINGS,
  EV_EDW_STATUS,
  MAIN_WINDOW,
  editorWindowTitle,
  type EditorWindowParams,
  type EdwDirty,
  type EdwHello,
  type EdwReturn,
  type EdwSettings,
  type EdwStatus,
} from "./editorWindowBus";
import { LockGate } from "../features/lock/LockGate";
import "./EditorWindow.css";

const RemoteEditor = lazy(() => import("../components/Editor/RemoteEditor"));

/** Ajustes leídos del disco. El saludo a la principal espera a esto: así los suyos (más recientes) mandan. */
let settingsReady: Promise<void> = Promise.resolve();

function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

function EditorWindow({ params }: { params: EditorWindowParams }) {
  const { sessionId, path, server } = params;
  const name = basename(path);
  const loaded = useSettings((s) => s.loaded);
  const [conn, setConn] = useState<EdwStatus>({ status: "connected", reason: null });
  const connRef = useRef(conn);
  connRef.current = conn;
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const editorRef = useRef<RemoteEditorHandle>(null);
  /** Ya se está devolviendo el archivo (no volver a preguntar al cerrar). */
  const leavingRef = useRef(false);

  const sendReturn = useCallback(
    (focus: boolean) => {
      const payload: EdwReturn = { sessionId, path, focus };
      return emitTo(MAIN_WINDOW, EV_EDW_RETURN, payload).catch(() => {});
    },
    [sessionId, path],
  );

  /** «Volver a la pestaña principal»: el archivo reaparece como pestaña en su sesión y esta ventana se cierra. */
  const goBack = useCallback(async () => {
    if (leavingRef.current) return;
    if (dirtyRef.current) {
      if (connRef.current.status === "connected") {
        const ok = await confirmDialog({
          title: "Cambios sin guardar",
          message: `Para volver a la ventana principal hay que guardar «${name}» en el servidor (allí se abre de nuevo desde el servidor).`,
          confirmText: "Guardar y volver",
        });
        if (!ok) return;
        const saved = (await editorRef.current?.save()) ?? false;
        if (!saved) return;
      } else {
        const ok = await confirmDialog({
          title: "Cambios sin guardar",
          message: `Sin conexión no se puede guardar «${name}». ¿Volver a la ventana principal y descartar los cambios?`,
          confirmText: "Descartar y volver",
          danger: true,
        });
        if (!ok) return;
      }
    }
    leavingRef.current = true;
    await sendReturn(true);
    await getCurrentWindow()
      .destroy()
      .catch(() => {
        leavingRef.current = false;
      });
  }, [name, sendReturn]);

  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;

  // Eventos del motor y de la ventana principal.
  useEffect(() => {
    const label = currentLabel();
    const subs: Promise<UnlistenFn>[] = [
      listen<SessionClosed>(EV_SESSION_CLOSED, (e) => {
        if (e.payload.sessionId === sessionId) setConn({ status: "closed", reason: e.payload.reason });
      }),
      listen<SessionReconnecting>(EV_SESSION_RECONNECTING, (e) => {
        if (e.payload.sessionId === sessionId) setConn({ status: "reconnecting", reason: e.payload.reason });
      }),
      listen<SessionInfo>(EV_SESSION_RECONNECTED, (e) => {
        if (e.payload.id === sessionId) setConn({ status: "connected", reason: null });
      }),
      listen<EdwStatus>(EV_EDW_STATUS, (e) => setConn(e.payload)),
      listen<EdwSettings>(EV_EDW_SETTINGS, (e) => useSettings.setState({ settings: e.payload, loaded: true })),
      listen(EV_EDW_REQUEST_RETURN, () => {
        const w = getCurrentWindow();
        void w.unminimize().catch(() => {});
        void w.setFocus().catch(() => {});
        void goBackRef.current();
      }),
    ];
    let disposed = false;
    // Cuando ya escuchamos (y se leyeron los ajustes), se pide a la principal el estado de la conexión
    // y sus ajustes al día.
    void Promise.all([...subs, settingsReady])
      .then(() => {
        if (disposed) return;
        const hello: EdwHello = { label, sessionId, path };
        return emitTo(MAIN_WINDOW, EV_EDW_HELLO, hello);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      subs.forEach((p) => void p.then((un) => un()).catch(() => {}));
    };
  }, [sessionId, path]);

  // Cerrar la ventana: confirmar si hay cambios sin guardar; el archivo vuelve a la principal.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(async (ev) => {
        if (leavingRef.current) return;
        if (dirtyRef.current) {
          const ok = await confirmDialog({
            title: "Cambios sin guardar",
            message: `«${name}» tiene cambios sin guardar. ¿Cerrar la ventana y descartarlos?`,
            confirmText: "Descartar y cerrar",
            danger: true,
          });
          if (!ok) {
            ev.preventDefault();
            return;
          }
        }
        leavingRef.current = true;
        await sendReturn(false);
      })
      .then((fn) => {
        if (disposed) fn();
        else un = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      un?.();
    };
  }, [name, sendReturn]);

  // Título de la ventana (● delante si hay cambios sin guardar).
  useEffect(() => {
    const t = `${dirty ? "● " : ""}${editorWindowTitle(name, server)}`;
    document.title = t;
    getCurrentWindow()
      .setTitle(t)
      .catch(() => {});
  }, [dirty, name, server]);

  const onDirtyChange = useCallback(
    (d: boolean) => {
      dirtyRef.current = d;
      setDirty(d);
      const payload: EdwDirty = { sessionId, path, dirty: d };
      void emitTo(MAIN_WINDOW, EV_EDW_DIRTY, payload).catch(() => {});
    },
    [sessionId, path],
  );

  const openSettings = useCallback(() => {
    void emitTo(MAIN_WINDOW, EV_EDW_OPEN_SETTINGS, null).catch(() => {});
  }, []);

  const offline = conn.status !== "connected";

  return (
    <div className="edw-root">
      <div className="edw-bar">
        <FileCode2 size={15} className="edw-icon" />
        <span className="edw-name" title={path}>
          {name}
        </span>
        {server && <span className="edw-server">— {server}</span>}
        {dirty && <span className="edw-dirty" title="Sin guardar" />}
        <span className="edw-fill" />
        <button className="btn btn-sm" onClick={() => void goBack()} title="Cerrar esta ventana y abrir el archivo como pestaña en su conexión">
          <CornerUpLeft size={14} /> Volver a la pestaña principal
        </button>
      </div>
      {conn.status === "closed" && (
        <div className="edw-banner" role="alert">
          <Unplug size={15} />
          <span className="edw-banner-text">
            <strong>Conexión perdida</strong>
            {conn.reason ? `: ${conn.reason}` : ""}. No se puede guardar hasta que vuelva; tus cambios siguen aquí.
          </span>
        </div>
      )}
      {conn.status === "reconnecting" && (
        <div className="edw-banner edw-banner-warn" role="status">
          <RotateCw size={14} className="edw-spin" />
          <span className="edw-banner-text">
            <strong>Reconectando…</strong> No se puede guardar hasta que vuelva la conexión.
          </span>
        </div>
      )}
      <div className="edw-body">
        {loaded ? (
          <Suspense
            fallback={
              <div className="empty-state">
                <div className="spinner" />
                <span>Cargando editor…</span>
              </div>
            }
          >
            <RemoteEditor
              ref={editorRef}
              sessionId={sessionId}
              path={path}
              active
              offline={offline}
              onDirtyChange={onDirtyChange}
              onOpenSettings={openSettings}
            />
          </Suspense>
        ) : (
          <div className="empty-state">
            <div className="spinner" />
          </div>
        )}
      </div>
      <DialogHost />
      <Toaster />
    </div>
  );
}

/** Prepara la ventana (tema, ajustes, protecciones) y dibuja el editor. */
export function mountEditorWindow(root: Root, params: EditorWindowParams): void {
  settingsReady = useSettings.getState().load();
  initThemeSync();

  // Menú contextual del navegador: solo en texto y en el editor.
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input, textarea, [contenteditable='true'], .monaco-editor")) return;
    e.preventDefault();
  });
  // Recargar la ventana perdería los cambios sin guardar.
  window.addEventListener("keydown", (e) => {
    if (import.meta.env.DEV) return;
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) e.preventDefault();
  });

  // Bloqueo con PIN: la ventana también se tapa (initLock ya se llamó en main.tsx).
  root.render(
    <LockGate main={false}>
      <EditorWindow params={params} />
    </LockGate>,
  );
}
