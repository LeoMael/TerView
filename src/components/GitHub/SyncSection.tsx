// Sincronizar configuración (gist privado cifrado) y compartir colecciones de comandos.
import { useEffect, useMemo, useState } from "react";
import { CloudDownload, CloudUpload, Download, Share2 } from "lucide-react";
import { github, type GhConfig, type GhGistInfo } from "../../api/github";
import type { Snippet } from "../../api/types";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { useProfiles } from "../../stores/profiles";
import { useSnippets } from "../Commands/state";
import { useGitHub } from "../../features/github/store";
import {
  buildPayload,
  countStates,
  parsePayload,
  planImport,
  projectToSave,
  serverToSave,
  snippetToSave,
  type ImportPlan,
  type PlanItem,
} from "../../features/github/sync";
import { Card, ErrorBox, Link, SectionHead, formatDate } from "./parts";

const MIN_PASS = 8;

function useLocalData() {
  const servers = useProfiles((s) => s.servers);
  const projects = useProfiles((s) => s.projects);
  const loadedP = useProfiles((s) => s.loaded);
  const loadP = useProfiles((s) => s.load);
  const snippets = useSnippets((s) => s.list);
  const loadedS = useSnippets((s) => s.loaded);
  const loadS = useSnippets((s) => s.load);
  useEffect(() => {
    if (!loadedP) void loadP();
    if (!loadedS) void loadS();
  }, [loadedP, loadP, loadedS, loadS]);
  return { servers, projects, snippets, ready: loadedP && loadedS };
}

function GistLabel({ g }: { g: GhGistInfo }) {
  return (
    <>
      <Link href={g.htmlUrl}>gist {g.id.slice(0, 8)}</Link>
      {g.updatedAt && <span className="gh-hint"> · actualizado {formatDate(g.updatedAt)}</span>}
    </>
  );
}

function Push({ cfg, onDone }: { cfg: GhConfig | null; onDone: () => void }) {
  const { servers, projects, snippets, ready } = useLocalData();
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<GhGistInfo | null>(null);

  const problem =
    pass.length < MIN_PASS ? `La frase debe tener al menos ${MIN_PASS} caracteres` : pass !== pass2 ? "Las frases no coinciden" : null;

  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      const g = await github.syncPush(buildPayload(servers, projects, snippets), pass, cfg?.syncGistId);
      setResult(g);
      setPass("");
      setPass2("");
      toast.success("Configuración subida", "Copia cifrada en tu gist privado");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Subir esta configuración">
      <p className="gh-hint">
        Se suben <b>{servers.length}</b> servidores, <b>{projects.length}</b> proyectos y <b>{snippets.length}</b> comandos
        propios a un gist secreto de tu cuenta, cifrados con tu frase (AES-256-GCM + Argon2id): aunque alguien viera el
        gist, sin la frase no puede leerlo. Las contraseñas y llaves privadas <b>no</b> se suben. Guarda la frase: sin
        ella no se puede recuperar la copia.
      </p>
      {cfg?.syncGistId && (
        <p className="gh-hint">
          Destino: gist <span className="mono">{cfg.syncGistId.slice(0, 8)}</span>
          {cfg.syncUpdatedAt && ` · última subida ${formatDate(cfg.syncUpdatedAt)}`}
        </p>
      )}
      <div className="field-row">
        <label className="field">
          <span>Frase de paso</span>
          <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        <label className="field">
          <span>Repite la frase</span>
          <input className="input" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </label>
      </div>
      {pass && problem && <div className="field-error">{problem}</div>}
      <ErrorBox error={error} />
      <div className="gh-inline">
        <button className="btn btn-primary btn-sm" disabled={!ready || !!problem || busy} onClick={() => void push()}>
          {busy ? <span className="spinner" /> : <CloudUpload size={13} />} Subir copia cifrada
        </button>
        {busy && <span className="gh-hint">Cifrando…</span>}
        {result && <GistLabel g={result} />}
      </div>
    </Card>
  );
}

function PlanList<T>({ title, items, label }: { title: string; items: PlanItem<T>[]; label: (x: T) => string }) {
  const c = countStates(items);
  if (items.length === 0) return null;
  return (
    <details className="gh-plan">
      <summary>
        {title}: <b>{c.new}</b> nuevos · <b>{c.changed}</b> distintos · {c.same} iguales
      </summary>
      <ul>
        {items.map((i, n) => (
          <li key={n} className={`gh-plan-${i.state}`}>
            <span className="gh-tag">{i.state === "new" ? "nuevo" : i.state === "changed" ? "distinto" : "igual"}</span>{" "}
            {label(i.remote)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Pull({ cfg, onDone }: { cfg: GhConfig | null; onDone: () => void }) {
  const local = useLocalData();
  const saveServer = useProfiles((s) => s.saveServer);
  const saveProject = useProfiles((s) => s.saveProject);
  const saveSnippet = useSnippets((s) => s.save);
  const [found, setFound] = useState<GhGistInfo[] | null>(null);
  const [gistId, setGistId] = useState<string>("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [source, setSource] = useState<{ gist: GhGistInfo; exportedAt: string } | null>(null);
  const [addNew, setAddNew] = useState(true);
  const [update, setUpdate] = useState(false);

  useEffect(() => {
    github
      .syncFind()
      .then((l) => {
        setFound(l);
        setGistId((cur) => cur || cfg?.syncGistId || l[0]?.id || "");
      })
      .catch((e) => {
        setFound([]);
        setError(e);
      });
  }, [cfg?.syncGistId]);

  const fetchIt = async () => {
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const r = await github.syncPull(pass, gistId || null);
      const payload = parsePayload(r.payload);
      setPlan(planImport(payload, local));
      setSource({ gist: r.gist, exportedAt: payload.exportedAt });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    const want = (i: PlanItem<unknown>) => (i.state === "new" && addNew) || (i.state === "changed" && update);
    const nS = plan.servers.filter(want).length;
    const nP = plan.projects.filter(want).length;
    const nC = plan.snippets.filter(want).length;
    if (nS + nP + nC === 0) {
      toast.info("No hay nada que importar con estas opciones");
      return;
    }
    const ok = await confirmDialog({
      title: "¿Importar la configuración?",
      message: (
        <>
          Se guardarán {nS} servidores, {nP} proyectos y {nC} comandos.
          {update && " Los que ya existen y son distintos se sobrescribirán con la versión del gist."} No se borra nada
          de lo que ya tienes. Las contraseñas habrá que escribirlas de nuevo al conectar.
        </>
      ),
      confirmText: "Importar",
      danger: update,
    });
    if (!ok) return;
    setBusy(true);
    let done = 0;
    for (const i of plan.servers) if (want(i) && (await saveServer(serverToSave(i)))) done++;
    const known = new Set(useProfiles.getState().servers.map((s) => s.id));
    for (const i of plan.projects) if (want(i) && (await saveProject(projectToSave(i, plan, known)))) done++;
    const knownProjects = new Set(useProfiles.getState().projects.map((p) => p.id));
    for (const i of plan.snippets) {
      if (!want(i)) continue;
      const s: Snippet = snippetToSave(i, plan);
      const target = s.scope === "server" ? known : s.scope === "project" ? knownProjects : null;
      if (target && (!s.scopeId || !target.has(s.scopeId))) {
        s.scope = "global";
        s.scopeId = null;
      }
      if (await saveSnippet(s)) done++;
    }
    setBusy(false);
    setPlan(null);
    toast.success(`Importados ${done} elementos`);
  };

  return (
    <Card title="Traer configuración de otra PC">
      {found && found.length === 0 && !cfg?.syncGistId && (
        <p className="gh-hint">No se encontró ninguna copia de SSHorus en tus gists. Súbela primero desde la otra PC.</p>
      )}
      {found && found.length > 1 && (
        <label className="field">
          <span>Copia</span>
          <select className="select" value={gistId} onChange={(e) => setGistId(e.target.value)}>
            {found.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id.slice(0, 8)} · {formatDate(g.updatedAt)}
              </option>
            ))}
          </select>
        </label>
      )}
      <form
        className="gh-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (pass && !busy) void fetchIt();
        }}
      >
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder="Frase de paso"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          aria-label="Frase de paso"
        />
        <button className="btn btn-sm" type="submit" disabled={!pass || busy || !local.ready}>
          {busy && !plan ? <span className="spinner" /> : <CloudDownload size={13} />} Descargar y ver
        </button>
      </form>
      <ErrorBox error={error} />
      {plan && source && (
        <div className="gh-preview">
          <div className="gh-hint">
            <GistLabel g={source.gist} />
            {source.exportedAt && ` · copia del ${formatDate(source.exportedAt)}`}
          </div>
          <PlanList title="Servidores" items={plan.servers} label={(s) => `${s.name} (${s.username}@${s.host}:${s.port})`} />
          <PlanList title="Proyectos" items={plan.projects} label={(p) => p.name} />
          <PlanList title="Comandos" items={plan.snippets} label={(s) => `${s.name} — ${s.command}`} />
          <label className="checkbox">
            <input type="checkbox" checked={addNew} onChange={(e) => setAddNew(e.target.checked)} />
            <span>Añadir los nuevos</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
            <span>Sobrescribir los distintos con la versión del gist</span>
          </label>
          <div className="gh-inline">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void apply()}>
              Importar
            </button>
            <button className="btn btn-sm" onClick={() => setPlan(null)}>
              Descartar
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ShareImport() {
  const mine = useSnippets((s) => s.list);
  const save = useSnippets((s) => s.save);
  const load = useSnippets((s) => s.load);
  const loaded = useSnippets((s) => s.loaded);
  const [src, setSrc] = useState("");
  const [list, setList] = useState<Snippet[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const exists = (s: Snippet) => mine.some((m) => m.name === s.name && m.command === s.command);

  const fetchIt = async () => {
    setBusy(true);
    setError(null);
    setList(null);
    try {
      const l = await github.fetchSnippets(src);
      setList(l);
      setPicked(new Set(l.map((s, i) => (exists(s) ? -1 : i)).filter((i) => i >= 0)));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const importIt = async () => {
    if (!list) return;
    const chosen = list.filter((_, i) => picked.has(i));
    const dangerous = chosen.filter((s) => s.dangerous || s.sudo).length;
    const ok = await confirmDialog({
      title: `¿Importar ${chosen.length} comandos?`,
      message: (
        <>
          Se añadirán a «Mis comandos». Revisa lo que hace cada uno antes de ejecutarlo: vienen de otra persona.
          {dangerous > 0 && <b> {dangerous} usan sudo o están marcados como peligrosos.</b>}
        </>
      ),
      confirmText: "Importar",
    });
    if (!ok) return;
    let n = 0;
    for (const s of chosen) if (await save({ ...s, id: "" })) n++;
    toast.success(`Importados ${n} comandos`);
    setList(null);
    setSrc("");
  };

  const toggle = (i: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  return (
    <Card title="Importar comandos compartidos">
      <form
        className="gh-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (src.trim() && !busy) void fetchIt();
        }}
      >
        <input
          className="input mono"
          placeholder="Enlace de gist, de un archivo de GitHub (…/blob/…) o raw.githubusercontent.com"
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          aria-label="Origen de la colección"
        />
        <button className="btn btn-sm" type="submit" disabled={!src.trim() || busy}>
          {busy ? <span className="spinner" /> : <Download size={13} />} Ver
        </button>
      </form>
      <ErrorBox error={error} />
      {list && (
        <>
          <div className="gh-list gh-list-short">
            {list.map((s, i) => (
              <label key={i} className="gh-row gh-row-check">
                <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                <span className="gh-row-main">
                  <span className="gh-row-title">
                    {s.name} {exists(s) && <span className="gh-tag">ya lo tienes</span>}
                    {(s.dangerous || s.sudo) && <span className="gh-tag gh-tag-warn">{s.sudo ? "sudo" : "peligroso"}</span>}
                  </span>
                  <span className="gh-row-sub mono">{s.command}</span>
                </span>
                <span className="gh-hint">{s.category}</span>
              </label>
            ))}
          </div>
          <button className="btn btn-primary btn-sm" disabled={picked.size === 0} onClick={() => void importIt()}>
            Importar {picked.size} seleccionados
          </button>
        </>
      )}
    </Card>
  );
}

function SharePublish() {
  const connected = useGitHub((s) => s.connected);
  const mine = useSnippets((s) => s.list);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [desc, setDesc] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GhGistInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sorted = useMemo(() => [...mine].sort((a, b) => a.name.localeCompare(b.name)), [mine]);

  const publish = async () => {
    const chosen = mine.filter((s) => picked.has(s.id));
    const ok = await confirmDialog({
      title: `¿Publicar ${chosen.length} comandos?`,
      message: isPublic
        ? "El gist será público: cualquiera podrá verlo y encontrarlo."
        : "El gist será secreto: no aparece en búsquedas, pero cualquiera con el enlace puede verlo.",
      confirmText: "Publicar",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await github.shareSnippets(chosen, desc, isPublic));
      toast.success("Comandos publicados");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!connected) return null;
  return (
    <Card title="Publicar mis comandos en un gist">
      {sorted.length === 0 ? (
        <div className="gh-hint">Aún no tienes comandos propios.</div>
      ) : (
        <div className="gh-list gh-list-short">
          {sorted.map((s) => (
            <label key={s.id} className="gh-row gh-row-check">
              <input
                type="checkbox"
                checked={picked.has(s.id)}
                onChange={() =>
                  setPicked((p) => {
                    const n = new Set(p);
                    if (n.has(s.id)) n.delete(s.id);
                    else n.add(s.id);
                    return n;
                  })
                }
              />
              <span className="gh-row-main">
                <span className="gh-row-title">{s.name}</span>
                <span className="gh-row-sub mono">{s.command}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="gh-inline">
        <input className="input" placeholder="Descripción del gist" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <label className="checkbox">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          <span>Público</span>
        </label>
        <button className="btn btn-sm" disabled={picked.size === 0 || busy} onClick={() => void publish()}>
          {busy ? <span className="spinner" /> : <Share2 size={13} />} Publicar
        </button>
      </div>
      <ErrorBox error={error} />
      {result && (
        <p className="gh-hint">
          Publicado: <Link href={result.htmlUrl}>{result.htmlUrl}</Link>. Comparte este enlace para que otros lo importen.
        </p>
      )}
    </Card>
  );
}

export function SyncSection() {
  const connected = useGitHub((s) => s.connected);
  const [cfg, setCfg] = useState<GhConfig | null>(null);
  const reload = () => {
    github.configLoad().then(setCfg).catch(() => setCfg(null));
  };
  useEffect(reload, []);
  return (
    <>
      <SectionHead title="Sincronizar y compartir" />
      {connected ? (
        <>
          <Push cfg={cfg} onDone={reload} />
          <Pull cfg={cfg} onDone={reload} />
        </>
      ) : (
        <p className="gh-hint">Conecta tu cuenta para sincronizar tu configuración entre equipos con un gist privado cifrado.</p>
      )}
      <ShareImport />
      <SharePublish />
    </>
  );
}
