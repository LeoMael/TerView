// Zona de terminales de una pestaña de conexión: sub-pestañas + una xterm por shell.
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, SquareTerminal, Unplug, X } from "lucide-react";
import { TerminalView } from "./TerminalView";
import type { ConnState, TermController, TermStatus } from "./termController";
import { useTabs } from "../../stores/tabs";
import { registerTerminalWriter } from "../../stores/terminalBus";
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
}

let keySeq = 0;
const newTab = (num: number): SubTab => ({ key: ++keySeq, num, status: "opening" });

export function TerminalArea({ sessionId, active, disabled }: TerminalAreaProps) {
  const [tabs, setTabs] = useState<SubTab[]>(() => (disabled ? [] : [newTab(1)]));
  const [activeKey, setActiveKey] = useState<number | null>(() => tabs[0]?.key ?? null);
  const ctrls = useRef(new Map<number, TermController>());

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

  const addTab = useCallback(() => {
    if (blocked) return;
    const used = new Set(tabs.map((p) => p.num));
    let num = 1;
    while (used.has(num)) num++;
    const t = newTab(num);
    setTabs((prev) => [...prev, t]);
    setActiveKey(t.key);
  }, [blocked, tabs]);

  const closeTab = useCallback(
    (key: number) => {
      const idx = tabs.findIndex((t) => t.key === key);
      const rest = tabs.filter((t) => t.key !== key);
      setTabs((prev) => prev.filter((t) => t.key !== key));
      if (key === activeKey) setActiveKey(rest[Math.max(0, idx - 1)]?.key ?? null);
    },
    [tabs, activeKey],
  );

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
            >
              <SquareTerminal size={13} className="term-tab-icon" />
              <span className="term-tab-label">Terminal {t.num}</span>
              <button
                type="button"
                className="term-tab-close"
                tabIndex={-1}
                aria-label={`Cerrar Terminal ${t.num}`}
                title="Cerrar terminal"
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
          onClick={addTab}
          disabled={blocked}
          title={disabled ? "Conexión cerrada" : reconnecting ? "Reconectando…" : "Nueva terminal"}
          aria-label="Nueva terminal"
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="term-body">
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            sessionId={sessionId}
            visible={active && t.key === activeKey}
            disabled={disabled}
            connState={connState}
            reconnectCount={reconnectCount}
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
              <button type="button" className="btn btn-sm" onClick={addTab}>
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
    </div>
  );
}
