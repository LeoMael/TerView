// Compose: proyectos detectados (por las etiquetas de los contenedores) y carpetas recordadas.
// Levantar, bajar, reiniciar, actualizar (pull + up) y ver logs, sin escribir comandos.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, FileText, FolderPlus, Layers, Play, RotateCw, ScrollText, Square, X } from "lucide-react";
import {
  COMPOSE_FILES,
  composeCmd,
  composeFor,
  containerAction,
  forgetComposeFolder,
  loadComposeFolders,
  rememberComposeFolder,
  stateText,
  stateTone,
  validateServerPath,
  withOwner,
  ownerKey,
  OWNER_SELF,
  q,
  type Cmd,
  type ComposeFolder,
  type ComposeTool,
  type Container,
} from "../../features/containers";
import { toast } from "../../stores/toasts";
import { PICK_OWNER_HINT, useCt } from "./context";

interface Project {
  key: string;
  name: string;
  dir: string;
  /** Archivo compose (ruta absoluta o relativa a `dir`); "" = el que encuentre compose. */
  file: string;
  saved: boolean;
  containers: Container[];
  /** Usuario dueño (clave de `owner.ts`). */
  owner: string;
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

/** Nombre de proyecto por defecto de Compose: carpeta en minúsculas, solo [a-z0-9_-]. */
function defaultProjectName(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/** Expande «~» para el shell (la ruta va citada). */
function shellPath(p: string): string {
  if (p === "~") return '"$HOME"';
  if (p.startsWith("~/")) return `"$HOME"/${q(p.slice(2))}`;
  return q(p);
}

export function ComposeTab() {
  const ct = useCt();
  const { engine, res, profileId, composeTools } = ct;
  const containers = useMemo(() => res.containers.data ?? [], [res.containers.data]);
  const [saved, setSaved] = useState<ComposeFolder[]>(() => loadComposeFolders(profileId));
  const [tool, setTool] = useState<ComposeTool | null>(() => composeFor(engine, composeTools) ?? composeTools[0] ?? null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [newDir, setNewDir] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    setTool(composeFor(engine, composeTools) ?? composeTools[0] ?? null);
  }, [engine, composeTools]);

  // Proyectos por dueño: con «Todos», dos usuarios pueden tener un proyecto con el mismo nombre.
  const ownerKeys = useMemo(() => new Set(ct.owners.map(ownerKey)), [ct.owners]);
  const fallbackOwner = ct.newOwner ?? OWNER_SELF;
  const projects = useMemo(() => {
    const map = new Map<string, Project>();
    for (const c of containers) {
      if (!c.composeProject) continue;
      const owner = c.owner ?? fallbackOwner;
      const k = `${owner}|${c.composeWorkingDir || `project:${c.composeProject}`}`;
      let p = map.get(k);
      if (!p) {
        const file = (c.composeConfigFiles ?? "").split(",")[0]?.trim() ?? "";
        p = { key: k, name: c.composeProject, dir: c.composeWorkingDir ?? "", file, saved: false, containers: [], owner };
        map.set(k, p);
      }
      p.containers.push(c);
    }
    for (const f of saved) {
      // Las guardadas antes de haber usuarios (sin dueño) se ven como antes, con el usuario elegido.
      const owner = f.owner ?? (ct.allOwners ? OWNER_SELF : fallbackOwner);
      // Las carpetas guardadas se muestran con su usuario (si se está viendo).
      if (!ownerKeys.has(owner)) continue;
      const k = `${owner}|${f.dir}`;
      const p = map.get(k) ?? [...map.values()].find((x) => x.owner === owner && !x.dir && x.name === defaultProjectName(f.dir));
      if (p) {
        p.saved = true;
        if (!p.dir) p.dir = f.dir;
        if (!p.file) p.file = f.file;
      } else map.set(k, { key: k, name: defaultProjectName(f.dir) || basename(f.dir), dir: f.dir, file: f.file, saved: true, containers: [], owner });
    }
    return [...map.values()].sort((a, b) => Number(b.containers.some((c) => c.state === "running")) - Number(a.containers.some((c) => c.state === "running")) || a.name.localeCompare(b.name));
  }, [containers, saved, ownerKeys, fallbackOwner, ct.allOwners]);

  const sel = projects.find((p) => p.key === selKey) ?? projects[0] ?? null;

  const addFolder = async () => {
    const owner = ct.newOwner;
    if (!owner) return;
    const dir = newDir.trim();
    const v = validateServerPath(dir);
    if (v) {
      setAddError(v);
      return;
    }
    setAdding(true);
    setAddError(null);
    const script = [
      `if cd -- ${shellPath(dir)} 2>/dev/null; then`,
      '  echo "dir=$(pwd -P)"',
      `  for f in ${COMPOSE_FILES.join(" ")}; do if [ -f "$f" ]; then echo "file=$f"; fi; done`,
      "else echo nodir=1; fi",
    ].join("\n");
    // Se comprueba como el usuario con el que se va a usar (su HOME, sus permisos).
    const r = await ct.runRawAs(owner, script, 15);
    setAdding(false);
    const out = r.result?.stdout ?? "";
    if (!r.ok || /nodir=1/.test(out)) {
      setAddError(r.error ?? "Esa carpeta no existe o no tienes permiso para entrar");
      return;
    }
    const real = /^dir=(.*)$/m.exec(out)?.[1] ?? dir;
    const file = /^file=(.*)$/m.exec(out)?.[1];
    if (!file) {
      setAddError(`No hay ${COMPOSE_FILES.join(", ")} en ${real}`);
      return;
    }
    setSaved(rememberComposeFolder(profileId, real, file, owner));
    setSelKey(`${owner}|${real}`);
    setNewDir("");
    toast.success("Carpeta de Compose añadida", `${real}/${file}`);
  };

  if (!tool) {
    return (
      <div className="ct-tab-body">
        <div className="empty-state">
          <Layers size={26} />
          <div>No se encontró Compose en el servidor</div>
          <div className="faint ct-small">
            {engine === "podman"
              ? "Instala podman-compose (p. ej. «sudo dnf install podman-compose» o «sudo apt install podman-compose»)."
              : "Instala el plugin de Compose (paquete docker-compose-plugin o docker-compose-v2)."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ct-tab-body ct-compose">
      <aside className="ct-compose-list" aria-label="Proyectos">
        <div className="ct-compose-add">
          <input
            className="input mono"
            placeholder={ct.newOwner ? "/ruta/de/la/carpeta" : "Elige arriba un usuario"}
            title={ct.newOwner ? undefined : PICK_OWNER_HINT}
            disabled={!ct.newOwner}
            value={newDir}
            onChange={(e) => {
              setNewDir(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void addFolder()}
            aria-label="Carpeta con compose.yml"
            spellCheck={false}
          />
          <button className="icon-btn" onClick={() => void addFolder()} disabled={adding || !newDir.trim() || !ct.newOwner} title="Añadir carpeta" aria-label="Añadir carpeta">
            {adding ? <span className="spinner ct-spinner-xs" /> : <FolderPlus size={14} />}
          </button>
        </div>
        {addError && <div className="field-error ct-small">{addError}</div>}
        {projects.length === 0 && <div className="faint ct-small ct-pad">Añade la carpeta de un proyecto con compose.yml. Los proyectos que ya estén levantados aparecen solos.</div>}
        <ul role="listbox" aria-label="Proyectos Compose">
          {projects.map((p) => {
            const up = p.containers.filter((c) => c.state === "running").length;
            return (
              <li
                key={p.key}
                role="option"
                aria-selected={sel?.key === p.key}
                tabIndex={0}
                className={sel?.key === p.key ? "on" : undefined}
                onClick={() => setSelKey(p.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelKey(p.key);
                  } else if (e.key === "ArrowDown") (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                  else if (e.key === "ArrowUp") (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                }}
              >
                <span className={`ct-dot ct-${up > 0 ? "ok" : "off"}`} />
                <span className="ct-compose-name">
                  <strong className="ct-ellipsis">
                    {p.name}
                    {ct.allOwners && <span className="ct-tag">{ct.ownerLabel(p.owner)}</span>}
                  </strong>
                  <span className="faint ct-ellipsis mono">{p.dir || "carpeta desconocida"}</span>
                </span>
                <span className="faint ct-small">{p.containers.length ? `${up}/${p.containers.length}` : ""}</span>
                {p.saved && (
                  <button
                    className="icon-btn ct-xs"
                    title="Olvidar carpeta"
                    aria-label={`Olvidar ${p.dir}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSaved(forgetComposeFolder(profileId, p.dir));
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="ct-compose-detail">
        {sel ? (
          <ProjectView key={sel.key} p={sel} tool={tool} tools={composeTools} setTool={setTool} onUsed={(dir, file) => setSaved(rememberComposeFolder(profileId, dir, file, sel.owner))} />
        ) : (
          <div className="empty-state">
            <Layers size={26} />
            <div>Elige o añade un proyecto</div>
          </div>
        )}
      </section>
    </div>
  );
}

function ProjectView({
  p,
  tool,
  tools,
  setTool,
  onUsed,
}: {
  p: Project;
  tool: ComposeTool;
  tools: ComposeTool[];
  setTool: (t: ComposeTool) => void;
  onUsed: (dir: string, file: string) => void;
}) {
  const ct = useCt();
  const [services, setServices] = useState<string[] | null>(null);
  const [svcError, setSvcError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [output, setOutput] = useState<{ title: string; text: string; ok: boolean } | null>(null);
  const started = useRef(0);
  const canRun = !!p.dir;
  const fileLabel = !p.dir ? "carpeta desconocida" : p.file ? (p.file.startsWith("/") ? p.file : `${p.dir}/${p.file}`) : `${p.dir}/compose.yml`;
  const ids = p.containers.map((c) => c.name || c.id);
  const anyUp = p.containers.some((c) => c.state === "running" || c.state === "paused" || c.state === "restarting");
  const anyDown = p.containers.some((c) => c.state !== "running" && c.state !== "paused" && c.state !== "restarting");

  const cmd = useCallback(
    (action: Parameters<typeof composeCmd>[3], opts: { volumes?: boolean; tail?: number } = {}): Cmd =>
      withOwner(composeCmd(tool, p.dir, p.file, action, opts), p.owner),
    [tool, p.dir, p.file, p.owner],
  );

  const loadServices = useCallback(async () => {
    if (!canRun) return;
    setSvcError(null);
    const r = await ct.run([cmd("services")], 30);
    if (r.ok && r.result) setServices(r.result.stdout.split("\n").map((s) => s.trim()).filter((s) => s && !/^>>>>|^\s*$/.test(s) && /^[a-zA-Z0-9._-]+$/.test(s)));
    else {
      setServices(null);
      setSvcError(r.error ?? "No se pudo leer el archivo compose");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd, canRun, ct.run]);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [busy]);

  const exec = async (label: string, cmds: Cmd[], success: string) => {
    setBusy(label);
    started.current = Date.now();
    setElapsed(0);
    setOutput(null);
    const r = await ct.run(
      cmds.map((c) => ({ ...c, mergeStderr: true })),
      600,
    );
    setBusy(null);
    const text = (r.result?.stdout ?? "")
      .split("\n")
      .filter((l) => !/Executing external compose provider|Please see podman-compose/.test(l))
      .join("\n")
      .trim();
    setOutput({ title: label, text: r.ok ? text : (r.error ?? text), ok: r.ok });
    if (r.ok) {
      toast.success(success, p.name);
      if (p.file) onUsed(p.dir, p.file);
    } else toast.error(`${label}: falló`, r.error?.split("\n")[0]);
    void ct.reload("containers");
    void loadServices();
  };

  const review = (title: string, message: string, build: (o: Record<string, boolean>) => Cmd[], success: string, options?: { key: string; label: string }[], danger = false) =>
    ct.review({
      title: `${title} «${p.name}»`,
      message,
      options,
      build,
      danger,
      runLabel: title,
      timeoutSecs: 600,
      success,
      reload: ["containers"],
      onDone: () => void loadServices(),
    });

  const svcRows = useMemo(() => {
    const names = new Set([...(services ?? []), ...p.containers.map((c) => c.composeService ?? "").filter(Boolean)]);
    const rows = [...names].sort().map((s) => ({ name: s, containers: p.containers.filter((c) => c.composeService === s) }));
    // Contenedores sin etiqueta de servicio (proyectos creados por otras herramientas).
    for (const c of p.containers) if (!c.composeService) rows.push({ name: c.name, containers: [c] });
    return rows;
  }, [services, p.containers]);

  return (
    <div className="ct-project">
      <div className="ct-project-head">
        <div>
          <h3>
            {p.name}
            {ct.allOwners && <span className="ct-tag">{ct.ownerLabel(p.owner)}</span>}
          </h3>
          <div className="faint mono ct-small">{fileLabel}</div>
        </div>
        <span className="ct-grow" />
        {tools.length > 1 && (
          <select className="select ct-select-sm" value={tool} onChange={(e) => setTool(e.target.value as ComposeTool)} aria-label="Herramienta de Compose">
            {tools.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>
      {!canRun && <div className="ct-warn">No se sabe en qué carpeta está este proyecto. Añádela a mano en la lista de la izquierda.</div>}
      <div className="ct-toolbar">
        <button className="btn btn-sm btn-primary" disabled={!canRun || !!busy} onClick={() => void exec("Levantar", [cmd("up")], "Proyecto levantado")}>
          {busy === "Levantar" ? <span className="spinner ct-spinner-sm" /> : <Play size={13} />} Levantar
        </button>
        <button
          className="btn btn-sm"
          disabled={!canRun || !!busy}
          onClick={() =>
            review("Actualizar", "Descarga las versiones nuevas de las imágenes y vuelve a crear los contenedores que cambien (cortes de unos segundos).", () => [cmd("pull"), cmd("up")], "Proyecto actualizado")
          }
        >
          <ArrowDownToLine size={13} /> Actualizar
        </button>
        <button
          className="btn btn-sm"
          disabled={!canRun || !!busy}
          onClick={() => review("Reiniciar", "Reinicia todos los servicios del proyecto.", () => [cmd("restart")], "Proyecto reiniciado")}
        >
          <RotateCw size={13} /> Reiniciar
        </button>
        <button
          className="btn btn-sm ct-btn-danger"
          disabled={!canRun || !!busy}
          onClick={() =>
            review(
              "Bajar",
              "Para y elimina los contenedores y redes del proyecto. Los volúmenes con nombre se conservan salvo que marques la opción.",
              (o) => [cmd("down", { volumes: !!o.volumes })],
              "Proyecto bajado",
              [{ key: "volumes", label: "Borrar también los volúmenes del proyecto (-v): se pierden sus datos" }],
              true,
            )
          }
        >
          <Square size={13} /> Bajar
        </button>
        <button
          className="btn btn-sm"
          disabled={!canRun}
          onClick={() =>
            ct.openLogs({
              title: `Logs de «${p.name}»`,
              build: (tail) => cmd("logs", { tail }),
              follow: (tail) => {
                const c = cmd("logs", { tail });
                return { ...c, args: [...c.args, "-f"], mergeStderr: false };
              },
            })
          }
        >
          <ScrollText size={13} /> Logs
        </button>
        <button
          className="btn btn-sm"
          disabled={!canRun || !!busy}
          onClick={async () => {
            const r = await ct.run([{ bin: ["cat"], args: ["--", p.file || "compose.yml"], cwd: p.dir, owner: p.owner }], 20);
            setOutput({ title: fileLabel, text: r.ok ? (r.result?.stdout ?? "") : (r.error ?? ""), ok: r.ok });
          }}
        >
          <FileText size={13} /> Ver archivo
        </button>
        {p.containers.length > 0 && (
          <>
            <span className="ct-sep" />
            <button
              className="btn btn-sm"
              disabled={!anyDown || !!busy}
              title="Arranca los contenedores ya creados (sin Compose)"
              onClick={() => void exec("Iniciar contenedores", [withOwner(containerAction(ct.engine, "start", ids), p.owner)], "Contenedores iniciados")}
            >
              <Play size={13} /> Iniciar todos
            </button>
            <button
              className="btn btn-sm"
              disabled={!anyUp || !!busy}
              onClick={() =>
                review("Parar", "Para los contenedores del proyecto sin borrarlos.", () => [withOwner(containerAction(ct.engine, "stop", ids), p.owner)], "Contenedores parados")
              }
            >
              <Square size={13} /> Parar todos
            </button>
          </>
        )}
        {busy && (
          <span className="faint ct-small">
            {busy}… {elapsed} s
          </span>
        )}
      </div>

      <h4 className="section-label">Servicios</h4>
      {svcError && (
        <div className="ct-error ct-error-inline" role="alert">
          <AlertTriangle size={14} />
          <pre>{svcError}</pre>
        </div>
      )}
      <table className="ct-table ct-table-auto">
        <thead>
          <tr>
            <th>Servicio</th>
            <th>Contenedor</th>
            <th>Estado</th>
            <th>Imagen</th>
          </tr>
        </thead>
        <tbody>
          {svcRows.map((s) =>
            s.containers.length === 0 ? (
              <tr key={s.name}>
                <td className="ct-strong">{s.name}</td>
                <td className="faint">—</td>
                <td className="faint">
                  <span className="ct-cell-flex">
                    <span className="ct-dot ct-off" /> Sin crear
                  </span>
                </td>
                <td />
              </tr>
            ) : (
              s.containers.map((c) => (
                <tr key={c.id}>
                  <td className="ct-strong">{s.name}</td>
                  <td className="mono">{c.name}</td>
                  <td title={c.status}>
                    <span className="ct-cell-flex">
                      <span className={`ct-dot ct-${stateTone(c.state)}`} /> {stateText(c)}
                    </span>
                  </td>
                  <td className="mono faint ct-ellipsis">{c.image}</td>
                </tr>
              ))
            ),
          )}
          {svcRows.length === 0 && (
            <tr>
              <td colSpan={4} className="ct-norows">
                {services === null && !svcError && canRun ? "Leyendo servicios…" : "Sin servicios"}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {output && (
        <div className="ct-outbox">
          <div className="ct-outbox-head">
            <span className={output.ok ? "" : "ct-bad-text"}>{output.title}</span>
            <button className="icon-btn" onClick={() => setOutput(null)} aria-label="Cerrar salida">
              <X size={13} />
            </button>
          </div>
          <pre className="ct-output">{output.text || "(sin salida)"}</pre>
        </div>
      )}
    </div>
  );
}
