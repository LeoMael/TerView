// Zona de terminales de una pestaña de conexión: sub-pestañas + una xterm por shell.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Copy, InfinityIcon, LayersIcon, Plus, RefreshCw, SquareTerminal, Unlink, Unplug, X } from "lucide-react";
import { TerminalView } from "./TerminalView";
import { TmuxSessionsDialog } from "./TmuxSessionsDialog";
import type { ConnState, TermController, TermStatus, TmuxState } from "./termController";
import { useTabs } from "../../stores/tabs";
import { registerTerminalWriter } from "../../stores/terminalBus";
import { toast } from "../../stores/toasts";
import { terminal } from "../../api/terminal";
import { clipboard } from "../../lib/clipboard";
import { sendToAi } from "../../features/localterm/launch";
import { ContextMenu, type MenuItem } from "../FileExplorer/ContextMenu";
import {
  allOpenTmuxNames,
  detachedLeftovers,
  getTmuxMode,
  isSshorusName,
  killTmuxSessions,
  manualAttachCommand,
  newTmuxName,
  setOpenTmux,
  useTmuxMode,
  warnTmuxMissing,
} from "../../features/tmux";
import "./Terminal.css";

export interface TerminalAreaProps {
  sessionId: string;
  /** Pestaña visible: solo entonces se ajusta el tamaño y toma el foco. */
  active: boolean;
  /** true si la conexión se cerró: no abrir terminales nuevas. */
  disabled: boolean;
}

interface SubTab {
  key: number;
  num: number;
  status: TermStatus;
  /** Sesión tmux propia (null = shell normal). Estable: la reconexión vuelve a ella. */
  tmux: string | null;
  /** Volcar su historial al abrir (se reabre una sesión que ya existía). */
  replay: boolean;
  /** La shell corre de verdad dentro de tmux (el servidor lo tiene). */
  persistent: boolean;
}

let keySeq = 0;
const newTab = (num: number, tmux: string | null, replay = false): SubTab => ({
  key: ++keySeq,
  num,
  status: "opening",
  tmux,
  replay,
  persistent: false,
});

/** Terminales iniciales: las que hay que reabrir (botón «Reconectar») o una nueva. */
function initialTabs(sessionId: string, disabled: boolean): SubTab[] {
  if (disabled) return [];
  const tab = useTabs.getState().tabs.find((t) => t.sessionId === sessionId);
  const mode = getTmuxMode(tab?.profileId ?? null);
  const restore = mode === "never" ? [] : (tab?.restoreTerminals ?? []).filter(isSshorusName);
  if (restore.length > 0) return restore.map((name, i) => newTab(i + 1, name, true));
  return [newTab(1, mode === "never" ? null : newTmuxName())];
}

interface TabMenuState {
  x: number;
  y: number;
  key: number;
}

export const TerminalArea = memo(function TerminalArea({ sessionId, active, disabled }: TerminalAreaProps) {
  const [tabs, setTabs] = useState<SubTab[]>(() => initialTabs(sessionId, disabled));
  const [activeKey, setActiveKey] = useState<number | null>(() => tabs[0]?.key ?? null);
  const ctrls = useRef(new Map<number, TermController>());
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  /** Sesiones tmux sueltas en el servidor (nadie las mira y no están abiertas aquí). */
  const [leftovers, setLeftovers] = useState(0);

  const profileId = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.profileId ?? null);
  const serverName = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.title ?? "");
  const tmuxMode = useTmuxMode(profileId);

  // Estado de la conexión de esta pestaña.
  const tabStatus = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.status ?? "connected");
  const attempt = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.reconnect ?? null);
  const reconnectCount = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.reconnectCount ?? 0);
  const connState: ConnState = disabled ? "closed" : tabStatus;
  const reconnecting = connState === "reconnecting";
  const blocked = connState !== "connected";

  // La terminal activa de la sesión recibe el texto de la Biblioteca de comandos
  // (mismo camino ordenado que el teclado).
  useEffect(() => {
    if (activeKey === null || disabled) return;
    return registerTerminalWriter(sessionId, (text) => ctrls.current.get(activeKey)?.sendText(text));
  }, [sessionId, activeKey, disabled]);

  /** Nueva terminal. `tmuxName`: reabrir esa sesión tmux (de «Sesiones en el servidor»). */
  const addTab = useCallback(
    (tmuxName?: string) => {
      if (blocked) return;
      const used = new Set(tabs.map((p) => p.num));
      let num = 1;
      while (used.has(num)) num++;
      const name = tmuxName ?? (tmuxMode === "never" ? null : newTmuxName());
      const t = newTab(num, name, tmuxName !== undefined);
      setTabs((prev) => [...prev, t]);
      setActiveKey(t.key);
    },
    [blocked, tabs, tmuxMode],
  );

  /**
   * Cierra una sub-pestaña. Cerrarla a propósito termina su sesión tmux (como una shell normal);
   * con `detach` la sesión sigue en el servidor y aparece en «Sesiones en el servidor».
   * Sin conexión no se puede terminar: queda en el servidor.
   */
  const closeTab = useCallback(
    (key: number, detach = false) => {
      const idx = tabs.findIndex((t) => t.key === key);
      const t = tabs[idx];
      if (t?.tmux && t.persistent && !detach && connState === "connected") {
        void killTmuxSessions(sessionId, [t.tmux]);
      }
      const rest = tabs.filter((t) => t.key !== key);
      setTabs((prev) => prev.filter((t) => t.key !== key));
      if (key === activeKey) setActiveKey(rest[Math.max(0, idx - 1)]?.key ?? null);
    },
    [tabs, activeKey, connState, sessionId],
  );

  // Registro de las sesiones tmux abiertas (para cerrar la pestaña, «Reconectar» y la lista).
  useEffect(() => {
    for (const t of tabs) if (t.persistent && t.tmux) setOpenTmux(sessionId, t.key, t.tmux);
    return () => {
      for (const t of tabs) setOpenTmux(sessionId, t.key, null);
    };
  }, [tabs, sessionId]);

  const modeRef = useRef(tmuxMode);
  const nameRef = useRef(serverName);
  useEffect(() => {
    modeRef.current = tmuxMode;
    nameRef.current = serverName;
  });

  /** «Enviar a la IA»: la selección va a la pestaña del asistente (o abre uno). */
  const onSendToAi = useCallback((text: string) => void sendToAi(text, nameRef.current || null), []);

  const onTmux = useCallback(
    (key: number, st: TmuxState) => {
      setTabs((prev) => prev.map((t) => (t.key === key && t.persistent !== st.persistent ? { ...t, persistent: st.persistent } : t)));
      // En «Automático» no se avisa nunca; en «Siempre», una vez por servidor.
      if (st.persistent || modeRef.current !== "always" || !profileId) return;
      if (st.missing) void warnTmuxMissing(sessionId, profileId, nameRef.current);
      else if (st.problem) toast.error("No se pudo usar tmux: la terminal no es persistente", st.problem);
    },
    [sessionId, profileId],
  );

  // ¿Quedaron sesiones tmux sueltas en el servidor (p. ej. tras cerrar la app)? Se muestra un contador.
  const checkLeftovers = useCallback(async () => {
    try {
      const l = await terminal.tmuxList(sessionId);
      setLeftovers(detachedLeftovers(l.sessions, allOpenTmuxNames()).length);
    } catch {
      /* sin respuesta: no se muestra nada */
    }
  }, [sessionId]);

  useEffect(() => {
    if (connState !== "connected" || tmuxMode === "never") return;
    // Se espera a que las terminales abran (o se reenganchen) para no contarlas como sueltas.
    const t = setTimeout(() => void checkLeftovers(), 2500);
    return () => clearTimeout(t);
  }, [connState, reconnectCount, tmuxMode, checkLeftovers]);

  const setStatus = useCallback((key: number, status: TermStatus) => {
    setTabs((prev) => prev.map((t) => (t.key === key && t.status !== status ? { ...t, status } : t)));
  }, []);

  const onTabKey = (e: React.KeyboardEvent, key: number) => {
    const idx = tabs.findIndex((t) => t.key === key);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActiveKey(key);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = tabs[(idx + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      if (n) {
        setActiveKey(n.key);
        (e.currentTarget.parentElement?.children[tabs.indexOf(n)] as HTMLElement | undefined)?.focus();
      }
    } else if (e.key === "Delete") {
      e.preventDefault();
      closeTab(key);
    }
  };

  return (
    <div className="term-area">
      <div className="term-bar">
        <div className="term-tabs" role="tablist" aria-label="Terminales">
          {tabs.map((t) => (
            <div
              key={t.key}
              role="tab"
              tabIndex={t.key === activeKey ? 0 : -1}
              aria-selected={t.key === activeKey}
              className={`term-tab${t.key === activeKey ? " active" : ""}${t.status === "exited" ? " exited" : ""}`}
              title={t.status === "exited" ? "Shell terminada" : undefined}
              onClick={() => setActiveKey(t.key)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.key);
                }
              }}
              onKeyDown={(e) => onTabKey(e, t.key)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, key: t.key });
              }}
            >
              <SquareTerminal size={13} className="term-tab-icon" />
              <span className="term-tab-label">Terminal {t.num}</span>
              {t.persistent && (
                <span
                  className="term-tab-persist"
                  title={`Terminal persistente (tmux «${t.tmux}»): sigue viva en el servidor si se corta la conexión`}
                  aria-label="Persistente"
                >
                  <InfinityIcon size={12} />
                </span>
              )}
              <button
                type="button"
                className="term-tab-close"
                tabIndex={-1}
                aria-label={`Cerrar Terminal ${t.num}`}
                title={t.persistent ? "Cerrar terminal (termina su sesión tmux)" : "Cerrar terminal"}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.key);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn term-add"
          onClick={() => addTab()}
          disabled={blocked}
          title={disabled ? "Conexión cerrada" : reconnecting ? "Reconectando…" : "Nueva terminal"}
          aria-label="Nueva terminal"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          className="icon-btn term-add term-sessions-btn"
          onClick={() => setShowSessions(true)}
          disabled={blocked}
          title={
            leftovers > 0
              ? `${leftovers === 1 ? "Hay 1 terminal persistente suelta" : `Hay ${leftovers} terminales persistentes sueltas`} en el servidor: reábrelas o ciérralas`
              : "Terminales persistentes en el servidor (tmux)"
          }
          aria-label="Terminales persistentes en el servidor"
        >
          <LayersIcon size={14} />
          {leftovers > 0 && !blocked && <span className="term-sessions-badge">{leftovers}</span>}
        </button>
      </div>

      <div className="term-body">
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            sessionId={sessionId}
            onSendToAi={onSendToAi}
            visible={active && t.key === activeKey}
            disabled={disabled}
            connState={connState}
            reconnectCount={reconnectCount}
            tmuxName={t.tmux}
            tmuxReplay={t.replay}
            onTmux={(st) => onTmux(t.key, st)}
            onStatus={(s) => setStatus(t.key, s)}
            onController={(c) => {
              if (c) ctrls.current.set(t.key, c);
              else ctrls.current.delete(t.key);
            }}
          />
        ))}
        {tabs.length === 0 && (
          <div className="empty-state term-empty">
            <SquareTerminal size={22} />
            <span>
              {disabled ? "Conexión cerrada" : reconnecting ? "Reconectando…" : "No hay terminales abiertas"}
            </span>
            {!blocked && (
              <button type="button" className="btn btn-sm" onClick={() => addTab()}>
                <Plus size={14} /> Nueva terminal
              </button>
            )}
          </div>
        )}
        {disabled && tabs.length > 0 && (
          <div className="term-overlay" role="status">
            <Unplug size={14} /> Conexión cerrada
          </div>
        )}
        {reconnecting && tabs.length > 0 && (
          <div
            className="term-overlay reconnecting"
            role="status"
            title={attempt?.reason ?? undefined}
          >
            <RefreshCw size={13} className="term-overlay-spin" />
            Reconectando…
            {attempt && ` (intento ${attempt.attempt}/${attempt.maxAttempts})`}
          </div>
        )}
      </div>
      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.key)} onClose={() => setTabMenu(null)} />
      )}
      {showSessions && (
        <TmuxSessionsDialog
          sessionId={sessionId}
          onOpen={(name) => addTab(name)}
          onClose={() => {
            setShowSessions(false);
            void checkLeftovers();
          }}
        />
      )}
    </div>
  );

  function tabMenuItems(key: number): MenuItem[] {
    const t = tabs.find((x) => x.key === key);
    if (!t) return [];
    const items: MenuItem[] = [
      { label: "Nueva terminal", icon: <Plus size={14} />, disabled: blocked, onSelect: () => addTab() },
      {
        label: "Terminales persistentes en el servidor…",
        icon: <LayersIcon size={14} />,
        disabled: blocked,
        onSelect: () => setShowSessions(true),
      },
      { sep: true },
    ];
    if (t.persistent && t.tmux) {
      const name = t.tmux;
      items.push(
        {
          label: "Desacoplar (sigue corriendo en el servidor)",
          icon: <Unlink size={14} />,
          onSelect: () => closeTab(key, true),
        },
        {
          label: "Copiar comando para engancharse",
          icon: <Copy size={14} />,
          hint: name,
          onSelect: () => {
            clipboard.write(manualAttachCommand(name)).catch((e) => toast.error("No se pudo copiar", e));
          },
        },
      );
    }
    items.push({
      label: t.persistent ? "Cerrar y terminar la sesión" : "Cerrar terminal",
      icon: <X size={14} />,
      danger: t.persistent,
      onSelect: () => closeTab(key),
    });
    return items;
  }
});
