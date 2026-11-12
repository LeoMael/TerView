// GitHub Actions: últimos workflows de un repo y lanzar uno con workflow_dispatch.
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, CircleSlash, Play, RefreshCw, XCircle } from "lucide-react";
import { github, type GhRepo, type GhRun, type GhWorkflow } from "../../api/github";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { useGitHub } from "../../features/github/store";
import { validateBranch } from "../../features/github/shell";
import { Card, ErrorBox, Link, NeedAccount, RepoPicker, SectionHead, formatDate } from "./parts";

function RunState({ run }: { run: GhRun }) {
  if (run.status !== "completed") {
    return (
      <span className="gh-state gh-state-run">
        <CircleDashed size={14} /> {run.status === "queued" ? "En cola" : "En curso"}
      </span>
    );
  }
  switch (run.conclusion) {
    case "success":
      return (
        <span className="gh-state gh-state-ok">
          <CheckCircle2 size={14} /> Correcto
        </span>
      );
    case "failure":
    case "timed_out":
    case "startup_failure":
      return (
        <span className="gh-state gh-state-bad">
          <XCircle size={14} /> Fallido
        </span>
      );
    case "cancelled":
      return (
        <span className="gh-state">
          <CircleSlash size={14} /> Cancelado
        </span>
      );
    default:
      return <span className="gh-state">{run.conclusion ?? "—"}</span>;
  }
}

function RepoActions({ repo }: { repo: GhRepo }) {
  const [runs, setRuns] = useState<GhRun[] | null>(null);
  const [workflows, setWorkflows] = useState<GhWorkflow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [ref, setRef] = useState(repo.defaultBranch);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, w] = await Promise.all([github.runs(repo.owner, repo.name, 20), github.workflows(repo.owner, repo.name)]);
      setRuns(r);
      setWorkflows(w);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    setRuns(null);
    setWorkflows(null);
    setRef(repo.defaultBranch);
    void load();
  }, [repo, load]);

  // Mientras haya ejecuciones en curso, refrescamos cada 15 s.
  const active = runs?.some((r) => r.status !== "completed") ?? false;
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(t);
  }, [active, load]);

  const wfName = (id: number) => workflows?.find((w) => w.id === id)?.name;

  const dispatch = async (w: GhWorkflow) => {
    const bad = validateBranch(ref);
    if (bad) {
      toast.error(bad);
      return;
    }
    const ok = await confirmDialog({
      title: `¿Ejecutar «${w.name}»?`,
      message: (
        <>
          Se lanzará en la rama <span className="mono">{ref}</span>. El workflow debe tener{" "}
          <span className="mono">on: workflow_dispatch</span>.
        </>
      ),
      confirmText: "Ejecutar",
    });
    if (!ok) return;
    try {
      await github.dispatch(repo.owner, repo.name, w.id, ref);
      toast.success("Workflow lanzado", "Aparecerá en la lista en unos segundos");
      window.setTimeout(() => void load(), 4000);
    } catch (e) {
      toast.error("No se pudo lanzar el workflow", e);
    }
  };

  return (
    <>
      <div className="gh-inline">
        <span className="gh-account-name">{repo.fullName}</span>
        <Link href={`${repo.htmlUrl}/actions`}>Ver en GitHub</Link>
        <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : <RefreshCw size={13} />} Actualizar
        </button>
      </div>
      <ErrorBox error={error} />
      <Card title="Últimas ejecuciones">
        {runs?.length === 0 && <div className="gh-hint">Este repo no tiene ejecuciones de Actions.</div>}
        <div className="gh-list">
          {runs?.map((r) => (
            <div key={r.id} className="gh-row gh-row-static">
              <RunState run={r} />
              <span className="gh-row-main">
                <span className="gh-row-title">
                  {wfName(r.workflowId) ?? r.name ?? "Workflow"} #{r.runNumber}
                </span>
                <span className="gh-row-sub">
                  {r.displayTitle ?? ""} · {r.headBranch ?? ""} · {r.event ?? ""}
                </span>
              </span>
              <span className="gh-hint">{formatDate(r.createdAt)}</span>
              <Link href={r.htmlUrl}>Abrir</Link>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Ejecutar un workflow">
        <div className="gh-inline">
          <span className="gh-hint">Rama:</span>
          <input className="input mono gh-input-sm" value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Rama" />
        </div>
        {workflows?.length === 0 && <div className="gh-hint">No hay workflows.</div>}
        <div className="gh-list">
          {workflows?.map((w) => (
            <div key={w.id} className="gh-row gh-row-static">
              <span className="gh-row-main">
                <span className="gh-row-title">{w.name}</span>
                <span className="gh-row-sub mono">{w.path}</span>
              </span>
              {w.state !== "active" && <span className="gh-tag">desactivado</span>}
              <button className="btn btn-sm" disabled={w.state !== "active"} onClick={() => void dispatch(w)}>
                <Play size={13} /> Ejecutar
              </button>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

export function ActionsSection() {
  const connected = useGitHub((s) => s.connected);
  const repo = useGitHub((s) => s.repo);
  const setRepo = useGitHub((s) => s.setRepo);
  if (!connected) return <NeedAccount what="ver tus GitHub Actions" />;
  return (
    <>
      <SectionHead title="GitHub Actions" />
      <div className="gh-split">
        <RepoPicker value={repo} onPick={setRepo} />
        <div className="gh-split-detail">{repo ? <RepoActions repo={repo} /> : <div className="gh-empty">Elige un repositorio.</div>}</div>
      </div>
    </>
  );
}
