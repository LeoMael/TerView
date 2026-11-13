// Pestaña «Administración» de una conexión: usuarios, grupos, sesiones abiertas, puertos, sitios web e
// historial de cambios.
// Lee como usuario normal; los cambios se ejecutan como root (directo, sudo -n/doas -n o sudo -S con la
// contraseña por stdin, guardada solo en memoria). Antes de cada cambio se muestra el comando exacto.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bug, Globe, History, KeyRound, LogOut, MonitorDot, Network, RefreshCw, ShieldAlert, ShieldCheck, Unplug, Users, UsersRound } from "lucide-react";
import { errorMessage } from "../../api/core";
import { toast } from "../../stores/toasts";
import { useTabs } from "../../stores/tabs";
import {
  ElevationError,
  buildUserRows,
  detectEnv,
  failureText,
  parsePorts,
  parseWeb,
  readElevated,
  readServer,
  readShadow,
  PORTS_SCRIPT,
  WEB_SCRIPT,
  runPlan as execPlan,
  succeeded,
  useAdminHistory,
  MASK,
  type Plan,
  type PortsResult,
  type ReadResult,
  type ShadowEntry,
  type WebResult,
} from "../../features/admin";
import {
  forgetSudoByUser,
  refreshPrivilege,
  sudoRejected,
  useElevation,
  usePrivilege,
  useStoredSudo,
  useStoredSudoState,
  type Elevation,
} from "../../features/privileges";
import { AdminContext, type AdminContextValue, type PortsFilter, type RunOutcome, type ScanState } from "./context";
import { SudoDialog } from "./SudoDialog";
import { UsersTab } from "./UsersTab";
import { GroupsTab } from "./GroupsTab";
import { SessionsTab } from "./SessionsTab";
import { HistoryTab } from "./HistoryTab";
import { PortsTab } from "./PortsTab";
import { WebTab } from "./WebTab";
import { VulnsTab } from "./VulnsTab";
import { useVulnNav } from "../../features/vulnscan/nav";
import "./Admin.css";

type SubTab = "users" | "groups" | "sessions" | "ports" | "web" | "vulns" | "history";

const TABS: { id: SubTab; label: string; icon: ReactNode }[] = [
  { id: "users", label: "Usuarios", icon: <Users size={14} /> },
  { id: "groups", label: "Grupos", icon: <UsersRound size={14} /> },
  { id: "sessions", label: "Conectados ahora", icon: <MonitorDot size={14} /> },
  { id: "ports", label: "Puertos", icon: <Network size={14} /> },
  { id: "web", label: "Sitios web", icon: <Globe size={14} /> },
  { id: "vulns", label: "Vulnerabilidades", icon: <Bug size={14} /> },
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

/** Sub-pestañas que necesitan la lectura de usuarios y grupos. */
const NEEDS_READ: SubTab[] = ["users", "groups", "sessions"];

const EMPTY_SCAN = { data: null, loading: false, error: null, elevated: false, elevationError: null };

/**
 * Lectura que se hace como root si hay elevación (si sudo falla, se repite sin elevar). Guarda el último
 * resultado aunque se cambie de sub-pestaña.
 */
function useElevatedScan<T>(
  sessionId: string,
  elevation: Elevation | null,
  script: string,
  parse: (stdout: string) => T,
  timeoutSecs: number,
): [ScanState<T>, () => Promise<void>] {
  const [state, setState] = useState<ScanState<T>>(EMPTY_SCAN);
  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await readElevated(sessionId, script, elevation, timeoutSecs);
      if (g !== gen.current) return;
      if (r.elevationError?.failure === "need-password") refreshPrivilege(sessionId);
      if (r.elevationError?.failure === "bad-password") sudoRejected(sessionId);
      setState({
        data: parse(r.result.stdout),
        loading: false,
        error: null,
        elevated: r.elevated,
        elevationError: r.elevationError ? r.elevationError.message : null,
      });
    } catch (e) {
      if (g !== gen.current) return;
      setState((s) => ({ ...s, loading: false, error: errorMessage(e) }));
    }
  }, [sessionId, elevation, script, parse, timeoutSecs]);
  return [state, load];
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
  onOpenFile,
}: {
  sessionId: string;
  profileId: string;
  active: boolean;
  disabled: boolean;
  /** Abre un archivo del servidor en el editor de la conexión. */
  onOpenFile?: (path: string) => void;
}) {
  const info = usePrivilege(sessionId);
  const elev = useElevation(sessionId, info);
  const elevation = elev.elevation;
  // Contraseña de sudo guardada (o la de la conexión), si el servidor lo tiene así configurado.
  useStoredSudo(sessionId, profileId, info, active && !disabled);
  const serverName = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.title ?? "servidor");
  const addHistory = useAdminHistory((s) => s.add);
  const ensureHistory = useAdminHistory((s) => s.ensure);

  const [tab, setTab] = useState<SubTab>("users");
  // «Ver vulnerabilidades» desde Contenedores → Imágenes.
  const vulnNav = useVulnNav((s) => s.request);
  useEffect(() => {
    if (vulnNav?.sessionId === sessionId) setTab("vulns");
  }, [vulnNav, sessionId]);
  const [read, setRead] = useState<ReadResult | null>(null);
  const [shadow, setShadow] = useState<Map<string, ShadowEntry> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shadowError, setShadowError] = useState<string | null>(null);
  const [sudoOpen, setSudoOpen] = useState<null | "ask" | "change">(null);
  const [stale, setStale] = useState(true);
  // La contraseña guardada (o la de la conexión) no sirvió para sudo: pedirla de nuevo.
  const storedSudo = useStoredSudoState(sessionId);
  useEffect(() => {
    if (storedSudo === "failed" && active && !disabled) setSudoOpen((o) => o ?? "ask");
  }, [storedSudo, active, disabled]);
  const gen = useRef(0);

  const [ports, loadPorts] = useElevatedScan<PortsResult>(sessionId, elevation, PORTS_SCRIPT, parsePorts, 20);
  const [web, loadWeb] = useElevatedScan<WebResult>(sessionId, elevation, WEB_SCRIPT, parseWeb, 40);
  const [scanStale, setScanStale] = useState({ ports: true, web: true });
  const [portsFilter, setPortsFilter] = useState<PortsFilter>({ query: "", scope: "all", proto: "all" });

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
          if (e instanceof ElevationError && e.failure === "bad-password") sudoRejected(sessionId);
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
      setScanStale({ ports: true, web: true });
    }
  }, [elevKey]);
  useEffect(() => {
    if (disabled) {
      setStale(true);
      setScanStale({ ports: true, web: true });
    }
  }, [disabled]);
  useEffect(() => {
    if (active && !disabled && stale) {
      setStale(false);
      void load();
    }
  }, [active, disabled, stale, load]);
  // Puertos: al abrir «Puertos» o «Sitios web» (los dos los usan). Sitios web: solo en su pestaña.
  useEffect(() => {
    if (!active || disabled) return;
    const needPorts = (tab === "ports" || tab === "web") && scanStale.ports;
    const needWeb = tab === "web" && scanStale.web;
    if (!needPorts && !needWeb) return;
    setScanStale((s) => ({ ports: needPorts ? false : s.ports, web: needWeb ? false : s.web }));
    if (needPorts) void loadPorts();
    if (needWeb) void loadWeb();
  }, [active, disabled, tab, scanStale, loadPorts, loadWeb]);

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
          if (e.failure === "bad-password") sudoRejected(sessionId);
          return { ok: false, result: null, error: msg, needSudo: e.failure === "bad-password" || e.failure === "need-password" };
        }
        return { ok: false, result: null, error: msg, needSudo: false };
      }
    },
    [disabled, elevation, elev.canAskSudo, sessionId, profileId, serverName, addHistory, load],
  );

  const askSudo = useCallback(() => setSudoOpen("ask"), []);
  const refresh = useCallback(() => void load(), [load]);
  const reloadPorts = useCallback(() => void loadPorts(), [loadPorts]);
  const reloadWeb = useCallback(() => void loadWeb(), [loadWeb]);
  const goToPort = useCallback((port: number) => {
    setPortsFilter({ query: `:${port}`, scope: "all", proto: "all" });
    setTab("ports");
  }, []);
  const openFile = onOpenFile ?? null;

  /** El botón de recargar de la cabecera relee lo que muestra la sub-pestaña actual. */
  const refreshCurrent = () => {
    if (tab === "ports") reloadPorts();
    else if (tab === "web") {
      reloadPorts();
      reloadWeb();
    } else refresh();
  };
  const busy = tab === "ports" ? ports.loading : tab === "web" ? web.loading || ports.loading : loading;

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
      ports,
      loadPorts: reloadPorts,
      web,
      loadWeb: reloadWeb,
      portsFilter,
      setPortsFilter,
      goToPort,
      openFile,
    }),
    [
      sessionId,
      profileId,
      serverName,
      disabled,
      info,
      elev,
      elevation,
      env,
      read,
      shadow,
      users,
      me,
      refresh,
      runPlan,
      askSudo,
      ports,
      reloadPorts,
      web,
      reloadWeb,
      portsFilter,
      goToPort,
      openFile,
    ],
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
            {info?.hasSudo && info.level !== "root" && info.level !== "sudo-nopasswd" && (
              <button
                className="btn btn-sm"
                onClick={() => setSudoOpen("change")}
                disabled={disabled}
                title="Escribe la contraseña de sudo y guárdala para este servidor"
              >
                <KeyRound size={13} /> Cambiar contraseña de sudo…
              </button>
            )}
            {elev.hasPassword && (
              <button
                className="icon-btn"
                onClick={() => {
                  forgetSudoByUser(sessionId);
                  toast.info("Contraseña de sudo olvidada");
                }}
                title="Olvidar la contraseña de sudo de esta conexión (la guardada no se borra)"
                aria-label="Olvidar la contraseña de sudo de esta conexión"
              >
                <LogOut size={14} />
              </button>
            )}
            <button
              className="icon-btn"
              onClick={refreshCurrent}
              disabled={disabled || busy}
              title="Recargar"
              aria-label="Recargar"
            >
              <RefreshCw size={14} className={busy ? "adm-spin" : undefined} />
            </button>
          </div>
        </div>

        {disabled && (
          <div className="adm-banner adm-banner-off" role="status">
            <Unplug size={14} /> Sin conexión: lo que ves puede estar desactualizado y no se pueden hacer cambios.
          </div>
        )}
        {!disabled && !elevation && storedSudo === "loading" && (
          <div className="adm-banner" role="status">
            <span className="spinner adm-spinner-btn" />
            <span className="adm-banner-text">Comprobando la contraseña de sudo guardada…</span>
          </div>
        )}
        {!disabled && !elevation && elev.readOnlyReason && storedSudo !== "loading" && (
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
        {!disabled && elevation && shadowError && NEEDS_READ.includes(tab) && (
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
          {tab === "vulns" ? (
            <VulnsTab />
          ) : tab === "ports" ? (
            <PortsTab />
          ) : tab === "web" ? (
            <WebTab />
          ) : error && !read && NEEDS_READ.includes(tab) ? (
            <div className="empty-state">
              <ShieldAlert size={22} />
              <div>No se pudo leer la información del servidor</div>
              <div className="faint adm-pre-wrap">{error}</div>
              <button className="btn btn-sm" onClick={refresh} disabled={disabled}>
                <RefreshCw size={13} /> Reintentar
              </button>
            </div>
          ) : !read && NEEDS_READ.includes(tab) ? (
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
        {sudoOpen && (
          <SudoDialog
            sessionId={sessionId}
            profileId={profileId}
            user={me}
            change={sudoOpen === "change"}
            onClose={() => setSudoOpen(null)}
          />
        )}
      </div>
    </AdminContext.Provider>
  );
}
