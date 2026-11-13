// Pestaña «Contenedores» de una conexión: administrador visual de Podman / Docker.
// Detecta el motor, decide si hace falta sudo y reparte el trabajo entre sub-pestañas
// (Contenedores, Imágenes, Volúmenes, Redes, Compose, Limpieza). Todo por el canal exec.
// Con root o sudo, el selector «Usuario» deja ver los contenedores de root y de cada usuario (Podman
// rootless, o Docker rootless), uno a uno o todos juntos; cada acción se ejecuta como el dueño.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, KeyRound, Play, RefreshCw, ShieldAlert, Users } from "lucide-react";
import {
  DETECT_SCRIPT,
  OWNER_ALL,
  OWNER_SELF,
  composeFor,
  dockerGroupCommand,
  findOwner,
  listContainers,
  listImages,
  listNetworks,
  listUnusedVolumes,
  listVolumes,
  loadEngine,
  loadOwnerChoice,
  mergeOwned,
  ownedFullScript,
  ownerIsRoot,
  ownerKey,
  ownerLine,
  ownerName,
  ownerOptions,
  parseContainers,
  parseDetect,
  parseDf,
  parseImages,
  parseNetworks,
  parseStats,
  parseVolumes,
  perOwner,
  readOwners,
  renderCmd,
  runOwned,
  runRaw,
  saveEngine,
  saveOwnerChoice,
  scriptFor,
  splitMarked,
  statsOnce,
  systemDf,
  elevationPrefix,
  type Cmd,
  type Container,
  type ContainerStats,
  type CtOwner,
  type DetectResult,
  type Engine,
  type EngineRun,
  type EngineStatus,
  type OwnerRunner,
  type RunForm,
} from "../../features/containers";
import { usePrivilege, useElevation, useStoredSudo, useStoredSudoState, type Elevation } from "../../features/privileges";
import { sudoRejected } from "../../features/privileges/sudo";
import { ElevationError } from "../../features/admin/run";
import { loadStoreUsers, useVulnScan } from "../../features/vulnscan/run";
import { errorMessage } from "../../api/core";
import { hasTerminal, sendToTerminal } from "../../stores/terminalBus";
import { toast } from "../../stores/toasts";
import { SudoDialog } from "../Admin/SudoDialog";
import {
  CtContext,
  type CtContextValue,
  type LogsTarget,
  type Resource,
  type ResourceKind,
  type ResourceMap,
  type ReviewRequest,
} from "./context";
import { ReviewDialog } from "./ReviewDialog";
import { NoEngine } from "./NoEngine";
import { ContainersTab } from "./ContainersTab";
import "./Containers.css";

const ImagesTab = lazy(() => import("./ImagesTab").then((m) => ({ default: m.ImagesTab })));
const VolumesTab = lazy(() => import("./VolumesTab").then((m) => ({ default: m.VolumesTab })));
const NetworksTab = lazy(() => import("./NetworksTab").then((m) => ({ default: m.NetworksTab })));
const ComposeTab = lazy(() => import("./ComposeTab").then((m) => ({ default: m.ComposeTab })));
const CleanupTab = lazy(() => import("./CleanupTab").then((m) => ({ default: m.CleanupTab })));
const LogsDialog = lazy(() => import("./LogsDialog").then((m) => ({ default: m.LogsDialog })));
const InspectDialog = lazy(() => import("./InspectDialog").then((m) => ({ default: m.InspectDialog })));
const RunDialog = lazy(() => import("./RunDialog").then((m) => ({ default: m.RunDialog })));

export interface ContainersPanelProps {
  sessionId: string;
  profileId: string;
  /** La pestaña se ve. */
  active: boolean;
  /** Sin conexión. */
  disabled: boolean;
}

type SubTab = "containers" | "images" | "volumes" | "networks" | "compose" | "cleanup";

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: "containers", label: "Contenedores" },
  { id: "images", label: "Imágenes" },
  { id: "volumes", label: "Volúmenes" },
  { id: "networks", label: "Redes" },
  { id: "compose", label: "Compose" },
  { id: "cleanup", label: "Limpieza" },
];

const NO_ELEVATION: Elevation = { kind: "none" };
const STATS_MS = 5000;
const LIST_MS = 15000;

function emptyRes<T>(): Resource<T> {
  return { data: null, loading: false, error: null, loadedAt: 0 };
}

function emptyMap(): ResourceMap {
  return { containers: emptyRes(), images: emptyRes(), volumes: emptyRes(), networks: emptyRes(), df: emptyRes() };
}

export function ContainersPanel({ sessionId, profileId, active, disabled }: ContainersPanelProps) {
  const info = usePrivilege(sessionId);
  const elev = useElevation(sessionId, info);
  useStoredSudo(sessionId, profileId, info, active && !disabled);

  const [det, setDet] = useState<{ loading: boolean; result: DetectResult | null; error: string | null }>({
    loading: false,
    result: null,
    error: null,
  });
  const [enginePref, setEnginePref] = useState<Engine | null>(() => loadEngine(profileId));
  /** Selector «Usuario»: "self", "root", "u:<usuario>" o "all". */
  const [choice, setChoice] = useState(() => loadOwnerChoice(profileId));
  // Usuarios con contenedores propios: la misma lista (y el mismo script) que el escáner.
  const usersView = useVulnScan((s) => s.users[sessionId] ?? null);
  const [usersLoad, setUsersLoad] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [tab, setTab] = useState<SubTab>("containers");
  const [res, setRes] = useState<ResourceMap>(emptyMap);
  const [stats, setStats] = useState<ContainerStats[]>([]);
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [sudoOpen, setSudoOpen] = useState(false);
  // La contraseña guardada (o la de la conexión) no sirvió para sudo: pedirla de nuevo.
  const storedSudo = useStoredSudoState(sessionId);
  useEffect(() => {
    if (storedSudo === "failed" && active && !disabled) setSudoOpen(true);
  }, [storedSudo, active, disabled]);
  const [logs, setLogs] = useState<LogsTarget | null>(null);
  const [inspectC, setInspectC] = useState<Container | null>(null);
  const [runForm, setRunForm] = useState<{ prefill?: Partial<RunForm>; owner?: string } | null>(null);

  // ───────── Detección ─────────
  const detGen = useRef(0);
  const detect = useCallback(async () => {
    const gen = ++detGen.current;
    setDet((d) => ({ ...d, loading: true, error: null }));
    const r = await runRaw(sessionId, DETECT_SCRIPT, { kind: "none" }, 40);
    if (gen !== detGen.current) return;
    const out = r.result ? parseDetect(r.result.stdout) : null;
    if (out?.ok) setDet({ loading: false, result: out, error: null });
    else setDet({ loading: false, result: null, error: r.error ?? "No se pudo comprobar si hay Podman o Docker en el servidor" });
  }, [sessionId]);

  const wasDisabled = useRef(disabled);
  const detectedOnce = useRef(false);
  useEffect(() => {
    if (disabled) {
      wasDisabled.current = true;
      return;
    }
    // Primera vez que se ve la pestaña, o tras reconectar.
    if ((active && !detectedOnce.current) || (wasDisabled.current && detectedOnce.current)) {
      detectedOnce.current = true;
      wasDisabled.current = false;
      void detect();
    }
  }, [active, disabled, detect]);

  const result = det.result;
  const available: EngineStatus[] = useMemo(
    () => [result?.podman, result?.docker].filter((x): x is EngineStatus => !!x),
    [result],
  );
  const status: EngineStatus | null =
    available.find((s) => s.engine === enginePref) ??
    // Por defecto: el que funcione sin sudo; si no, el primero.
    available.find((s) => s.accessible) ??
    available[0] ??
    null;
  const engine = status?.engine ?? "podman";

  // ───────── Usuarios y elevación ─────────
  const isRoot = result?.uid === 0 || info?.level === "root";
  const me = info?.user ?? null;
  /** Se puede ver lo de root y de otros usuarios (con root o sudo). */
  const canElevate = isRoot || info?.level === "sudo-nopasswd" || !!info?.hasSudo;
  /** Elevación para root y los demás usuarios (null = falta la contraseña de sudo). */
  const otherEl: Elevation | null = isRoot ? NO_ELEVATION : elev.elevation;
  /** Docker sin permiso sobre el socket: «tú» también necesita sudo. */
  const dockerSelfSudo = engine === "docker" && !!status?.needsSudo && !isRoot;
  const selfEl: Elevation | null = dockerSelfSudo ? elev.elevation : NO_ELEVATION;
  const selfLabel = isRoot ? "root" : engine === "docker" && !status?.rootless ? "sistema" : (me ?? "tu usuario");

  const options = useMemo(
    () => ownerOptions({ engine, users: usersView?.users ?? [], me, isRoot }),
    [engine, usersView, me, isRoot],
  );
  const effChoice = canElevate ? choice : OWNER_SELF;
  const all = effChoice === OWNER_ALL && options.length > 1;
  // Un usuario (o «Todos») elegido antes, mientras se lee la lista de usuarios.
  const waitingUsers = (effChoice === OWNER_ALL || effChoice.startsWith("u:")) && !usersView && !usersLoad.error && canElevate;
  const current: CtOwner | null = all ? null : (findOwner(options, effChoice) ?? (waitingUsers ? null : { kind: "self" }));
  const activeOwners: CtOwner[] = useMemo(
    () => (all ? options.filter((o) => o.kind !== "self" || !!status?.accessible || dockerSelfSudo) : current ? [current] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, options, status?.accessible, dockerSelfSudo, current && ownerKey(current)],
  );
  const currentKey = current ? ownerKey(current) : OWNER_SELF;

  const needsSudo =
    !!status && !isRoot && (waitingUsers || activeOwners.some((o) => o.kind !== "self" || dockerSelfSudo) || (!current && !all));
  const elevation: Elevation | null = useMemo(() => (needsSudo ? elev.elevation : NO_ELEVATION), [needsSudo, elev.elevation]);
  const elevPrefix = isRoot ? "" : elev.elevation ? elevationPrefix(elev.elevation) : "sudo ";
  const selfPrefix = dockerSelfSudo ? elevPrefix : "";
  const prefix = current?.kind === "self" ? selfPrefix : elevPrefix;
  const runnable = !!status && !!elevation && !disabled && !waitingUsers && activeOwners.length > 0 && (status.accessible || needsSudo);
  const engineKey = `${engine}|${all ? OWNER_ALL : current ? currentKey : "?"}|${activeOwners.map(ownerKey).join(",")}|${elevation?.kind ?? "none"}`;

  const label = useCallback((o: CtOwner) => ownerName(o, selfLabel), [selfLabel]);
  const resolve = useCallback((k: string) => findOwner(options, k), [options]);
  const runner: OwnerRunner = useMemo(
    () => ({
      sessionId,
      engine,
      fallback: currentKey,
      resolve,
      elevationFor: (o: CtOwner) => (o.kind === "self" ? selfEl : otherEl),
      label,
    }),
    [sessionId, engine, currentKey, resolve, selfEl, otherEl, label],
  );

  const loadUsers = useCallback(async () => {
    if (!otherEl) return;
    setUsersLoad({ loading: true, error: null });
    try {
      await loadStoreUsers(sessionId, otherEl);
      setUsersLoad({ loading: false, error: null });
    } catch (e) {
      if (e instanceof ElevationError) {
        if (e.failure === "bad-password") sudoRejected(sessionId);
        if (e.failure === "bad-password" || e.failure === "need-password") setSudoOpen(true);
      }
      setUsersLoad({ loading: false, error: errorMessage(e) });
    }
  }, [sessionId, otherEl]);

  // Con root o sudo (ya con contraseña), se buscan una vez los usuarios con contenedores propios.
  useEffect(() => {
    if (!active || disabled || !status || !canElevate || !otherEl || usersView || usersLoad.loading || usersLoad.error) return;
    void loadUsers();
  }, [active, disabled, status, canElevate, otherEl, usersView, usersLoad.loading, usersLoad.error, loadUsers]);

  // ───────── Recursos ─────────
  const keyRef = useRef(engineKey);
  useEffect(() => {
    if (keyRef.current !== engineKey) {
      keyRef.current = engineKey;
      setRes(emptyMap());
      setStats([]);
    }
  }, [engineKey]);

  const setOne = useCallback(<K extends ResourceKind>(k: K, patch: Partial<ResourceMap[K]>) => {
    setRes((s) => ({ ...s, [k]: { ...s[k], ...patch } }));
  }, []);

  // Cada lista se lee de todos los dueños que se ven a la vez (un script por elevación); si un usuario
  // falla, se muestra su error y se ven igual los demás.
  const loadOne = useCallback(
    async (k: ResourceKind) => {
      if (!runnable || !elevation) return;
      const key = engineKey;
      setOne(k, { loading: true });
      const inner =
        k === "volumes"
          ? `echo @@tv:all\n${renderCmd(listVolumes(engine))}\necho @@tv:unused\n${renderCmd(listUnusedVolumes(engine))}\necho @@tv:end`
          : scriptFor([{ containers: listContainers, images: listImages, networks: listNetworks, df: systemDf }[k](engine)]);
      const parse = (out: string): object[] => {
        if (k !== "volumes") return { containers: parseContainers, images: parseImages, networks: parseNetworks, df: parseDf }[k](out);
        const s = splitMarked(out);
        return parseVolumes(s.get("all") ?? "", (s.get("unused") ?? "").split("\n"));
      };
      const per = await readOwners(runner, activeOwners, inner, k === "df" ? 90 : 40);
      if (keyRef.current !== key) return;
      let askSudo = false;
      const parts = activeOwners.map((o) => {
        const r = per.get(ownerKey(o));
        if (r?.needSudo) askSudo = true;
        let data: object[] | null = null;
        if (r?.ok && r.result) {
          try {
            data = parse(r.result.stdout);
          } catch {
            data = null;
          }
        }
        return { owner: ownerKey(o), label: label(o), data, error: data === null ? (r?.error ?? "No se pudo leer") : null };
      });
      if (askSudo) setSudoOpen(true);
      const m = mergeOwned(parts);
      if (m.data !== null) setOne(k, { data: m.data as never, loading: false, error: m.error, loadedAt: Date.now() });
      else setOne(k, { loading: false, error: m.error ?? "No se pudo leer" });
    },
    [runnable, elevation, engineKey, engine, setOne, runner, activeOwners, label],
  );

  const reload = useCallback(
    async (...kinds: ResourceKind[]) => {
      await Promise.all(kinds.map((k) => loadOne(k)));
    },
    [loadOne],
  );

  // Carga inicial de lo que necesita la sub-pestaña visible.
  const needed: Record<SubTab, ResourceKind[]> = {
    containers: ["containers"],
    images: ["images", "containers"],
    volumes: ["volumes"],
    networks: ["networks", "containers"],
    compose: ["containers"],
    // Con «Todos» la limpieza pide elegir un usuario: no hace falta calcular el espacio.
    cleanup: all ? [] : ["df", "containers", "images", "volumes"],
  };
  useEffect(() => {
    if (!active || !runnable) return;
    const missing = needed[tab].filter((k) => res[k].loadedAt === 0 && !res[k].loading && !res[k].error);
    if (missing.length) void reload(...missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, runnable, tab, res, reload]);

  // Refresco periódico de la lista de contenedores mientras se ve.
  useEffect(() => {
    if (!active || !runnable || (tab !== "containers" && tab !== "compose")) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadOne("containers");
    }, LIST_MS);
    return () => window.clearInterval(t);
  }, [active, runnable, tab, loadOne]);

  // CPU / memoria cada ~5 s, solo si la pestaña se ve y hay contenedores en marcha (de cada dueño que los tenga).
  const runningBy = [...new Set((res.containers.data ?? []).filter((c) => c.state === "running").map((c) => c.owner ?? currentKey))].sort().join(",");
  const statsBusy = useRef(false);
  useEffect(() => {
    if (!active || !runnable || tab !== "containers" || !runningBy || !elevation) return;
    let stop = false;
    const key = engineKey;
    const owners = runningBy
      .split(",")
      .map((k) => findOwner(activeOwners, k))
      .filter((o): o is CtOwner => !!o);
    const tick = async () => {
      if (stop || statsBusy.current || document.visibilityState !== "visible") return;
      statsBusy.current = true;
      const per = await readOwners(runner, owners, scriptFor([statsOnce(engine)]), 20);
      statsBusy.current = false;
      if (stop || keyRef.current !== key) return;
      const next: ContainerStats[] = [];
      for (const o of owners) {
        const r = per.get(ownerKey(o));
        if (r?.ok && r.result) next.push(...parseStats(r.result.stdout).map((s) => ({ ...s, owner: ownerKey(o) })));
      }
      setStats(next);
    };
    void tick();
    const t = window.setInterval(() => void tick(), STATS_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [active, runnable, tab, runningBy, engine, elevation, engineKey, runner, activeOwners]);

  // ───────── Acciones ─────────
  const run = useCallback(
    async (cmds: Cmd[], timeoutSecs = 120): Promise<EngineRun> => {
      const r = await runOwned(runner, cmds, timeoutSecs);
      if (r.needSudo) setSudoOpen(true);
      return r;
    },
    [runner],
  );

  const runRawAs = useCallback(
    async (owner: string | undefined, script: string, timeoutSecs = 30): Promise<EngineRun> => {
      const o = resolve(owner ?? currentKey);
      if (!o) return { ok: false, result: null, error: "No se encontró ese usuario", needSudo: false };
      const r = (await readOwners(runner, [o], script, timeoutSecs)).get(ownerKey(o));
      if (r?.needSudo) setSudoOpen(true);
      return r ?? { ok: false, result: null, error: "Sin respuesta del servidor", needSudo: false };
    },
    [runner, resolve, currentKey],
  );

  /** Comando tal y como se muestra (y se escribe en la terminal): con sudo o como el dueño. */
  const render = useCallback(
    (c: Cmd) =>
      ownerLine(c, resolve(c.owner ?? currentKey) ?? { kind: "self" }, {
        engine,
        elevPrefix,
        selfPrefix,
        runuser: !!result?.runuser,
      }),
    [resolve, currentKey, engine, elevPrefix, selfPrefix, result?.runuser],
  );

  /** Elevación de unos comandos (null = hace falta sudo y no hay). */
  const elevationOf = useCallback(
    (cmds: Cmd[]): Elevation | null => {
      let out: Elevation = NO_ELEVATION;
      for (const c of cmds) {
        const o = resolve(c.owner ?? currentKey);
        const el = o ? runner.elevationFor(o) : null;
        if (!el) return null;
        if (el.kind !== "none") out = el;
      }
      return out;
    },
    [resolve, currentKey, runner],
  );

  const onReviewFinished = useCallback(
    (req: ReviewRequest, r: EngineRun) => {
      const detail = typeof req.success === "function" ? req.success(r) : req.success;
      const [title, ...rest] = detail.split("\n");
      toast.success(title, rest.join("\n") || undefined);
      if (req.reload?.length) void reload(...req.reload);
      req.onDone?.(r);
    },
    [reload],
  );

  const toTerminal = useCallback(
    (cmd: Cmd, execute: boolean) => {
      if (!hasTerminal(sessionId)) {
        toast.error("No hay ninguna terminal abierta", "Abre una terminal en esta conexión y vuelve a intentarlo");
        return false;
      }
      const ok = sendToTerminal(sessionId, render(cmd), execute);
      if (ok) toast.info("Enviado a la terminal", execute ? "Cambia a la pestaña Terminal para verlo" : "Revisa el comando y pulsa Enter");
      return ok;
    },
    [sessionId, render],
  );

  const choose = (e: Engine) => {
    setEnginePref(e);
    saveEngine(profileId, e);
  };
  const chooseOwner = (v: string) => {
    setChoice(v);
    saveOwnerChoice(profileId, v);
  };
  const ownerLabel = useCallback((k: string | undefined) => {
    const o = resolve(k ?? currentKey);
    return o ? label(o) : (k ?? "").replace(/^u:/, "");
  }, [resolve, currentKey, label]);

  const ctx: CtContextValue | null = useMemo(() => {
    if (!status || !result) return null;
    return {
      sessionId,
      profileId,
      disabled,
      active,
      engine,
      status,
      detect: result,
      composeTools: status.compose,
      elevation,
      needsSudo,
      prefix,
      res,
      stats,
      reload,
      run,
      runRawAs,
      review: setReview,
      askSudo: () => setSudoOpen(true),
      openLogs: setLogs,
      openInspect: setInspectC,
      openRunForm: (prefill, owner) => setRunForm({ prefill, owner }),
      toTerminal,
      render,
      owners: activeOwners,
      allOwners: all,
      newOwner: all ? null : currentKey,
      ownerLabel,
      ownerIsRoot: (k) => {
        const o = resolve(k ?? currentKey);
        return !!o && ownerIsRoot(o, isRoot);
      },
      perOwner: (items, build) => perOwner(items, currentKey, build),
    };
  }, [
    status,
    result,
    sessionId,
    profileId,
    disabled,
    active,
    engine,
    elevation,
    needsSudo,
    prefix,
    res,
    stats,
    reload,
    run,
    runRawAs,
    toTerminal,
    render,
    activeOwners,
    all,
    currentKey,
    ownerLabel,
    resolve,
    isRoot,
  ]);

  // ───────── Render ─────────
  if (disabled && !result) {
    return (
      <div className="ct-root">
        <div className="empty-state">
          <Boxes size={28} />
          <div>Sin conexión con el servidor</div>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="ct-root">
        <div className="empty-state">
          {det.error ? (
            <>
              <ShieldAlert size={28} />
              <div>{det.error}</div>
              <button className="btn btn-sm" onClick={() => void detect()} disabled={disabled}>
                <RefreshCw size={13} /> Reintentar
              </button>
            </>
          ) : (
            <>
              <span className="spinner" />
              <div>Buscando Podman y Docker en el servidor…</div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!status || !ctx) {
    return (
      <div className="ct-root">
        <NoEngine info={info} dockerIsShim={result.dockerIsShim} onRetry={() => void detect()} busy={det.loading} sessionId={sessionId} />
      </div>
    );
  }

  const canStartService = engine === "docker" && status.serviceDown;
  const sudoMissing = needsSudo && !elevation;

  return (
    <CtContext.Provider value={ctx}>
      <div className="ct-root">
        <div className="ct-header">
          {available.length > 1 ? (
            <div className="ct-seg" role="radiogroup" aria-label="Motor de contenedores">
              {available.map((s) => (
                <button
                  key={s.engine}
                  role="radio"
                  aria-checked={s.engine === engine}
                  className={s.engine === engine ? "on" : ""}
                  onClick={() => choose(s.engine)}
                >
                  {s.engine === "podman" ? "Podman" : "Docker"}
                </button>
              ))}
            </div>
          ) : (
            <strong className="ct-engine-name">{engine === "podman" ? "Podman" : "Docker"}</strong>
          )}
          <span className="faint ct-ver">{status.version ? `v${status.version}` : ""}</span>
          {canElevate && (options.length > 1 || waitingUsers) && (
            <label className="ct-owner" title="Con root o sudo puedes ver los contenedores de root y los de cada usuario">
              <Users size={13} />
              <span>Usuario</span>
              <select
                className="select ct-select-sm"
                value={all ? OWNER_ALL : current ? currentKey : effChoice}
                onChange={(e) => chooseOwner(e.target.value)}
                aria-label="De qué usuario se ven los contenedores"
              >
                {options.map((o) => (
                  <option key={ownerKey(o)} value={ownerKey(o)}>
                    {o.kind === "self"
                      ? isRoot
                        ? "root"
                        : engine === "docker" && !status.rootless
                          ? "Docker del sistema"
                          : `${me ?? "tu usuario"} (tú)`
                      : o.kind === "root"
                        ? "root (sistema)"
                        : `${o.user.name}${o.user.runtimeDir ? "" : " · sin sesión abierta"}`}
                  </option>
                ))}
                {!all && !current && effChoice.startsWith("u:") && <option value={effChoice}>{effChoice.slice(2)}</option>}
                <option value={OWNER_ALL}>Todos</option>
              </select>
              {usersLoad.loading && <span className="spinner ct-spinner-xs" aria-label="Buscando usuarios" />}
              {usersLoad.error && (
                <span className="ct-badge ct-badge-warn" title={usersLoad.error}>
                  sin lista de usuarios
                </span>
              )}
            </label>
          )}
          {!all && current && (current.kind === "user" || (current.kind === "self" && status.rootless)) && <span className="ct-badge">rootless</span>}
          {needsSudo && <span className="ct-badge ct-badge-warn">{elevation ? elev.label : "necesita sudo"}</span>}
          {composeFor(engine, status.compose) && <span className="ct-badge">{composeFor(engine, status.compose)}</span>}
          <span className="ct-grow" />
          <button
            className="icon-btn"
            title="Volver a detectar (y a buscar usuarios)"
            aria-label="Volver a detectar"
            onClick={() => {
              void detect();
              if (canElevate && otherEl && (usersView || usersLoad.error)) void loadUsers();
            }}
            disabled={det.loading || disabled}
          >
            <RefreshCw size={14} className={det.loading ? "ct-spin" : undefined} />
          </button>
        </div>

        {(sudoMissing || canStartService || (!status.accessible && !needsSudo)) && (
          <div className="ct-banner" role="status">
            <ShieldAlert size={15} />
            <div className="ct-banner-text">
              <strong>
                {(dockerSelfSudo && status.problem) ||
                  (all
                    ? "Ver los contenedores de todos los usuarios necesita sudo"
                    : current?.kind === "root"
                      ? "Los contenedores del sistema necesitan sudo"
                      : current?.kind === "user" || waitingUsers
                        ? "Ver los contenedores de otro usuario necesita sudo"
                        : (status.problem ?? "Hace falta sudo"))}
              </strong>
              {sudoMissing && (
                <span>
                  {elev.readOnlyReason && !elev.canAskSudo
                    ? elev.readOnlyReason
                    : "Introduce tu contraseña de sudo para usarlo desde aquí (se guarda solo en memoria)."}
                  {engine === "docker" && result.dockerGroupExists && !result.inDockerGroup && (
                    <> También puedes añadir tu usuario al grupo «docker» (después hay que reconectar).</>
                  )}
                </span>
              )}
              {status.rawError && <code className="ct-raw">{status.rawError}</code>}
            </div>
            {sudoMissing && elev.canAskSudo && (
              <button className="btn btn-sm btn-primary" onClick={() => setSudoOpen(true)}>
                <KeyRound size={13} /> Contraseña de sudo
              </button>
            )}
            {dockerSelfSudo && result.dockerGroupExists && !result.inDockerGroup && (elev.elevation || elev.canAskSudo) && (
              <button
                className="btn btn-sm"
                onClick={() =>
                  setReview({
                    title: "Añadir mi usuario al grupo docker",
                    message: (
                      <>
                        Con esto podrás usar Docker sin sudo. El cambio se aplica en la <strong>próxima conexión</strong>. Ojo: estar en el
                        grupo «docker» equivale en la práctica a tener acceso de root.
                      </>
                    ),
                    build: () => [{ bin: ["usermod"], args: ["-aG", "docker", info?.user ?? ""] }],
                    elevationOverride: elev.elevation,
                    success: "Usuario añadido al grupo docker\nReconecta para que tenga efecto",
                  })
                }
                disabled={!info?.user}
                title={dockerGroupCommand(info?.user ?? null)}
              >
                <Users size={13} /> Añadir al grupo docker
              </button>
            )}
            {canStartService && (
              <button
                className="btn btn-sm"
                onClick={() =>
                  setReview({
                    title: "Iniciar el servicio Docker",
                    message: "Arranca Docker y lo deja activado para que se inicie con el servidor.",
                    build: () => [{ bin: ["systemctl"], args: ["enable", "--now", "docker"] }],
                    elevationOverride: isRoot ? { kind: "none" } : elev.elevation,
                    success: "Servicio Docker iniciado",
                    onDone: () => void detect(),
                  })
                }
              >
                <Play size={13} /> Iniciar Docker
              </button>
            )}
          </div>
        )}

        <div className="ct-tabs" role="tablist" aria-label="Secciones">
          {SUBTABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "ct-tab on" : "ct-tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "containers" && res.containers.data && <span className="ct-count">{res.containers.data.length}</span>}
              {t.id === "images" && res.images.data && <span className="ct-count">{res.images.data.length}</span>}
            </button>
          ))}
        </div>

        <div className="ct-body">
          {!runnable ? (
            <div className="empty-state">
              {waitingUsers && !sudoMissing ? <span className="spinner" /> : <ShieldAlert size={26} />}
              <div>
                {sudoMissing
                  ? "Introduce la contraseña de sudo para ver los contenedores"
                  : waitingUsers
                    ? "Buscando usuarios con contenedores…"
                    : (status.problem ?? "No se puede usar el motor")}
              </div>
            </div>
          ) : (
            <Suspense fallback={<div className="empty-state"><span className="spinner" /></div>}>
              {tab === "containers" && <ContainersTab />}
              {tab === "images" && <ImagesTab />}
              {tab === "volumes" && <VolumesTab />}
              {tab === "networks" && <NetworksTab />}
              {tab === "compose" && <ComposeTab />}
              {tab === "cleanup" && <CleanupTab />}
            </Suspense>
          )}
        </div>

        <Suspense fallback={null}>
          {logs && <LogsDialog target={logs} onClose={() => setLogs(null)} />}
          {inspectC && <InspectDialog container={inspectC} onClose={() => setInspectC(null)} />}
          {runForm && <RunDialog prefill={runForm.prefill} owner={runForm.owner} onClose={() => setRunForm(null)} />}
        </Suspense>
        {review && (
          <ReviewDialog
            req={review}
            sessionId={sessionId}
            exec={run}
            elevationOf={elevationOf}
            render={render}
            fullScript={(cmds) => ownedFullScript(runner, cmds)}
            who={(cmds) => {
              const names = [...new Set(cmds.map((c) => c.owner ?? currentKey))].filter((k) => k !== OWNER_SELF).map(ownerLabel);
              return names.length ? names.join(", ") : null;
            }}
            disabled={disabled}
            onAskSudo={() => setSudoOpen(true)}
            onClose={() => setReview(null)}
            onFinished={onReviewFinished}
          />
        )}
        {sudoOpen && (
          <SudoDialog sessionId={sessionId} profileId={profileId} user={info?.user ?? null} onClose={() => setSudoOpen(false)} />
        )}
      </div>
    </CtContext.Provider>
  );
}
