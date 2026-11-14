// Despliegues: recetas por proyecto/servidor (carpeta, rama, comandos) y «Actualizar desde GitHub».
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import { github, type DeployRecipe } from "../../api/github";
import { snippets } from "../../api/snippets";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { useProfiles } from "../../stores/profiles";
import { useGitHub } from "../../features/github/store";
import { commandLines, deployScript, validateBranch, validateRemotePath, wrapSh } from "../../features/github/shell";
import { ensureSession, execOutput } from "../../features/github/session";
import { Card, ErrorBox, Output, SectionHead, ServerSelect } from "./parts";

const EMPTY: DeployRecipe = {
  id: "",
  name: "",
  serverId: "",
  projectId: null,
  repo: null,
  path: "",
  branch: "main",
  commands: "",
  deployKey: null,
  lastRunAt: null,
  lastOk: null,
};

function validateKeyPath(p: string): string | null {
  return /^(~\/|\/)[A-Za-z0-9._/-]+$/.test(p.trim()) ? null : "Ruta de llave no válida (p. ej. ~/.ssh/sshorus_deploy_app)";
}

function RecipeEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial: DeployRecipe;
  onSaved: (r: DeployRecipe) => void;
  onCancel: () => void;
}) {
  const projects = useProfiles((s) => s.projects);
  const repos = useGitHub((s) => s.repos);
  const [r, setR] = useState<DeployRecipe>(initial);
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof DeployRecipe>(k: K, v: DeployRecipe[K]) => setR((x) => ({ ...x, [k]: v }));

  const problem =
    (!r.name.trim() && "Ponle un nombre") ||
    (!r.serverId && "Elige el servidor") ||
    validateRemotePath(r.path) ||
    validateBranch(r.branch) ||
    (r.repo && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r.repo.trim()) && "El repositorio debe ser dueño/nombre") ||
    (r.deployKey && validateKeyPath(r.deployKey)) ||
    null;

  const save = async () => {
    setError(null);
    try {
      onSaved(await github.recipeSave(r));
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Card title={initial.id ? "Editar receta" : "Nueva receta"}>
      <div className="gh-form">
        <div className="field-row">
          <label className="field">
            <span>Nombre</span>
            <input className="input" value={r.name} onChange={(e) => set("name", e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>Proyecto (opcional)</span>
            <select
              className="select"
              value={r.projectId ?? ""}
              onChange={(e) => set("projectId", e.target.value || null)}
            >
              <option value="">Sin proyecto</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Servidor</span>
            <ServerSelect value={r.serverId} onChange={(v) => set("serverId", v)} />
          </label>
          <label className="field">
            <span>Repositorio (dueño/nombre, opcional)</span>
            <input
              className="input mono"
              list="gh-repo-names"
              value={r.repo ?? ""}
              onChange={(e) => set("repo", e.target.value || null)}
            />
            <datalist id="gh-repo-names">
              {(repos ?? []).map((x) => (
                <option key={x.fullName} value={x.fullName} />
              ))}
            </datalist>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Carpeta en el servidor</span>
            <input className="input mono" value={r.path} placeholder="~/app" onChange={(e) => set("path", e.target.value)} />
          </label>
          <label className="field">
            <span>Rama</span>
            <input className="input mono" value={r.branch} onChange={(e) => set("branch", e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Comandos después de «git pull» (uno por línea; se para al primer error)</span>
          <textarea
            className="textarea mono gh-textarea"
            value={r.commands}
            placeholder={"podman compose up -d --build"}
            onChange={(e) => set("commands", e.target.value)}
          />
        </label>
        <label className="field">
          <span>Llave de despliegue en el servidor (opcional)</span>
          <input
            className="input mono"
            value={r.deployKey ?? ""}
            placeholder="~/.ssh/sshorus_deploy_dueño-repo"
            onChange={(e) => set("deployKey", e.target.value || null)}
          />
        </label>
      </div>
      {problem && <div className="field-error">{problem}</div>}
      <ErrorBox error={error} />
      <div className="gh-inline gh-right">
        <button className="btn btn-sm" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary btn-sm" disabled={!!problem} onClick={() => void save()}>
          Guardar
        </button>
      </div>
    </Card>
  );
}

interface RunState {
  running: boolean;
  text: string;
  ok: boolean | null;
}

export function DeploySection() {
  const servers = useProfiles((s) => s.servers);
  const projects = useProfiles((s) => s.projects);
  const loadProfiles = useProfiles((s) => s.load);
  const loaded = useProfiles((s) => s.loaded);
  const [recipes, setRecipes] = useState<DeployRecipe[] | null>(null);
  const [editing, setEditing] = useState<DeployRecipe | null>(null);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(() => {
    github
      .configLoad()
      .then((c) => setRecipes(c.recipes))
      .catch(setError);
  }, []);
  useEffect(() => {
    reload();
    if (!loaded) void loadProfiles();
  }, [reload, loaded, loadProfiles]);

  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "(servidor borrado)";

  const groups = useMemo(() => {
    const m = new Map<string, DeployRecipe[]>();
    for (const r of recipes ?? []) {
      const k = r.projectId ?? "";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()].map(([pid, list]) => ({
      pid,
      name: pid ? (projects.find((p) => p.id === pid)?.name ?? "(proyecto borrado)") : "Sin proyecto",
      list,
    }));
  }, [recipes, projects]);

  /** Ejecuta una receta. Devuelve true si terminó bien. `ask`: pedir confirmación. */
  const runOne = async (r: DeployRecipe, ask = true): Promise<boolean> => {
    const script = deployScript({ path: r.path, branch: r.branch, commands: r.commands, keyPath: r.deployKey });
    if (ask) {
      const ok = await confirmDialog({
        title: `¿Actualizar «${r.name}» en ${serverName(r.serverId)}?`,
        message: <pre className="gh-output">{script}</pre>,
        confirmText: "Actualizar",
      });
      if (!ok) return false;
    }
    setRuns((s) => ({ ...s, [r.id]: { running: true, text: "Conectando…", ok: null } }));
    const sessionId = await ensureSession(r.serverId);
    if (!sessionId) {
      setRuns((s) => ({ ...s, [r.id]: { running: false, text: "No se pudo conectar al servidor.", ok: false } }));
      return false;
    }
    setRuns((s) => ({
      ...s,
      [r.id]: { running: true, text: `Ejecutando git pull y ${commandLines(r.commands).length} comandos…`, ok: null },
    }));
    let ok = false;
    try {
      const res = await snippets.exec(sessionId, wrapSh(script), 600);
      ok = res.exitCode === 0 && !res.timedOut;
      const extra = res.timedOut ? "\n(se agotó el tiempo de 10 min)" : res.truncated ? "\n(salida recortada)" : "";
      setRuns((s) => ({ ...s, [r.id]: { running: false, text: execOutput(res) + extra, ok } }));
    } catch (e) {
      setRuns((s) => ({
        ...s,
        [r.id]: { running: false, text: e instanceof Error ? e.message : String(e), ok: false },
      }));
    }
    github.recipeMark(r.id, ok).then(reload).catch(() => {});
    if (ok) toast.success(`«${r.name}» actualizado`);
    else toast.error(`Falló la actualización de «${r.name}»`);
    return ok;
  };

  const runGroup = async (list: DeployRecipe[], name: string) => {
    const ok = await confirmDialog({
      title: `¿Actualizar todo «${name}»?`,
      message: `Se ejecutarán ${list.length} recetas una tras otra (git pull + comandos). Se para en la primera que falle.`,
      confirmText: "Actualizar todo",
    });
    if (!ok) return;
    for (const r of list) {
      if (!(await runOne(r, false))) break;
    }
  };

  const remove = async (r: DeployRecipe) => {
    if (!(await confirmDialog({ title: `¿Borrar la receta «${r.name}»?`, message: "No toca nada en el servidor.", danger: true, confirmText: "Borrar" })))
      return;
    try {
      await github.recipeDelete(r.id);
      reload();
    } catch (e) {
      toast.error("No se pudo borrar", e);
    }
  };

  return (
    <>
      <SectionHead title="Despliegues">
        <button className="btn btn-sm btn-primary" onClick={() => setEditing({ ...EMPTY })}>
          <Plus size={13} /> Nueva receta
        </button>
      </SectionHead>
      <p className="gh-hint">
        Una receta dice dónde está el proyecto en el servidor, qué rama seguir y qué ejecutar después de{" "}
        <span className="mono">git pull</span>. Se guarda en este equipo (github.json).
      </p>
      <ErrorBox error={error} />
      {editing && (
        <RecipeEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {recipes?.length === 0 && !editing && (
        <div className="gh-empty">Aún no hay recetas. Crea una o clona un repo desde «Repositorios».</div>
      )}
      {groups.map((g) => (
        <Card
          key={g.pid || "none"}
          title={g.name}
          actions={
            g.pid && g.list.length > 1 ? (
              <button className="btn btn-sm" onClick={() => void runGroup(g.list, g.name)}>
                <Rocket size={13} /> Actualizar todo
              </button>
            ) : undefined
          }
        >
          {g.list.map((r) => {
            const run = runs[r.id];
            return (
              <div key={r.id} className="gh-recipe">
                <div className="gh-recipe-row">
                  <span
                    className={`status-dot ${r.lastOk === true ? "gh-dot-ok" : r.lastOk === false ? "gh-dot-bad" : ""}`}
                    aria-hidden
                  />
                  <div className="gh-row-main">
                    <span className="gh-row-title">{r.name}</span>
                    <span className="gh-row-sub mono">
                      {serverName(r.serverId)} · {r.path} · {r.branch}
                      {r.repo ? ` · ${r.repo}` : ""}
                    </span>
                  </div>
                  {r.lastRunAt && (
                    <span className="gh-hint">
                      {r.lastOk ? "Bien" : "Falló"} · {new Date(r.lastRunAt * 1000).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  )}
                  <button className="btn btn-sm btn-primary" disabled={run?.running} onClick={() => void runOne(r)}>
                    {run?.running ? <span className="spinner" /> : <Rocket size={13} />} Actualizar desde GitHub
                  </button>
                  <button className="icon-btn" aria-label="Editar" onClick={() => setEditing(r)}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-btn" aria-label="Borrar" onClick={() => void remove(r)}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {run && (run.running ? <div className="gh-hint">{run.text}</div> : <Output text={run.text} ok={run.ok} />)}
              </div>
            );
          })}
        </Card>
      ))}
    </>
  );
}
