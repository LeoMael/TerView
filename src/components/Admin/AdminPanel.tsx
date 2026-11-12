// Pestaña «Administración» de una conexión: usuarios, grupos, sesiones abiertas e historial de cambios.
// Lee como usuario normal; los cambios se ejecutan como root (directo, sudo -n/doas -n o sudo -S con la
// contraseña por stdin, guardada solo en memoria). Antes de cada cambio se muestra el comando exacto.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { History, KeyRound, LogOut, RefreshCw, ShieldAlert, ShieldCheck, Unplug, Users, UsersRound, MonitorDot } from "lucide-react";
import { errorMessage } from "../../api/core";
import { toast } from "../../stores/toasts";
import { useTabs } from "../../stores/tabs";
import {
  ElevationError,
  buildUserRows,
  detectEnv,
  failureText,
  readServer,
  readShadow,
  runPlan as execPlan,
  succeeded,
  useAdminHistory,
  MASK,
  type Plan,
  type ReadResult,
  type ShadowEntry,
} from "../../features/admin";
import {
  forgetSudo,
  refreshPrivilege,
  useElevation,
  usePrivilege,
  type Elevation,
} from "../../features/privileges";
import { AdminContext, type AdminContextValue, type RunOutcome } from "./context";
import { SudoDialog } from "./SudoDialog";
import { UsersTab } from "./UsersTab";
import { GroupsTab } from "./GroupsTab";
import { SessionsTab } from "./SessionsTab";
import { HistoryTab } from "./HistoryTab";
import "./Admin.css";

type SubTab = "users" | "groups" | "sessions" | "history";

const TABS: { id: SubTab; label: string; icon: ReactNode }[] = [
  { id: "users", label: "Usuarios", icon: <Users size={14} /> },
  { id: "groups", label: "Grupos", icon: <UsersRound size={14} /> },
  { id: "sessions", label: "Conectados ahora", icon: <MonitorDot size={14} /> },
  { id: "history", label: "Historial", icon: <History size={14} /> },
];

function elevationNote(el: Elevation): string {
  switch (el.kind) {
    case "root":
      return "# como root";
    case "nopasswd":
      return `# como root con ${el.tool} -n`;
    case "password":
      return `# como root con sudo -S (contraseña por stdin: ${MASK})`;
    default:
      return "# sin elevar";
  }
}

/** Texto del historial: comandos sin contraseñas (nunca las llevan) + stdin enmascarado. */
function historyCommand(plan: Plan, el: Elevation): string {
  return [elevationNote(el), ...plan.steps, ...(plan.secretLabel ? [`# entrada estándar: ${plan.secretLabel}`] : [])].join("\n");
}

export function AdminPanel({
  sessionId,
  profileId,
  active,
  disabled,
}: {
  sessionId: string;
  profileId: string;
  active: boolean;
  disabled: boolean;
}) {
  const info = usePrivilege(sessionId);
  const elev = useElevation(sessionId, info);
  const elevation = elev.elevation;
  const serverName = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.title ?? "servidor");
  const addHistory = useAdminHistory((s) => s.add);
  const ensureHistory = useAdminHistory((s) => s.ensure);

  const [tab, setTab] = useState<SubTab>("users");
  const [read, setRead] = useState<ReadResult | null>(null);
  const [shadow, setShadow] = useState<Map<string, ShadowEntry> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shadowError, setShadowError] = useState<string | null>(null);
  const [sudoOpen, setSudoOpen] = useState(false);
  const [stale, setStale] = useState(true);
  const gen = useRef(0);

  useEffect(() => ensureHistory(profileId), [ensureHistory, profileId]);

  const load = useCallback(async () => {
    const g = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const r = await readServer(sessionId);
      if (g !== gen.current) return;
      setRead(r);
      if (elevation) {
        try {
          const s = await readShadow(sessionId, elevation);
          if (g !== gen.current) return;
          setShadow(s);
          setShadowError(null);
        } catch (e) {
          if (g !== gen.current) return;
          setShadow(null);
          setShadowError(errorMessage(e));
          if (e instanceof ElevationError && e.failure === "need-password") refreshPrivilege(sessionId);
        }
      } else {
        setShadow(null);
        setShadowError(null);
      }
    } catch (e) {
      if (g !== gen.current) return;
      setError(errorMessage(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, [sessionId, elevation]);

  // Recargar al cambiar la elevación (p. ej. tras confirmar sudo) o al reconectar.
  const elevKey = elevation ? elevation.kind : "none";
  const prevElevKey = useRef(elevKey);
  useEffect(() => {
    if (prevElevKey.current !== elevKey) {
      prevElevKey.current = elevKey;
      setStale(true);
    }
  }, [elevKey]);
  useEffect(() => {
    if (disabled) setStale(true);
  }, [disabled]);
  useEffect(() => {
    if (active && !disabled && stale) {
      setStale(false);
      void load();
    }
  }, [active, disabled, stale, load]);

  const env = useMemo(
    () => (read ? detectEnv(read.tools, info?.distroId ?? null, info?.distroLike ?? [], read.groups.map((g) => g.name)) : null),
    [read, info?.distroId, info?.distroLike],
  );
  const users = useMemo(() => (read ? buildUserRows(read, shadow) : []), [read, shadow]);
  const me = read?.me ?? info?.user ?? null;

  const runPlan = useCallback(
    async (plan: Plan, opts?: { refresh?: boolean }): Promise<RunOutcome> => {
      if (disabled) return { ok: false, result: null, error: "Sin conexión con el servidor", needSudo: false };
      if (!elevation) {
        return { ok: false, result: null, error: "Necesitas root o sudo para hacer cambios", needSudo: elev.canAskSudo };
      }
      const command = historyCommand(plan, elevation);
      try {
        const r = await execPlan(sessionId, plan, elevation);
        const ok = succeeded(r);
        const text = ok ? r.stdout.trim() || r.stderr.trim() || "Correcto" : failureText(r);
        addHistory(profileId, { server: serverName, action: plan.action, command, ok, result: text });
        if (ok) toast.success(plan.action, "Hecho");
        else toast.error(`No se pudo: ${plan.action}`, text);
        if (opts?.refresh !== false) void load();
        return { ok, result: r, error: ok ? null : text, needSudo: false };
      } catch (e) {
        const msg = errorMessage(e);
        addHistory(profileId, { server: serverName, action: plan.action, command, ok: false, result: msg });
        toast.error(`No se pudo: ${plan.action}`, msg);
        if (e instanceof ElevationError) {
          if (e.failure === "need-password") refreshPrivilege(sessionId);
          return { ok: false, result: null, error: msg, needSudo: e.failure === "bad-password" || e.failure === "need-password" };
        }
        return { ok: false, result: null, error: msg, needSudo: false };
      }
    },
    [disabled, elevation, elev.canAskSudo, sessionId, profileId, serverName, addHistory, load],
  );

  const askSudo = useCallback(() => setSudoOpen(true), []);
  const refresh = useCallback(() => void load(), [load]);

  const ctx: AdminContextValue = useMemo(
    () => ({
      sessionId,
      profileId,
      serverName,
      disabled,
      info,
      elev,
      elevation,
      readOnly: !elevation || disabled,
      env,
      read,
      shadow,
      users,
      me,
      refresh,
      runPlan,
      askSudo,
    }),
    [sessionId, profileId, serverName, disabled, info, elev, elevation, env, read, shadow, users, me, refresh, runPlan, askSudo],
  );

  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(TABS[n].id);
    document.getElementById(`adm-tab-${sessionId}-${TABS[n].id}`)?.focus();
  };

  if (!active) return null;

  const modeClass =
    elevation?.kind === "root" ? "root" : elevation ? "sudo" : info?.level === "unknown" ? "unknown" : "ro";

  return (
    <AdminContext.Provider value={ctx}>
      <div className="adm-root">
        <div className="adm-header">
          <div className="adm-tabs" role="tablist" aria-label="Secciones de administración" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`adm-tab-${sessionId}-${t.id}`}
                role="tab"
                aria-selected={tab === t.id}
                aria-controls={`adm-panel-${sessionId}`}
                tabIndex={tab === t.id ? 0 : -1}
                className={`adm-tab${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.icon}
                {t.label}
                {t.id === "sessions" && read && read.who.length > 0 && <span className="adm-count">{read.who.length}</span>}
              </button>
            ))}
          </div>
          <div className="adm-header-right">
            <span className={`adm-mode adm-mode-${modeClass}`} title={elev.readOnlyReason ?? `Los cambios se hacen como root (${elev.label})`}>
              {elevation ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
              {elevation ? elev.label : "Solo lectura"}
            </span>
            {elev.hasPassword && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  forgetSudo(sessionId);
                  toast.info("Contraseña de sudo olvidada");
                }}
                title="Borra de la memoria la contraseña de sudo de esta conexión"
              >
                <LogOut size={13} /> Olvidar contraseña de sudo
              </button>
            )}
            <button
              className="icon-btn"
              onClick={refresh}
              disabled={disabled || loading}
              title="Recargar"
              aria-label="Recargar"
            >
              <RefreshCw size={14} className={loading ? "adm-spin" : undefined} />
            </button>
          </div>
        </div>

        {disabled && (
          <div className="adm-banner adm-banner-off" role="status">
            <Unplug size={14} /> Sin conexión: lo que ves puede estar desactualizado y no se pueden hacer cambios.
          </div>
        )}
        {!disabled && !elevation && elev.readOnlyReason && (
          <div className="adm-banner" role="status">
            <ShieldAlert size={14} />
            <span className="adm-banner-text">{elev.readOnlyReason}</span>
            {elev.canAskSudo && (
              <button className="btn btn-sm btn-primary" onClick={askSudo}>
                <KeyRound size={13} /> Tengo sudo: introducir contraseña
              </button>
            )}
          </div>
        )}
        {!disabled && elevation && shadowError && (
          <div className="adm-banner adm-banner-warn" role="status">
            <ShieldAlert size={14} />
            <span className="adm-banner-text">No se pudo leer el estado de las contraseñas: {shadowError}</span>
            {elev.canAskSudo && (
              <button className="btn btn-sm" onClick={askSudo}>
                <KeyRound size={13} /> Introducir contraseña de sudo
              </button>
            )}
          </div>
        )}

        <div className="adm-body" id={`adm-panel-${sessionId}`} role="tabpanel" aria-labelledby={`adm-tab-${sessionId}-${tab}`}>
          {error && !read ? (
            <div className="empty-state">
              <ShieldAlert size={22} />
              <div>No se pudo leer la información del servidor</div>
              <div className="faint adm-pre-wrap">{error}</div>
              <button className="btn btn-sm" onClick={refresh} disabled={disabled}>
                <RefreshCw size={13} /> Reintentar
              </button>
            </div>
          ) : !read && tab !== "history" ? (
            <div className="empty-state">
              <span className="spinner" />
              <div>Leyendo usuarios y grupos…</div>
            </div>
          ) : tab === "users" ? (
            <UsersTab />
          ) : tab === "groups" ? (
            <GroupsTab />
          ) : tab === "sessions" ? (
            <SessionsTab />
          ) : (
            <HistoryTab />
          )}
        </div>
        {sudoOpen && <SudoDialog sessionId={sessionId} user={me} onClose={() => setSudoOpen(false)} />}
      </div>
    </AdminContext.Provider>
  );
}
