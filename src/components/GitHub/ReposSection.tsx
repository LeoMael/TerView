// Repositorios: buscar uno de tu cuenta y clonarlo en un servidor conectado
// (con llave de despliegue de solo lectura si es privado).
import { useEffect, useState } from "react";
import { GitBranch, Lock, PlayCircle, Rocket } from "lucide-react";
import { github, type GhRepo } from "../../api/github";
import { isApiError } from "../../api/core";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { useTabs } from "../../stores/tabs";
import { useGitHub } from "../../features/github/store";
import {
  cloneScript,
  deployKeyGenScript,
  deployKeyPath,
  parsePubKey,
  validateBranch,
  validateRemotePath,
  wrapSh,
} from "../../features/github/shell";
import { execOk, execOutput } from "../../features/github/session";
import { snippets } from "../../api/snippets";
import { Card, ErrorBox, Link, NeedAccount, Output, RepoPicker, SectionHead, SessionPicker, formatDate } from "./parts";

function CloneForm({ repo }: { repo: GhRepo }) {
  const tabs = useTabs((s) => s.tabs);
  const setSection = useGitHub((s) => s.setSection);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dest, setDest] = useState(`~/${repo.name}`);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [useKey, setUseKey] = useState(repo.private);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [out, setOut] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setDest(`~/${repo.name}`);
    setBranch(repo.defaultBranch);
    setUseKey(repo.private);
    setOut(null);
    setError(null);
    setBranches(null);
    github
      .branches(repo.owner, repo.name)
      .then(setBranches)
      .catch(() => setBranches([repo.defaultBranch]));
  }, [repo]);

  const destError = validateRemotePath(dest);
  const branchError = validateBranch(branch);
  const keyPath = useKey ? deployKeyPath(repo.owner, repo.name) : null;
  const url = useKey ? repo.sshUrl : repo.cloneUrl;
  const script = cloneScript({ url, dest, branch, keyPath });

  const run = async () => {
    if (!sessionId || destError || branchError) return;
    const ok = await confirmDialog({
      title: `¿Clonar ${repo.fullName}?`,
      message: (
        <>
          {useKey && (
            <p>
              1. Se crea en el servidor la llave <span className="mono">{keyPath}</span> (ed25519, sin frase) si no existe.
              <br />
              2. Se registra en el repo como <b>llave de despliegue de solo lectura</b>.
              <br />
              3. Se ejecuta:
            </p>
          )}
          <pre className="gh-output">{script}</pre>
        </>
      ),
      confirmText: "Clonar",
    });
    if (!ok) return;
    setBusy(true);
    setOut(null);
    setError(null);
    try {
      if (useKey) {
        setStep("Creando la llave de despliegue en el servidor…");
        const r = await execOk(sessionId, deployKeyGenScript(repo.owner, repo.name), 60);
        const pub = r.stdout.trim().split("\n").pop() ?? "";
        if (!parsePubKey(pub)) throw new Error("El servidor no devolvió una llave pública válida");
        setStep("Registrando la llave en GitHub…");
        const host = tabs.find((t) => t.sessionId === sessionId)?.title ?? "servidor";
        try {
          await github.addDeployKey(repo.owner, repo.name, `TerView · ${host}`, pub);
        } catch (e) {
          // Ya registrada (p. ej. un clonado anterior): seguimos.
          if (!(isApiError(e, "Invalid") && /already in use/i.test(e.message))) throw e;
        }
      }
      setStep("Clonando…");
      const r = await snippets.exec(sessionId, wrapSh(script), 600);
      const okRun = r.exitCode === 0 && !r.timedOut;
      setOut({ text: execOutput(r) + (r.timedOut ? "\n(se agotó el tiempo)" : ""), ok: okRun });
      if (okRun) toast.success(`${repo.fullName} clonado`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  const saveRecipe = async () => {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    try {
      await github.recipeSave({
        id: "",
        name: repo.name,
        serverId: tab.profileId,
        projectId: null,
        repo: repo.fullName,
        path: dest.trim(),
        branch: branch.trim(),
        commands: "",
        deployKey: keyPath,
        lastRunAt: null,
        lastOk: null,
      });
      toast.success("Receta de despliegue guardada");
      setSection("deploy");
    } catch (e) {
      toast.error("No se pudo guardar la receta", e);
    }
  };

  return (
    <Card title="Clonar en un servidor">
      <div className="gh-form">
        <label className="field">
          <span>Servidor</span>
          <SessionPicker value={sessionId} onChange={setSessionId} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Carpeta destino</span>
            <input className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} />
          </label>
          <label className="field">
            <span>Rama</span>
            {branches && branches.length > 0 ? (
              <select className="select" value={branch} onChange={(e) => setBranch(e.target.value)}>
                {!branches.includes(branch) && <option value={branch}>{branch}</option>}
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
            )}
          </label>
        </div>
        {(destError || branchError) && <div className="field-error">{destError ?? branchError}</div>}
        <label className="checkbox">
          <input type="checkbox" checked={useKey} onChange={(e) => setUseKey(e.target.checked)} />
          <span>
            Usar una llave de despliegue de solo lectura (SSH){repo.private ? " — necesario para repos privados" : ""}
          </span>
        </label>
      </div>
      <div className="gh-inline">
        <button
          className="btn btn-primary btn-sm"
          disabled={!sessionId || !!destError || !!branchError || busy}
          onClick={() => void run()}
        >
          {busy ? <span className="spinner" /> : <GitBranch size={13} />} Clonar…
        </button>
        {step && <span className="gh-hint">{step}</span>}
      </div>
      <ErrorBox error={error} />
      {out && <Output text={out.text} ok={out.ok} />}
      {out?.ok && (
        <button className="btn btn-sm" onClick={() => void saveRecipe()}>
          <Rocket size={13} /> Guardar como receta de despliegue
        </button>
      )}
    </Card>
  );
}

export function ReposSection() {
  const connected = useGitHub((s) => s.connected);
  const repo = useGitHub((s) => s.repo);
  const setRepo = useGitHub((s) => s.setRepo);
  const setSection = useGitHub((s) => s.setSection);
  if (!connected) return <NeedAccount what="ver y clonar tus repositorios" />;
  return (
    <>
      <SectionHead title="Repositorios" />
      <div className="gh-split">
        <RepoPicker value={repo} onPick={setRepo} />
        <div className="gh-split-detail">
          {!repo ? (
            <div className="gh-empty">Elige un repositorio.</div>
          ) : (
            <>
              <div className="gh-repo-head">
                <div className="gh-account-name">
                  {repo.private && <Lock size={13} aria-label="Privado" />} {repo.fullName}
                </div>
                {repo.description && <div className="gh-hint">{repo.description}</div>}
                <div className="gh-inline">
                  <Link href={repo.htmlUrl}>Abrir en GitHub</Link>
                  <button className="btn btn-sm" onClick={() => setSection("actions")}>
                    <PlayCircle size={13} /> Actions
                  </button>
                  {repo.pushedAt && <span className="gh-hint">Último push: {formatDate(repo.pushedAt)}</span>}
                </div>
              </div>
              <CloneForm repo={repo} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
