// Estructura principal: barra lateral | (pestañas + sesión activa + transferencias).
import { useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator, usePanelRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DialogHost } from "./components/ui/dialogs";
import { Toaster } from "./components/ui/Toaster";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TransferPanel } from "./components/TransferPanel/TransferPanel";
import { ConnectDialogHost } from "./features/ConnectDialogs";
import { SettingsDialog } from "./components/Settings/SettingsDialog";
import { CommandPalette } from "./components/Commands/CommandPalette";
import { initThemeSync } from "./components/Settings/theme";
import { SessionView } from "./components/Session/SessionView";
import { requestCloseTab } from "./components/Session/sessionState";
import { TabBar } from "./components/Tabs/TabBar";
import { Welcome, recordRecentServer } from "./components/Welcome/Welcome";
import { useSettings } from "./stores/settings";
import { useProfiles } from "./stores/profiles";
import { initTabsListeners, useTabs } from "./stores/tabs";
import { initTransfersStore } from "./stores/transfers";
import { useUi } from "./stores/ui";
import "./App.css";

let initialized = false;

/** Inicialización global (una sola vez). */
function initApp() {
  if (initialized) return;
  initialized = true;
  initThemeSync();
  void useSettings.getState().load();
  void useProfiles.getState().load();
  void initTabsListeners();
  void initTransfersStore();

  // Recordar servidores usados (para la pantalla de bienvenida).
  useTabs.subscribe((s, prev) => {
    if (s.tabs.length <= prev.tabs.length) return;
    const old = new Set(prev.tabs.map((t) => t.id));
    for (const t of s.tabs) if (!old.has(t.id)) recordRecentServer(t.profileId);
  });

  // Menú contextual del navegador: solo donde tiene sentido (texto, terminal, editor).
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input, textarea, [contenteditable='true'], .xterm, .monaco-editor")) return;
    e.preventDefault();
  });

  // Evitar recargar la ventana por accidente (perdería las pestañas abiertas).
  window.addEventListener("keydown", (e) => {
    if (import.meta.env.DEV) return;
    const k = e.key.toLowerCase();
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && k === "r" && !(e.target as HTMLElement | null)?.closest?.(".xterm"))) {
      e.preventDefault();
    }
  });
}

function isInTerminal(e: KeyboardEvent) {
  return !!(e.target as HTMLElement | null)?.closest?.(".xterm");
}

/** Atajos globales de la ventana. */
function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (document.querySelector(".modal-backdrop")) return; // hay un diálogo abierto
      const tabsState = useTabs.getState();
      const { tabs, activeTabId } = tabsState;
      const key = e.key;

      // Ctrl+Tab / Ctrl+Shift+Tab y Ctrl+RePág / Ctrl+AvPág: cambiar de pestaña.
      if (key === "Tab" || key === "PageDown" || key === "PageUp") {
        e.preventDefault();
        e.stopPropagation();
        if (tabs.length < 2) return;
        const back = key === "PageUp" || (key === "Tab" && e.shiftKey);
        const i = Math.max(0, tabs.findIndex((t) => t.id === activeTabId));
        tabsState.setActive(tabs[(i + (back ? -1 : 1) + tabs.length) % tabs.length].id);
        return;
      }
      if (e.shiftKey) return;
      const k = key.toLowerCase();
      // Ctrl+, : ajustes
      if (key === "," || e.code === "Comma") {
        e.preventDefault();
        e.stopPropagation();
        useUi.getState().openSettings();
        return;
      }
      // En la terminal, Ctrl+W y Ctrl+B pertenecen a la shell (borrar palabra, tmux…).
      if (k === "w" && !isInTerminal(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (activeTabId) void requestCloseTab(activeTabId);
        return;
      }
      if (k === "b" && !isInTerminal(e)) {
        e.preventDefault();
        e.stopPropagation();
        useUi.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Título de la ventana: "TerView — <pestaña>". */
function useWindowTitle() {
  const title = useTabs((s) => s.tabs.find((t) => t.id === s.activeTabId)?.title ?? null);
  useEffect(() => {
    const t = title ? `TerView — ${title}` : "TerView";
    document.title = t;
    getCurrentWindow()
      .setTitle(t)
      .catch(() => {
        /* sin permiso para cambiar el título: se ignora */
      });
  }, [title]);
}

function mainLayout(saved: number[] | undefined): Layout {
  if (saved && saved.length === 2 && saved.every((n) => Number.isFinite(n)) && saved[0] >= 8 && saved[0] <= 50) {
    return { sidebar: saved[0], main: saved[1] };
  }
  return { sidebar: 18, main: 82 };
}

function Shell() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeTabId);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const setLayout = useSettings((s) => s.setLayout);
  const sidebarRef = usePanelRef();
  const [defaultLayout] = useState(() => mainLayout(useSettings.getState().settings.layout.main));

  // Estado del store → panel (Ctrl+B, botón).
  useEffect(() => {
    const p = sidebarRef.current;
    if (!p || p.isCollapsed() === collapsed) return;
    if (collapsed) p.collapse();
    else p.expand();
  }, [collapsed, sidebarRef]);

  // Panel → store (si el usuario lo pliega arrastrando).
  const onSidebarResize = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    const isCollapsed = p.isCollapsed();
    if (isCollapsed !== useUi.getState().sidebarCollapsed) useUi.getState().toggleSidebar();
  }, [sidebarRef]);

  const onLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const l = meta.requestedLayout ?? layout;
      if ((l.sidebar ?? 0) < 5) return; // plegada: conservar el último ancho útil
      setLayout("main", [l.sidebar, l.main]);
    },
    [setLayout],
  );

  return (
    <div className="app">
      <Group orientation="horizontal" className="app-group" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <Panel
          id="sidebar"
          panelRef={sidebarRef}
          minSize="180px"
          maxSize="45%"
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          onResize={onSidebarResize}
          className="app-sidebar"
          style={{ overflow: "hidden" }}
        >
          <Sidebar />
        </Panel>
        <Separator className="app-sep app-sep-v">
          <span className="app-sep-grip" />
        </Separator>
        <Panel id="main" minSize="40%" className="app-main" style={{ overflow: "hidden" }}>
          <TabBar />
          <div className="app-content">
            {tabs.map((t) => (
              <SessionView key={t.id} tab={t} active={t.id === activeId} />
            ))}
            {tabs.length === 0 && <Welcome />}
          </div>
          <TransferPanel />
        </Panel>
      </Group>
    </div>
  );
}

export default function App() {
  const loaded = useSettings((s) => s.loaded);
  initApp();
  useGlobalShortcuts();
  useWindowTitle();

  return (
    <>
      {loaded ? (
        <Shell />
      ) : (
        <div className="app-boot">
          <div className="spinner" />
        </div>
      )}
      <DialogHost />
      <Toaster />
      <ConnectDialogHost />
      <SettingsDialog />
      <CommandPalette />
    </>
  );
}
