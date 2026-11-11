// Contenido de una pestaña de conexión: área de trabajo (Archivos + editores) arriba y terminales abajo.
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { Group, Panel, Separator, usePanelRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import { FileCode2, FolderOpen, PanelBottomClose, PanelBottomOpen, RotateCw, SquareTerminal, Unplug, X } from "lucide-react";
import type { SessionReconnecting } from "../../api/types";
import type { SessionTab } from "../../stores/tabs";
import { useSettings } from "../../stores/settings";
import { FileExplorer } from "../FileExplorer/FileExplorer";
import { TerminalArea } from "../Terminal/TerminalArea";
import { confirmDialog } from "../ui/dialogs";
import { basename } from "../../lib/paths";
import { preloadable } from "../../lib/lazy";
import { cancelReconnect, reconnectTab, requestCloseTab, setSessionPath, useEditorDirty } from "./sessionState";
import "./SessionView.css";

const RemoteEditor = lazy(() => import("../Editor/RemoteEditor"));
/** Biblioteca de comandos (catálogo grande): se carga la primera vez que se abre la pestaña «Comandos». */
export const CommandsPanel = preloadable(() => import("../Commands/CommandsPanel").then((m) => m.CommandsPanel));

export interface SessionViewProps {
  tab: SessionTab;
  active: boolean;
}

const EMPTY: string[] = [];

/** Pestañas fijas del área de trabajo (las demás son rutas de archivos abiertos). */
const FILES_TAB = "files";
const COMMANDS_TAB = "commands";
type FixedTab = typeof FILES_TAB | typeof COMMANDS_TAB;
type WorkTab = { kind: "fixed"; id: FixedTab } | { kind: "file"; path: string };

/** Segundos que faltan para el próximo intento (cuenta atrás en vivo). */
/** Solo corre mientras la pestaña se ve (las ocultas no gastan un temporizador). */
function useCountdown(info: SessionReconnecting | null, visible: boolean): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const [deadline, setDeadline] = useState<{ info: SessionReconnecting; at: number } | null>(null);
  // El plazo se fija al llegar el aviso, aunque la pestaña esté oculta.
  if (info && deadline?.info !== info) setDeadline({ info, at: Date.now() + info.nextRetrySecs * 1000 });
  else if (!info && deadline) setDeadline(null);
  useEffect(() => {
    if (!deadline) {
      setLeft(null);
      return;
    }
    if (!visible) return;
    const at = deadline.at;
    // setLeft con el mismo número no vuelve a dibujar: basta con mirar 4 veces por segundo.
    const tick = () => setLeft(Math.max(0, Math.ceil((at - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadline, visible]);
  return left;
}

function ReconnectingBanner({ tab, visible }: { tab: SessionTab; visible: boolean }) {
  const r = tab.reconnect;
  const left = useCountdown(r, visible);
  return (
    <div className="sv-banner sv-banner-warn" role="status" aria-live="polite">
      <span className="spinner sv-banner-spinner" />
      <span className="sv-banner-text">
        <strong>Reconectando…</strong>
        {r && (
          <>
            {" "}
            intento {r.attempt} de {r.maxAttempts}
            {" · "}
            {left === null || left > 0 ? `próximo en ${left ?? r.nextRetrySecs} s` : "intentando ahora"}
          </>
        )}
        {r?.reason && <span className="sv-banner-reason"> — {r.reason}</span>}
      </span>
      <button className="btn btn-sm" onClick={() => void cancelReconnect(tab.id)} title="Dejar de reintentar">
        Cancelar
      </button>
    </div>
  );
}

function initialLayout(saved: number[] | undefined): Layout {
  if (saved && saved.length === 2 && saved.every((n) => Number.isFinite(n) && n > 5)) {
    return { work: saved[0], terminal: saved[1] };
  }
  return { work: 58, terminal: 42 };
}

export const SessionView = memo(function SessionView({ tab, active }: SessionViewProps) {
  const [files, setFiles] = useState<string[]>([]);
  /** Pestaña visible del área de trabajo: "Archivos", "Comandos" o un archivo abierto. */
  const [view, setView] = useState<WorkTab>({ kind: "fixed", id: FILES_TAB });
  const current = view.kind === "file" ? view.path : null;
  const setCurrent = useCallback((path: string | null) => {
    setView(path === null ? { kind: "fixed", id: FILES_TAB } : { kind: "file", path });
  }, []);
  const showFiles = view.kind === "fixed" && view.id === FILES_TAB;
  const showCommands = view.kind === "fixed" && view.id === COMMANDS_TAB;
  /** El panel de Comandos se monta la primera vez que se abre y luego se conserva. */
  const [commandsMounted, setCommandsMounted] = useState(false);
  if (showCommands && !commandsMounted) setCommandsMounted(true);
  const [termCollapsed, setTermCollapsed] = useState(false);
  const termPanel = usePanelRef();
  const dirtyPaths = useEditorDirty((s) => s.dirty[tab.sessionId] ?? EMPTY);
  const setDirty = useEditorDirty((s) => s.setDirty);
  const setLayout = useSettings((s) => s.setLayout);
  const [defaultLayout] = useState(() => initialLayout(useSettings.getState().settings.layout.session));

  const closed = tab.status === "closed";
  const connected = tab.status === "connected";
  const sessionId = tab.sessionId;
  const onPathChange = useCallback((path: string) => setSessionPath(sessionId, path), [sessionId]);

  const openFile = useCallback(
    (path: string) => {
      setFiles((f) => (f.includes(path) ? f : [...f, path]));
      setCurrent(path);
    },
    [setCurrent],
  );

  const closeFile = useCallback(
    async (path: string) => {
      if (useEditorDirty.getState().dirty[tab.sessionId]?.includes(path)) {
        const ok = await confirmDialog({
          title: "Cambios sin guardar",
          message: `«${basename(path)}» tiene cambios sin guardar. ¿Cerrarlo y descartarlos?`,
          confirmText: "Descartar",
          danger: true,
        });
        if (!ok) return;
      }
      setDirty(tab.sessionId, path, false);
      const idx = files.indexOf(path);
      const next = files.filter((p) => p !== path);
      setFiles(next);
      // Al cerrar la activa, pasar a la de la izquierda (o a "Archivos").
      if (current === path) setCurrent(idx > 0 ? next[idx - 1] : (next[0] ?? null));
    },
    [tab.sessionId, setDirty, files, current, setCurrent],
  );

  const toggleTerminal = useCallback(() => {
    const p = termPanel.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, [termPanel]);

  // Ctrl+` muestra/oculta la terminal de la pestaña activa.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.key === "`")) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, toggleTerminal]);

  const onLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const l = meta.requestedLayout ?? layout;
      if ((l.terminal ?? 0) < 5) return; // no guardar el estado plegado
      setLayout("session", [l.work, l.terminal]);
    },
    [setLayout],
  );

  const onMiddle = (e: MouseEvent, path: string) => {
    if (e.button === 1) {
      e.preventDefault();
      void closeFile(path);
    }
  };

  const dirtySet = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);

  return (
    <div className={active ? "sv-root" : "sv-root sv-hidden"} aria-hidden={!active}>
      {tab.status === "reconnecting" && <ReconnectingBanner tab={tab} visible={active} />}
      {closed && (
        <div className="sv-banner" role="alert">
          <Unplug size={15} />
          <span className="sv-banner-text">
            <strong>Conexión perdida</strong>
            {tab.closedReason ? `: ${tab.closedReason}` : ""}
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => void reconnectTab(tab.id)}>
            <RotateCw size={13} /> Reconectar
          </button>
          <button className="btn btn-sm" onClick={() => void requestCloseTab(tab.id)}>
            Cerrar
          </button>
        </div>
      )}
      <Group orientation="vertical" className="sv-group" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <Panel id="work" minSize="120px" className="sv-work" style={{ overflow: "hidden" }}>
          <div className="sv-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={showFiles}
              className={showFiles ? "sv-tab sv-tab-fixed active" : "sv-tab sv-tab-fixed"}
              onClick={() => setCurrent(null)}
            >
              <FolderOpen size={14} />
              <span>Archivos</span>
            </button>
            <button
              role="tab"
              aria-selected={showCommands}
              className={showCommands ? "sv-tab sv-tab-fixed active" : "sv-tab sv-tab-fixed"}
              onClick={() => setView({ kind: "fixed", id: COMMANDS_TAB })}
              title="Biblioteca de comandos (Ctrl+Shift+P para la paleta)"
            >
              <SquareTerminal size={14} />
              <span>Comandos</span>
            </button>
            {files.length > 0 && <span className="sv-tabs-sep" aria-hidden />}
            {files.map((p) => {
              const isDirty = dirtySet.has(p);
              return (
                <div
                  key={p}
                  role="tab"
                  aria-selected={current === p}
                  tabIndex={0}
                  className={current === p ? "sv-tab active" : "sv-tab"}
                  title={p}
                  onClick={() => setCurrent(p)}
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                  onAuxClick={(e) => onMiddle(e, p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setCurrent(p);
                  }}
                >
                  <FileCode2 size={14} className="sv-tab-icon" />
                  <span className="sv-tab-title">{basename(p)}</span>
                  <button
                    className={isDirty ? "sv-tab-close dirty" : "sv-tab-close"}
                    title={isDirty ? "Sin guardar — cerrar" : "Cerrar"}
                    aria-label="Cerrar archivo"
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeFile(p);
                    }}
                  >
                    <span className="sv-dirty-dot" />
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            <div className="sv-tabs-fill" />
            <button
              className={termCollapsed ? "icon-btn sv-term-toggle" : "icon-btn sv-term-toggle on"}
              onClick={toggleTerminal}
              title={termCollapsed ? "Mostrar terminal (Ctrl+`)" : "Ocultar terminal (Ctrl+`)"}
              aria-label="Mostrar u ocultar terminal"
            >
              {termCollapsed ? <PanelBottomOpen size={15} /> : <PanelBottomClose size={15} />}
            </button>
          </div>
          <div className="sv-work-body">
            <div className={showFiles ? "sv-pane" : "sv-pane sv-hidden"}>
              <FileExplorer
                sessionId={tab.sessionId}
                initialPath={tab.initialPath}
                active={active && showFiles && connected}
                onOpenFile={openFile}
                onPathChange={onPathChange}
              />
            </div>
            {commandsMounted && (
              <div className={showCommands ? "sv-pane" : "sv-pane sv-hidden"}>
                <Suspense
                  fallback={
                    <div className="empty-state">
                      <div className="spinner" />
                    </div>
                  }
                >
                  <CommandsPanel
                    sessionId={tab.sessionId}
                    profileId={tab.profileId}
                    active={active && showCommands}
                    disabled={!connected}
                  />
                </Suspense>
              </div>
            )}
            {files.map((p) => (
              <div key={p} className={current === p ? "sv-pane" : "sv-pane sv-hidden"}>
                <Suspense
                  fallback={
                    <div className="empty-state">
                      <div className="spinner" />
                      <span>Cargando editor…</span>
                    </div>
                  }
                >
                  <RemoteEditor
                    sessionId={tab.sessionId}
                    path={p}
                    active={active && current === p}
                    onDirtyChange={(d) => setDirty(tab.sessionId, p, d)}
                  />
                </Suspense>
              </div>
            ))}
          </div>
        </Panel>
        <Separator className="app-sep app-sep-h">
          <span className="app-sep-grip" />
        </Separator>
        <Panel
          id="terminal"
          panelRef={termPanel}
          collapsible
          collapsedSize={0}
          minSize="90px"
          className="sv-terminal"
          style={{ overflow: "hidden" }}
          onResize={() => setTermCollapsed(termPanel.current?.isCollapsed() ?? false)}
        >
          <TerminalArea sessionId={tab.sessionId} active={active && !termCollapsed} disabled={closed} />
        </Panel>
      </Group>
    </div>
  );
});
