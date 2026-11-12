// Barra de pestañas de conexión (una por sesión SSH).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { Copy, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, Server, Settings, Unplug, X, XCircle } from "lucide-react";
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
import "./TabBar.css";
import { shortcutLabel } from "../../lib/platform";

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

type Menu = { kind: "tab"; tabId: string; x: number; y: number } | { kind: "new"; x: number; y: number };

export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
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
    if (target >= 0 && els[target].dataset.tabId !== d.id) moveTab(d.id, target);
  };
  const endDrag = () => {
    drag.current = null;
    setDragId(null);
  };

  const profiles = useProfiles((s) => s.servers);
  const menuTab = menu?.kind === "tab" ? tabs.find((t) => t.id === menu.tabId) : undefined;

  const closeOthers = async (keep: SessionTab) => {
    for (const t of useTabs.getState().tabs) {
      if (t.id === keep.id) continue;
      const ok = await requestCloseTab(t.id);
      if (!ok) break;
    }
  };

  return (
    <div className="tabs-bar">
      <button
        className="icon-btn tabs-side-btn"
        onClick={toggleSidebar}
        title={`${sidebarCollapsed ? "Mostrar" : "Ocultar"} barra lateral (${shortcutLabel("B")})`}
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
                title={unsaved ? "Cerrar (hay archivos sin guardar)" : `Cerrar (${shortcutLabel("W")})`}
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
      </div>
      <McpButton />
      <LockButton />
      <button className="icon-btn tabs-side-btn" onClick={openSettings} title={`Ajustes (${shortcutLabel(",")})`} aria-label="Ajustes">
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
            disabled={tabs.length < 2}
            onClick={() => {
              closeMenu();
              void closeOthers(menuTab);
            }}
          >
            <XCircle size={14} /> Cerrar las demás
          </button>
        </PopupMenu>
      )}
    </div>
  );
}
