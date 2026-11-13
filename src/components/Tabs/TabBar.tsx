// Barra de pestañas: las de conexión (una por sesión SSH) y, detrás, las de terminal local («Este equipo»).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import {
  Bot,
  CircleHelp,
  Copy,
  Laptop,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCw,
  Server,
  Settings,
  SquareTerminal,
  Unplug,
  X,
  XCircle,
} from "lucide-react";
import { useTabs, type SessionTab } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useProfiles } from "../../stores/profiles";
import { connectToServer } from "../../features/connect";
import { cancelReconnect, moveTab, reconnectTab, requestCloseTab, tabCurrentPath, useEditorDirty } from "../Session/sessionState";
import { Logo } from "../ui/Logo";
import { PopupMenu } from "./PopupMenu";
import { PrivilegeBadge } from "./PrivilegeBadge";
import { LockButton } from "./LockButton";
import { McpButton } from "../../features/mcp/McpButton";
import { openManual } from "../Settings/settingsNav";
import { closeLocalTab, moveLocalTab, openLocalTab, useLocalTabs, type LocalTab } from "../../features/localterm/store";
import { LocalMenu } from "../../features/localterm/LocalMenu";
import { launchAssistant, openLocalTerminal } from "../../features/localterm/launch";
import "./TabBar.css";
import { useShortcutText, withShortcut } from "../../features/shortcuts/shortcuts";

const STATUS_LABEL: Record<SessionTab["status"], string> = {
  connected: "Conectado",
  reconnecting: "Reconectando",
  closed: "Desconectado",
};

function tabTooltip(t: SessionTab): string {
  if (t.status === "closed") return `${t.title} — conexión perdida${t.closedReason ? `: ${t.closedReason}` : ""}`;
  if (t.status === "reconnecting") {
    const r = t.reconnect;
    return `${t.title} — reconectando${r ? ` (intento ${r.attempt} de ${r.maxAttempts})` : ""}${r?.reason ? `: ${r.reason}` : ""}`;
  }
  return t.title;
}

type Menu =
  | { kind: "tab"; tabId: string; x: number; y: number }
  | { kind: "local"; tabId: string; x: number; y: number }
  | { kind: "new"; x: number; y: number }
  | { kind: "localMenu"; x: number; y: number };

function localTooltip(t: LocalTab): string {
  const what = t.kind === "shell" ? "Terminal de este equipo" : `${t.title} (en este equipo)`;
  return `${what}${t.cwd ? ` — ${t.cwd}` : ""}${t.status === "exited" ? " — terminado" : ""}`;
}

export function TabBar() {
  const sidebarKeys = useShortcutText("app.sidebar");
  const closeKeys = useShortcutText("tabs.close");
  const settingsKeys = useShortcutText("app.settings");
  const tabs = useTabs((s) => s.tabs);
  const localTabs = useLocalTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeTabId);
  const setActive = useTabs((s) => s.setActive);
  const dirty = useEditorDirty((s) => s.dirty);
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const openSettings = useUi((s) => s.openSettings);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; moved: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Mantener visible la pestaña activa.
  useEffect(() => {
    if (!activeId) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // ── Arrastrar para reordenar (con punteros: el arrastre HTML5 lo intercepta Tauri) ──
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0) return;
    setActive(id);
    drag.current = { id, x: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < 6) return;
      d.moved = true;
      setDragId(d.id);
    }
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []);
    const target = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right;
    });
    if (target < 0 || els[target].dataset.tabId === d.id) return;
    // Las de servidor y las locales se reordenan cada una en su grupo.
    const sshCount = useTabs.getState().tabs.length;
    const isLocal = useLocalTabs.getState().tabs.some((t) => t.id === d.id);
    if (isLocal && target >= sshCount) moveLocalTab(d.id, target - sshCount);
    else if (!isLocal && target < sshCount) moveTab(d.id, target);
  };
  const endDrag = () => {
    drag.current = null;
    setDragId(null);
  };

  const profiles = useProfiles((s) => s.servers);
  const menuTab = menu?.kind === "tab" ? tabs.find((t) => t.id === menu.tabId) : undefined;

  const localMenuTab = menu?.kind === "local" ? localTabs.find((t) => t.id === menu.tabId) : undefined;

  const closeOthers = async (keepId: string) => {
    for (const t of useTabs.getState().tabs) {
      if (t.id === keepId) continue;
      const ok = await requestCloseTab(t.id);
      if (!ok) return;
    }
    for (const t of useLocalTabs.getState().tabs) if (t.id !== keepId) closeLocalTab(t.id);
    useTabs.getState().setActive(keepId);
  };

  return (
    <div className="tabs-bar">
      <button
        className="icon-btn tabs-side-btn"
        onClick={toggleSidebar}
        title={withShortcut(`${sidebarCollapsed ? "Mostrar" : "Ocultar"} barra lateral`, sidebarKeys)}
        aria-label="Mostrar u ocultar barra lateral"
      >
        {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      {sidebarCollapsed && <Logo size={18} className="tabs-logo" />}
      <div className="tabs-list" ref={listRef} role="tablist" aria-label="Conexiones abiertas">
        {tabs.map((t) => {
          const active = t.id === activeId;
          const unsaved = (dirty[t.sessionId]?.length ?? 0) > 0;
          const cls = ["tabs-tab", active && "active", t.status !== "connected" && t.status, dragId === t.id && "dragging"]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cls}
              style={t.color ? ({ "--tab-color": t.color } as CSSProperties) : undefined}
              title={tabTooltip(t)}
              onPointerDown={(e) => onPointerDown(e, t.id)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void requestCloseTab(t.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: "tab", tabId: t.id, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  const i = tabs.findIndex((x) => x.id === t.id);
                  const n = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
                  setActive(n.id);
                  listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(n.id)}"]`)?.focus();
                } else if (e.key === "Delete") {
                  void requestCloseTab(t.id);
                }
              }}
            >
              {t.color && <span className="tabs-color" />}
              <span className={`tabs-status ${t.status}`} role="img" aria-label={STATUS_LABEL[t.status]} />
              <span className="tabs-title">{t.title}</span>
              <PrivilegeBadge sessionId={t.sessionId} />
              <button
                className={unsaved ? "tabs-close unsaved" : "tabs-close"}
                title={unsaved ? "Cerrar (hay archivos sin guardar)" : withShortcut("Cerrar", closeKeys)}
                aria-label={`Cerrar ${t.title}`}
                tabIndex={-1}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void requestCloseTab(t.id);
                }}
              >
                <span className="tabs-unsaved-dot" />
                <X size={13} />
              </button>
            </div>
          );
        })}
        {localTabs.map((t) => {
          const active = t.id === activeId;
          const cls = ["tabs-tab", "local", active && "active", t.status === "exited" && "exited", dragId === t.id && "dragging"]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cls}
              title={localTooltip(t)}
              onPointerDown={(e) => onPointerDown(e, t.id)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeLocalTab(t.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: "local", tabId: t.id, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === "Delete") closeLocalTab(t.id);
              }}
            >
              {t.kind === "shell" ? (
                <Laptop size={13} className="tabs-local-icon" aria-label="Este equipo" />
              ) : (
                <Bot size={13} className="tabs-local-icon" aria-label="Asistente de IA en este equipo" />
              )}
              <span className="tabs-title">{t.title}</span>
              <button
                className="tabs-close"
                title="Cerrar (termina lo que corre en ella)"
                aria-label={`Cerrar ${t.title}`}
                tabIndex={-1}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeLocalTab(t.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
        <button
          className="icon-btn tabs-new"
          title="Nueva conexión"
          aria-label="Nueva conexión"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu?.kind === "new" ? null : { kind: "new", x: r.left, y: r.bottom + 4 });
          }}
        >
          <Plus size={16} />
        </button>
        <button
          className="icon-btn tabs-local-btn"
          title="Este equipo: terminal local, Claude Code y Codex"
          aria-label="Terminal local"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu?.kind === "localMenu" ? null : { kind: "localMenu", x: r.left, y: r.bottom + 4 });
          }}
        >
          <Laptop size={15} />
        </button>
      </div>
      <McpButton />
      <LockButton />
      <button className="icon-btn tabs-side-btn" onClick={openManual} title="Manual de uso" aria-label="Manual de uso">
        <CircleHelp size={16} />
      </button>
      <button className="icon-btn tabs-side-btn" onClick={openSettings} title={withShortcut("Ajustes", settingsKeys)} aria-label="Ajustes">
        <Settings size={16} />
      </button>

      {menu?.kind === "new" && (
        <PopupMenu x={menu.x} y={menu.y} onClose={closeMenu} minWidth={230}>
          {profiles.length > 0 && <div className="tabs-menu-label">Conectar a</div>}
          <div className="tabs-menu-scroll">
            {profiles.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  void connectToServer(p, { initialPath: p.defaultPath });
                }}
              >
                <span className="tabs-menu-dot" style={p.color ? { background: p.color } : undefined} />
                <span className="tabs-menu-name">{p.name}</span>
                <span className="tabs-menu-host">
                  {p.username}@{p.host}
                </span>
              </button>
            ))}
          </div>
          {profiles.length > 0 && <hr />}
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              useUi.getState().openServerEditor();
            }}
          >
            <Server size={14} /> Nuevo servidor…
          </button>
          <hr />
          <div className="tabs-menu-label">Este equipo</div>
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              openLocalTerminal();
            }}
          >
            <SquareTerminal size={14} /> Terminal local
          </button>
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              void launchAssistant("claude");
            }}
          >
            <Bot size={14} /> Claude Code
          </button>
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              void launchAssistant("codex");
            }}
          >
            <Bot size={14} /> Codex
          </button>
        </PopupMenu>
      )}

      {menu?.kind === "localMenu" && <LocalMenu x={menu.x} y={menu.y} onClose={closeMenu} />}

      {menu?.kind === "local" && localMenuTab && (
        <PopupMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              openLocalTab({ kind: "shell", cwd: localMenuTab.cwd });
            }}
          >
            <SquareTerminal size={14} /> Otra terminal en esta carpeta
          </button>
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              closeLocalTab(localMenuTab.id);
            }}
          >
            <X size={14} /> Cerrar
          </button>
          <button
            role="menuitem"
            disabled={tabs.length + localTabs.length < 2}
            onClick={() => {
              closeMenu();
              void closeOthers(localMenuTab.id);
            }}
          >
            <XCircle size={14} /> Cerrar las demás
          </button>
        </PopupMenu>
      )}

      {menu?.kind === "tab" && menuTab && (
        <PopupMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          {menuTab.status === "closed" && (
            <button
              role="menuitem"
              onClick={() => {
                closeMenu();
                void reconnectTab(menuTab.id);
              }}
            >
              <RotateCw size={14} /> Reconectar
            </button>
          )}
          {menuTab.status === "reconnecting" && (
            <button
              role="menuitem"
              onClick={() => {
                closeMenu();
                void cancelReconnect(menuTab.id);
              }}
            >
              <Unplug size={14} /> Dejar de reconectar
            </button>
          )}
          <button
            role="menuitem"
            disabled={!profiles.some((p) => p.id === menuTab.profileId)}
            onClick={() => {
              closeMenu();
              const p = useProfiles.getState().servers.find((s) => s.id === menuTab.profileId);
              if (p) void connectToServer(p, { initialPath: tabCurrentPath(menuTab) });
            }}
          >
            <Copy size={14} /> Duplicar conexión
          </button>
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              void requestCloseTab(menuTab.id);
            }}
          >
            <X size={14} /> Cerrar
          </button>
          <button
            role="menuitem"
            disabled={tabs.length + localTabs.length < 2}
            onClick={() => {
              closeMenu();
              void closeOthers(menuTab.id);
            }}
          >
            <XCircle size={14} /> Cerrar las demás
          </button>
        </PopupMenu>
      )}
    </div>
  );
}
