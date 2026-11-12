// Túneles (port forwarding) del servidor: lista con interruptor, estado en vivo y editor.
// El motor arranca los "automáticos" al conectar, los rehace al reconectar y los para al cerrar.
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Cable, Copy, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { errorMessage, isApiError } from "../../api/core";
import { tunnels, type TunnelDef, type TunnelStatus } from "../../api/tunnels";
import { clipboard } from "../../lib/clipboard";
import { formatBytes } from "../../lib/format";
import { toast } from "../../stores/toasts";
import { confirmDialog } from "../ui/dialogs";
import {
  ensureTunnelEvents,
  KIND_INFO,
  TUNNEL_TEMPLATES,
  tunnelAddress,
  useTunnels,
  type TunnelTemplate,
} from "../../features/tunnels/useTunnels";
import { TunnelDialog } from "./TunnelDialog";
import "./Tunnels.css";

export interface TunnelsPanelProps {
  sessionId: string;
  profileId: string;
  /** La pestaña se ve. */
  active: boolean;
  /** Sin conexión. */
  disabled: boolean;
}

const NO_STATUS: Record<string, TunnelStatus> = {};

function blank(profileId: string, t?: TunnelTemplate): TunnelDef {
  return {
    id: "",
    profileId,
    name: t?.name ?? "",
    kind: t?.kind ?? "local",
    bindHost: "127.0.0.1",
    bindPort: t?.port ?? 0,
    destHost: t?.kind === "socks" ? "" : "127.0.0.1",
    destPort: t && t.kind !== "socks" ? t.port : 0,
    autoStart: false,
  };
}

function isOn(st: TunnelStatus | undefined): boolean {
  return !!st && (st.state === "active" || st.state === "starting" || st.state === "waiting");
}

function routeText(def: TunnelDef, st?: TunnelStatus) {
  const addr = tunnelAddress(def, st);
  if (def.kind === "socks") return { from: "Tu PC", fromAddr: addr, to: "SOCKS5", toAddr: "sale por el servidor" };
  if (def.kind === "remote")
    return { from: "Servidor", fromAddr: addr, to: "Tu PC", toAddr: `${def.destHost}:${def.destPort}` };
  return { from: "Tu PC", fromAddr: addr, to: "Servidor", toAddr: `${def.destHost}:${def.destPort}` };
}

const STATE_LABEL: Record<TunnelStatus["state"], string> = {
  starting: "Activando…",
  active: "Activo",
  waiting: "Esperando conexión",
  stopped: "Parado",
  error: "Error",
};

export function TunnelsPanel({ sessionId, profileId, active, disabled }: TunnelsPanelProps) {
  const defs = useTunnels((s) => s.defs[profileId]);
  const statusMap = useTunnels((s) => s.status[sessionId]) ?? NO_STATUS;
  const [editing, setEditing] = useState<TunnelDef | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => ensureTunnelEvents(), []);

  useEffect(() => {
    setLoadError(null);
    useTunnels
      .getState()
      .loadDefs(profileId)
      .catch((e) => setLoadError(errorMessage(e)));
  }, [profileId]);

  // Sincronizar al mostrarse y al conectar/reconectar (los eventos cubren el resto).
  useEffect(() => {
    if (!active) return;
    useTunnels
      .getState()
      .loadStatus(sessionId)
      .catch(() => {});
  }, [sessionId, active, disabled]);

  const setBusyFor = (id: string, v: boolean) => setBusy((b) => ({ ...b, [id]: v }));

  const start = useCallback(
    async (def: TunnelDef) => {
      setBusyFor(def.id, true);
      try {
        useTunnels.getState().applyStatus(await tunnels.start(sessionId, def.id));
      } catch (e) {
        if (!isApiError(e, "Canceled")) toast.error(`No se pudo activar «${def.name}»`, e);
        useTunnels.getState().loadStatus(sessionId).catch(() => {});
      } finally {
        setBusyFor(def.id, false);
      }
    },
    [sessionId],
  );

  const stop = useCallback(
    async (def: TunnelDef) => {
      setBusyFor(def.id, true);
      try {
        await tunnels.stop(sessionId, def.id);
        useTunnels.getState().loadStatus(sessionId).catch(() => {});
      } catch (e) {
        toast.error(`No se pudo parar «${def.name}»`, e);
      } finally {
        setBusyFor(def.id, false);
      }
    },
    [sessionId],
  );

  const remove = async (def: TunnelDef) => {
    const ok = await confirmDialog({
      title: `¿Borrar el túnel «${def.name}»?`,
      message: isOn(statusMap[def.id]) ? "Está activo: se cerrará y se cortarán sus conexiones." : undefined,
      confirmText: "Borrar",
      danger: true,
    });
    if (!ok) return;
    try {
      await useTunnels.getState().remove(def);
    } catch (e) {
      toast.error("No se pudo borrar el túnel", e);
    }
  };

  const copy = async (def: TunnelDef) => {
    const addr = tunnelAddress(def, statusMap[def.id]);
    try {
      await clipboard.write(addr);
      toast.success("Dirección copiada", addr);
    } catch (e) {
      toast.error("No se pudo copiar", e);
    }
  };

  const save = async (def: TunnelDef, activate: boolean) => {
    const saved = await useTunnels.getState().save(def);
    setEditing(null);
    if (activate && !disabled) await start(saved);
  };

  const list = defs ?? [];

  return (
    <div className="tn-panel">
      <div className="tn-header">
        <span className="section-label">Túneles</span>
        <button className="btn btn-sm btn-primary" onClick={() => setEditing(blank(profileId))}>
          <Plus size={14} /> Nuevo túnel
        </button>
      </div>

      {disabled && <div className="tn-banner">Sin conexión: los túneles se activan cuando el servidor está conectado.</div>}
      {loadError && <div className="tn-banner tn-banner-error">{loadError}</div>}

      {defs === undefined && !loadError ? (
        <div className="empty-state">
          <div className="spinner" />
        </div>
      ) : list.length === 0 ? (
        <div className="empty-state tn-empty">
          <Cable size={28} />
          <div>Aún no hay túneles para este servidor</div>
          <p className="tn-empty-text">
            Un túnel te deja usar desde tu PC un servicio del servidor (una base de datos, un panel web…) como si
            estuviera en tu equipo, de forma segura por SSH.
          </p>
          <div className="tn-templates tn-templates-center">
            {TUNNEL_TEMPLATES.map((t) => (
              <button key={t.label} className="tn-chip" onClick={() => setEditing(blank(profileId, t))}>
                {t.label} <span className="tn-chip-port">{t.port}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className="tn-list">
          {list.map((def) => {
            const st = statusMap[def.id];
            const on = isOn(st);
            const state = st?.state ?? "stopped";
            const route = routeText(def, st);
            const pending = !!busy[def.id];
            return (
              <li key={def.id} className={`tn-row tn-state-${state}`}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={on ? `Desactivar ${def.name}` : `Activar ${def.name}`}
                  title={disabled ? "Conéctate para activar" : on ? "Desactivar" : "Activar"}
                  className={on ? "tn-switch on" : "tn-switch"}
                  disabled={pending || (disabled && !on)}
                  onClick={() => void (on ? stop(def) : start(def))}
                >
                  <span />
                </button>
                <div className="tn-main">
                  <div className="tn-line">
                    <span className={`status-dot tn-dot tn-dot-${state}`} title={STATE_LABEL[state]} />
                    <span className="tn-name" title={def.name}>
                      {def.name}
                    </span>
                    <span className={`tn-kind tn-kind-${def.kind}`} title={KIND_INFO[def.kind].help}>
                      {KIND_INFO[def.kind].label}
                    </span>
                    {def.autoStart && (
                      <span className="tn-auto" title="Se activa solo al conectar">
                        auto
                      </span>
                    )}
                    {(pending || state === "starting") && <span className="spinner tn-spinner" />}
                  </div>
                  <div className="tn-route">
                    <span className="faint">{route.from}</span> <span className="mono">{route.fromAddr}</span>
                    <span className="tn-arrow">→</span>
                    <span className="faint">{route.to}</span> <span className="mono">{route.toAddr}</span>
                  </div>
                  {on && st && (
                    <div className="tn-stats">
                      <span>
                        {st.connections === 1 ? "1 conexión" : `${st.connections} conexiones`}
                      </span>
                      <span title="De tu PC hacia el servidor">
                        <ArrowUp size={12} /> {formatBytes(st.bytesUp)}
                      </span>
                      <span title="Del servidor hacia tu PC">
                        <ArrowDown size={12} /> {formatBytes(st.bytesDown)}
                      </span>
                    </div>
                  )}
                  {st?.message && (
                    <div className={state === "error" ? "tn-msg tn-msg-error" : "tn-msg tn-msg-wait"}>{st.message}</div>
                  )}
                  {on && st?.lastError && !st.message && (
                    <div className="tn-msg tn-msg-warn" title="Último fallo de una conexión">
                      <TriangleAlert size={12} /> {st.lastError}
                    </div>
                  )}
                </div>
                <div className="tn-actions">
                  <button className="icon-btn" title={`Copiar ${route.fromAddr}`} onClick={() => void copy(def)}>
                    <Copy size={14} />
                  </button>
                  <button className="icon-btn" title="Editar" onClick={() => setEditing(def)}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-btn tn-danger" title="Borrar" onClick={() => void remove(def)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <TunnelDialog
          initial={editing}
          canActivate={!disabled && !isOn(statusMap[editing.id])}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}
