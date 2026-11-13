// «Actualizar imagen» (escáner → hallazgo de una imagen de Podman o Docker).
// 1. Lee en el momento (inspect, como el dueño) qué contenedores usan la imagen y cómo se crearon.
// 2. Muestra el plan y los comandos exactos; no se ejecuta nada sin confirmar.
// 3. Ejecuta paso a paso (descarga, Compose, systemd), con su salida y «Cancelar».
// 4. Contenedores creados con `run`: formulario «Nuevo contenedor» relleno, en modo «reemplazar».
// 5. Vuelve a analizar la imagen y dice si siguen las vulnerabilidades.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CircleSlash, KeyRound, Loader2, Play, RefreshCw, SkipForward, Square } from "lucide-react";
import { errorMessage } from "../../api/core";
import type { ExecResult } from "../../api/types";
import type { Report, Target, UserCtx } from "../../api/vulnscan";
import { displayCmds, emptyRunForm, failureMessage, validateRunForm, type RunForm } from "../../features/containers";
import { renderCmd } from "../../features/containers/shell";
import { ElevationError } from "../../features/admin/run";
import { wrapScript } from "../../features/privileges";
import {
  elevationFor,
  ownerCtx,
  ownerIsRoot,
  ownerLabel,
  ownerOf,
  ownerScript,
  parseRead,
  planUpdate,
  readScript,
  replaceScript,
  rescanImage,
  rescanMessage,
  runAsOwner,
  runFormFrom,
  stepScript,
  UpdateCancel,
  UpdateCanceled,
  updatableTag,
  useVulnScan,
  type Group,
  type ImageConfig,
  type RescanResult,
  type UpdatePlan,
} from "../../features/vulnscan";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { RunFormFields } from "../Containers/RunFormFields";
import { AdmModal } from "./AdmModal";
import { useAdmin } from "./context";
import "../Containers/Containers.css";

type Stage = "read" | "review" | "running" | "replace" | "rescan" | "done";
type StepStatus = "pending" | "running" | "ok" | "error" | "skipped";

interface StepView {
  label: string;
  status: StepStatus;
  output: string;
}

type RunGroup = Extract<Group, { kind: "run" }>;

/** Últimas líneas de la salida de un comando. */
function tail(r: ExecResult | null, lines = 40): string {
  if (!r) return "";
  const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
  return text.split("\n").slice(-lines).join("\n");
}

function StepIcon({ s }: { s: StepStatus }) {
  switch (s) {
    case "ok":
      return <Check size={13} className="vs-ph-ok" />;
    case "running":
      return <Loader2 size={13} className="adm-spin" />;
    case "error":
      return <AlertTriangle size={13} className="vs-ph-error" />;
    case "skipped":
      return <CircleSlash size={13} className="faint" />;
    default:
      return <span className="vs-ph-dot" />;
  }
}

function GroupLine({ g }: { g: Group }) {
  switch (g.kind) {
    case "compose":
      return (
        <li>
          <strong>Compose</strong> «{g.project}» <span className="faint mono">({g.dir})</span>: se recrean {g.containers.join(", ")}
        </li>
      );
    case "systemd":
      return (
        <li>
          <strong>systemd</strong> «{g.unit}»{g.user ? " (de usuario)" : ""}: se reinicia y recrea {g.containers.join(", ")}
        </li>
      );
    case "run":
      return (
        <li>
          <strong>Creado a mano</strong>: {g.container.name}. Después de descargar se abre el formulario para revisarlo y confirmar.
        </li>
      );
    case "manual":
      return (
        <li className="vs-up-manual">
          <strong>A mano</strong>: {g.containers.join(", ")}. {g.reason}.
        </li>
      );
  }
}

export function ImageUpdateDialog({ report, target, onClose }: { report: Report; target: Target; onClose: () => void }) {
  const { sessionId, elevation, me, info, askSudo, disabled } = useAdmin();
  const settings = useSettings((s) => s.settings.vulnscan);
  const connectedAsRoot = info?.level === "root";
  const owner = useMemo(() => ownerOf(target, me, connectedAsRoot), [target, me, connectedAsRoot]);
  const engine = target.image?.engine ?? "podman";
  const tag = updatableTag(target) ?? "";
  const el = elevationFor(owner, elevation);
  const who = ownerLabel(owner, me);

  const cancel = useRef(new UpdateCancel());
  const [stage, setStage] = useState<Stage>("read");
  const [user, setUser] = useState<UserCtx | null>(null);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [full, setFull] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needSudo, setNeedSudo] = useState(false);
  const [steps, setSteps] = useState<StepView[]>([]);
  const [runIdx, setRunIdx] = useState(0);
  const [imageCfg, setImageCfg] = useState<ImageConfig | null>(null);
  const [form, setForm] = useState<RunForm>(emptyRunForm);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<RescanResult | null>(null);
  const [replaced, setReplaced] = useState<string[]>([]);

  // El informe nuevo se pone en pantalla al cerrar: si se pusiera antes, el hallazgo (de la imagen
  // vieja) desaparece y con él este diálogo.
  const newReport = useRef<Report | null>(null);
  useEffect(
    () => () => {
      if (newReport.current) useVulnScan.getState().setReport(sessionId, newReport.current);
    },
    [sessionId],
  );

  const runGroups = useMemo(() => (plan?.groups.filter((g) => g.kind === "run") ?? []) as RunGroup[], [plan]);
  const current = runGroups[runIdx] ?? null;

  /** Muestra un error (y el botón de sudo si hace falta). */
  const fail = (e: unknown) => {
    if (e instanceof UpdateCanceled) {
      setError("Cancelado.");
      return;
    }
    setError(e instanceof ElevationError ? e.message : errorMessage(e));
    setNeedSudo(e instanceof ElevationError && (e.failure === "need-password" || e.failure === "bad-password"));
  };

  // 1. Lectura (se repite si cambia la elevación, p. ej. tras escribir la contraseña de sudo).
  useEffect(() => {
    if (!el || disabled || stage !== "read") return;
    let alive = true;
    const c = new UpdateCancel();
    cancel.current = c;
    setError(null);
    setNeedSudo(false);
    (async () => {
      const u = await ownerCtx(sessionId, owner, el);
      const r = await runAsOwner(sessionId, engine, u, el, readScript(engine, target.image!.id), 60, c);
      const read = parseRead(r.stdout, target.image!.id);
      if (!read.complete) throw new Error(failureMessage(r));
      const p = planUpdate({ engine, tag, tags: target.image!.tags, read, ownerIsRoot: ownerIsRoot(owner, connectedAsRoot) });
      const script = await ownerScript(engine, u, p.steps.map(stepScript).join("\n"));
      if (!alive) return;
      setUser(u);
      setImageCfg(read.image);
      setPlan(p);
      setFull(wrapScript(script, el));
      setStage("review");
    })().catch((e) => alive && fail(e));
    return () => {
      alive = false;
      void c.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el?.kind, disabled, stage === "read"]);

  // 5. Volver a analizar.
  const rescan = useCallback(async () => {
    if (!el) return;
    setStage("rescan");
    setError(null);
    setProgress("Volviendo a analizar la imagen…");
    const c = new UpdateCancel();
    cancel.current = c;
    try {
      const r = await rescanImage({
        sessionId,
        report,
        target,
        tag,
        engine,
        user,
        el,
        useOsv: settings.useOsv,
        useTrivy: settings.useTrivy,
        cancel: c,
        onProgress: setProgress,
      });
      newReport.current = r.report;
      setResult(r);
      if (r.remaining > 0) toast.info("Imagen actualizada", rescanMessage(r.remaining));
      else toast.success("Imagen actualizada", rescanMessage(0));
    } catch (e) {
      fail(e);
    } finally {
      setStage("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, sessionId, report, target, tag, engine, user, settings.useOsv, settings.useTrivy]);

  /** Prepara el formulario del contenedor «run» número `i` (o pasa a volver a analizar). */
  const openReplace = (i: number) => {
    const g = runGroups[i];
    setRunIdx(i);
    setError(null);
    setTouched(false);
    if (!g) {
      void rescan();
      return;
    }
    const { form: f, warnings: w } = runFormFrom(g.container, imageCfg, g.ref, engine);
    setForm(f);
    setWarnings(w);
    setStage("replace");
  };

  // 3. Pasos automáticos.
  const start = async () => {
    if (!plan || !el) return;
    setStage("running");
    setError(null);
    setNeedSudo(false);
    const c = new UpdateCancel();
    cancel.current = c;
    const views: StepView[] = plan.steps.map((s) => ({ label: s.label, status: "pending", output: "" }));
    setSteps(views);
    const patch = (i: number, v: Partial<StepView>) => setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...v } : s)));
    for (let i = 0; i < plan.steps.length; i++) {
      patch(i, { status: "running" });
      try {
        const r = await runAsOwner(sessionId, engine, user, el, stepScript(plan.steps[i]), 900, c);
        if (r.exitCode !== 0 || r.timedOut) {
          patch(i, { status: "error", output: tail(r) });
          setError(failureMessage(r));
          for (let j = i + 1; j < plan.steps.length; j++) patch(j, { status: "skipped" });
          return;
        }
        patch(i, { status: "ok", output: tail(r, 12) });
      } catch (e) {
        patch(i, { status: "error" });
        for (let j = i + 1; j < plan.steps.length; j++) patch(j, { status: "skipped" });
        fail(e);
        return;
      }
    }
    openReplace(0);
  };

  // 4. Reemplazar un contenedor creado con `run`.
  const replace = async () => {
    if (!current || !el) return;
    setTouched(true);
    if (Object.keys(validateRunForm(form)).length) return;
    setBusy(true);
    setError(null);
    const c = new UpdateCancel();
    cancel.current = c;
    try {
      const r = await runAsOwner(sessionId, engine, user, el, replaceScript(engine, current.container.name, current.container.running, form), 900, c);
      if (r.exitCode !== 0 || r.timedOut) {
        setError(`${failureMessage(r)}\n\n${tail(r, 30)}`.trim());
        return;
      }
      setReplaced((x) => [...x, current.container.name]);
      toast.success("Contenedor reemplazado", current.container.name);
      openReplace(runIdx + 1);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const running = busy || stage === "rescan" || ((stage === "running" || stage === "read") && !!el && !error);
  const close = () => {
    if (running) return;
    onClose();
  };
  const shownCmds = plan ? plan.steps.flatMap((s) => s.cmds) : [];
  const shown =
    owner.kind === "root" && el ? displayCmds(shownCmds, el) : shownCmds.map((c) => renderCmd(c));
  const howText =
    owner.kind === "user"
      ? `Se ejecutará como «${who}» (TerView entra como ese usuario con sudo, igual que al analizar):`
      : owner.kind === "root"
        ? "Se ejecutará como root:"
        : "Se ejecutará con tu usuario:";
  const errors = validateRunForm(form);
  const replacePreview = current ? replaceScript(engine, current.container.name, current.container.running, form) : "";

  return (
    <AdmModal title={stage === "replace" && current ? `Reemplazar contenedor «${current.container.name}»` : "Actualizar imagen"} onClose={close} width={stage === "replace" ? 760 : 640}>
      <div className="modal-body vs-up">
        <div className="vs-up-head">
          <span className="mono">{tag}</span>
          <span className="faint">
            {engine} · de {who}
          </span>
        </div>

        {!el && (
          <div className="ct-warn">
            La imagen es de {who}: hace falta sudo para actualizarla.{" "}
            <button className="btn btn-sm" onClick={askSudo}>
              <KeyRound size={13} /> Introducir contraseña de sudo
            </button>
          </div>
        )}

        {stage === "read" && el && !error && (
          <div className="vs-up-progress">
            <Loader2 size={14} className="adm-spin" /> Leyendo los contenedores que usan la imagen…
          </div>
        )}

        {plan && (stage === "review" || stage === "running") && (
          <>
            {plan.groups.length > 0 && (
              <ul className="vs-up-groups">
                {plan.groups.map((g, i) => (
                  <GroupLine key={i} g={g} />
                ))}
              </ul>
            )}
            {plan.recreated.length > 0 && (
              <p className="vs-up-recreate">
                Se recrean: <strong>{plan.recreated.join(", ")}</strong>
              </p>
            )}
            {plan.notes.map((n) => (
              <p key={n} className="vs-d-note">
                {n}
              </p>
            ))}
          </>
        )}

        {plan && stage === "review" && (
          <>
            <div className="ct-review-label">{howText}</div>
            <pre className="ct-cmd" aria-label="Comandos que se ejecutarán">
              {shown.join("\n")}
            </pre>
            <details className="ct-details">
              <summary>Script completo enviado al servidor</summary>
              <pre className="ct-cmd ct-cmd-sm">{full}</pre>
            </details>
          </>
        )}

        {steps.length > 0 && (stage === "running" || stage === "replace" || stage === "rescan" || stage === "done") && (
          <ul className="vs-up-steps" aria-live="polite">
            {steps.map((s, i) => (
              <li key={i} className={`vs-ph-${s.status}`}>
                <div className="vs-up-step">
                  <StepIcon s={s.status} /> <span>{s.label}</span>
                </div>
                {s.output && (s.status === "error" || stage === "running") && <pre className="ct-cmd ct-cmd-sm">{s.output}</pre>}
              </li>
            ))}
            {replaced.map((n) => (
              <li key={`r-${n}`} className="vs-ph-ok">
                <div className="vs-up-step">
                  <Check size={13} /> <span>Reemplazado: {n}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {stage === "replace" && current && (
          <form
            className="ct-form"
            onSubmit={(e) => {
              e.preventDefault();
              void replace();
            }}
          >
            <p className="vs-d-note">
              Revisa lo que se copió del contenedor. Al confirmar: el viejo pasa a llamarse «{current.container.name}-viejo» y se para; se crea
              el nuevo con el nombre original. Si el nuevo arranca bien se borra el viejo; si falla, se borra el nuevo y vuelve el viejo.
            </p>
            {warnings.length > 0 && (
              <div className="ct-warn">
                <strong>No se copia (revísalo):</strong>
                <ul className="ct-list">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <RunFormFields
              f={form}
              setF={setForm}
              engine={engine}
              errors={errors}
              touched={touched}
              imageTags={target.image?.tags ?? []}
              volumeNames={current.container.mounts.filter((m) => m.type === "volume" && m.name).map((m) => m.name)}
              networkNames={current.container.networks}
              lingerHint={engine === "podman" && owner.kind !== "root" && !connectedAsRoot}
              nameLocked
            />
            <div className="ct-review-label">{howText}</div>
            <pre className="ct-cmd ct-cmd-sm">{replacePreview}</pre>
          </form>
        )}

        {stage === "rescan" && (
          <div className="vs-up-progress">
            <Loader2 size={14} className="adm-spin" /> {progress}
          </div>
        )}

        {stage === "done" && result && (
          <div className={result.remaining > 0 ? "ct-warn" : "vs-up-ok"} role="status">
            {rescanMessage(result.remaining)}
          </div>
        )}

        {error && (
          <div className="ct-error" role="alert">
            <AlertTriangle size={14} />
            <pre>{error}</pre>
          </div>
        )}
        {needSudo && (
          <button className="btn btn-sm" onClick={askSudo}>
            <KeyRound size={13} /> Introducir contraseña de sudo
          </button>
        )}
      </div>

      <div className="modal-footer">
        {running ? (
          <button className="btn" onClick={() => void cancel.current.cancel()}>
            <Square size={13} /> Cancelar
          </button>
        ) : stage === "replace" && current ? (
          <>
            <button className="btn" onClick={() => openReplace(runIdx + 1)} title="No se toca este contenedor (seguirá con la imagen vieja)">
              <SkipForward size={13} /> Saltar este
            </button>
            <button className="btn btn-primary" onClick={() => void replace()} disabled={touched && Object.keys(errors).length > 0}>
              <Play size={13} /> {error ? "Reintentar" : "Reemplazar"}
            </button>
          </>
        ) : stage === "review" ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn btn-primary" onClick={() => void start()} disabled={!el || disabled} autoFocus>
              <Play size={13} /> Actualizar imagen
            </button>
          </>
        ) : (
          <>
            {(stage === "done" || (stage === "running" && error)) && (
              <button className="btn" onClick={() => void rescan()} disabled={!el || disabled} title="Vuelve a analizar solo esta imagen">
                <RefreshCw size={13} /> Volver a escanear
              </button>
            )}
            <button className="btn btn-primary" onClick={onClose}>
              Cerrar
            </button>
          </>
        )}
      </div>
    </AdmModal>
  );
}
