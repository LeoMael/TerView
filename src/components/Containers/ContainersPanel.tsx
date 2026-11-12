// Pestaña «Contenedores» de una conexión: administrador visual de Podman / Docker.
// Detecta el motor, decide si hace falta sudo y reparte el trabajo entre sub-pestañas
// (Contenedores, Imágenes, Volúmenes, Redes, Compose, Limpieza). Todo por el canal exec.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, KeyRound, Play, RefreshCw, ShieldAlert, Users } from "lucide-react";
import {
  DETECT_SCRIPT,
  composeFor,
  dockerGroupCommand,
  listContainers,
  listImages,
  listNetworks,
  listUnusedVolumes,
  listVolumes,
  loadEngine,
  loadPodmanRoot,
  parseContainers,
  parseDetect,
  parseDf,
  parseImages,
  parseNetworks,
  parseStats,
  parseVolumes,
  renderCmd,
  runEngine,
  runRaw,
  saveEngine,
  savePodmanRoot,
  splitMarked,
  statsOnce,
  systemDf,
  displayPrefix,
  elevationPrefix,
  type Cmd,
  type Container,
  type ContainerStats,
  type DetectResult,
  type Engine,
  type EngineRun,
  type EngineStatus,
  type RunForm,
} from "../../features/containers";
import { usePrivilege, useElevation, useStoredSudo, useStoredSudoState, type Elevation } from "../../features/privileges";
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
  const [podmanRoot, setPodmanRoot] = useState(() => loadPodmanRoot(profileId));
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
  const [runForm, setRunForm] = useState<{ prefill?: Partial<RunForm> } | null>(null);

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

  // ───────── Elevación ─────────
  const isRoot = result?.uid === 0 || info?.level === "root";
  const needsSudo = !!status && !isRoot && (engine === "docker" ? status.needsSudo : podmanRoot);
  const elevation: Elevation | null = useMemo(() => (needsSudo ? elev.elevation : NO_ELEVATION), [needsSudo, elev.elevation]);
  const prefix = elevation ? elevationPrefix(elevation) : needsSudo ? "sudo " : "";
  const runnable = !!status && !!elevation && !disabled && (status.accessible || needsSudo);
  const engineKey = `${engine}|${needsSudo ? "root" : "user"}|${elevation?.kind ?? "none"}`;

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

  const loadOne = useCallback(
    async (k: ResourceKind) => {
      if (!runnable || !elevation) return;
      const key = engineKey;
      setOne(k, { loading: true });
      let r: EngineRun;
      let data: unknown = null;
      if (k === "volumes") {
        const script = `echo @@tv:all\n${renderCmd(listVolumes(engine))}\necho @@tv:unused\n${renderCmd(listUnusedVolumes(engine))}\necho @@tv:end`;
        r = await runRaw(sessionId, script, elevation, 40);
        if (r.result && r.result.exitCode === 0) {
          const s = splitMarked(r.result.stdout);
          data = parseVolumes(s.get("all") ?? "", (s.get("unused") ?? "").split("\n"));
        }
      } else {
        const cmd: Cmd = {
          containers: listContainers,
          images: listImages,
          networks: listNetworks,
          df: systemDf,
        }[k](engine);
        r = await runEngine(sessionId, [cmd], elevation, k === "df" ? 90 : 40);
        if (r.ok && r.result) {
          const out = r.result.stdout;
          data = { containers: parseContainers, images: parseImages, networks: parseNetworks, df: parseDf }[k](out);
        }
      }
      if (keyRef.current !== key) return;
      if (r.needSudo) setSudoOpen(true);
      if (data !== null) setOne(k, { data: data as never, loading: false, error: null, loadedAt: Date.now() });
      else setOne(k, { loading: false, error: r.error ?? "No se pudo leer" });
    },
    [runnable, elevation, engineKey, engine, sessionId, setOne],
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
    cleanup: ["df", "containers", "images", "volumes"],
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

  // CPU / memoria cada ~5 s, solo si la pestaña se ve y hay contenedores en marcha.
  const running = (res.containers.data ?? []).filter((c) => c.state === "running").length;
  const statsBusy = useRef(false);
  useEffect(() => {
    if (!active || !runnable || tab !== "containers" || running === 0 || !elevation) return;
    let stop = false;
    const key = engineKey;
    const tick = async () => {
      if (stop || statsBusy.current || document.visibilityState !== "visible") return;
      statsBusy.current = true;
      const r = await runEngine(sessionId, [statsOnce(engine)], elevation, 20);
      statsBusy.current = false;
      if (!stop && keyRef.current === key && r.ok && r.result) setStats(parseStats(r.result.stdout));
    };
    void tick();
    const t = window.setInterval(() => void tick(), STATS_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [active, runnable, tab, running, engine, elevation, engineKey, sessionId]);

  // ───────── Acciones ─────────
  const run = useCallback(
    async (cmds: Cmd[], timeoutSecs = 120): Promise<EngineRun> => {
      if (!elevation) {
        setSudoOpen(true);
        return { ok: false, result: null, error: "Hace falta sudo", needSudo: true };
      }
      const r = await runEngine(sessionId, cmds, elevation, timeoutSecs);
      if (r.needSudo) setSudoOpen(true);
      return r;
    },
    [elevation, sessionId],
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
      const ok = sendToTerminal(sessionId, displayPrefix(prefix, cmd), execute);
      if (ok) toast.info("Enviado a la terminal", execute ? "Cambia a la pestaña Terminal para verlo" : "Revisa el comando y pulsa Enter");
      return ok;
    },
    [sessionId, prefix],
  );

  const choose = (e: Engine) => {
    setEnginePref(e);
    saveEngine(profileId, e);
  };
  const setRootMode = (v: boolean) => {
    setPodmanRoot(v);
    savePodmanRoot(profileId, v);
  };

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
      review: setReview,
      askSudo: () => setSudoOpen(true),
      openLogs: setLogs,
      openInspect: setInspectC,
      openRunForm: (prefill) => setRunForm({ prefill }),
      toTerminal,
      render: (c) => displayPrefix(prefix, c),
    };
  }, [status, result, sessionId, profileId, disabled, active, engine, elevation, needsSudo, prefix, res, stats, reload, run, toTerminal]);

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
          {engine === "podman" && !isRoot && (
            <div className="ct-seg ct-seg-sm" role="radiogroup" aria-label="Modo de Podman">
              <button
                role="radio"
                aria-checked={!podmanRoot}
                className={!podmanRoot ? "on" : ""}
                onClick={() => setRootMode(false)}
                title="Contenedores de tu usuario (rootless)"
              >
                Mi usuario
              </button>
              <button
                role="radio"
                aria-checked={podmanRoot}
                className={podmanRoot ? "on" : ""}
                onClick={() => setRootMode(true)}
                title="Contenedores del sistema (root, con sudo)"
                disabled={!info?.hasSudo && info?.level !== "sudo-nopasswd"}
              >
                Sistema (root)
              </button>
            </div>
          )}
          {engine === "podman" && status.rootless && !podmanRoot && <span className="ct-badge">rootless</span>}
          {engine === "docker" && status.rootless && <span className="ct-badge">rootless</span>}
          {needsSudo && <span className="ct-badge ct-badge-warn">{elevation ? elev.label : "necesita sudo"}</span>}
          {composeFor(engine, status.compose) && <span className="ct-badge">{composeFor(engine, status.compose)}</span>}
          <span className="ct-grow" />
          <button className="icon-btn" title="Volver a detectar" aria-label="Volver a detectar" onClick={() => void detect()} disabled={det.loading || disabled}>
            <RefreshCw size={14} className={det.loading ? "ct-spin" : undefined} />
          </button>
        </div>

        {(sudoMissing || canStartService || (!status.accessible && !needsSudo)) && (
          <div className="ct-banner" role="status">
            <ShieldAlert size={15} />
            <div className="ct-banner-text">
              <strong>{status.problem ?? (podmanRoot ? "Los contenedores del sistema necesitan sudo" : "Hace falta sudo")}</strong>
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
            {engine === "docker" && needsSudo && result.dockerGroupExists && !result.inDockerGroup && (elev.elevation || elev.canAskSudo) && (
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
              <ShieldAlert size={26} />
              <div>{sudoMissing ? "Introduce la contraseña de sudo para ver los contenedores" : (status.problem ?? "No se puede usar el motor")}</div>
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
          {runForm && <RunDialog prefill={runForm.prefill} onClose={() => setRunForm(null)} />}
        </Suspense>
        {review && (
          <ReviewDialog
            req={review}
            sessionId={sessionId}
            elevation={elevation}
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
