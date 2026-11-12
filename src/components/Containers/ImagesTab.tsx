// Imágenes: listar, descargar (pull), eliminar, crear contenedor y limpiar las que no se usan.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Brush, Bug, Download, Rocket, RefreshCw, Search, TerminalSquare, Trash2, X } from "lucide-react";
import {
  ago,
  pullImage,
  pruneImages,
  removeImages,
  validateImage,
  type Container,
  type Engine,
  type ImageInfo,
} from "../../features/containers";
import { formatBytes } from "../../lib/format";
import { toast } from "../../stores/toasts";
import { AdmModal } from "../Admin/AdmModal";
import { useCt } from "./context";
import { useVulnNav } from "../../features/vulnscan/nav";

/** Normaliza una referencia para comparar («nginx» = «docker.io/library/nginx:latest»). */
export function normRef(ref: string): string {
  let r = ref.trim().toLowerCase();
  if (!r) return r;
  const lastSlash = r.lastIndexOf("/");
  if (!r.slice(lastSlash + 1).includes(":") && !r.includes("@")) r += ":latest";
  r = r.replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "").replace(/^library\//, "");
  return r;
}

/** Contenedores que usan la imagen (por etiqueta o por id). */
export function usersOf(img: ImageInfo, containers: Container[]): Container[] {
  const tags = new Set(img.tags.map(normRef));
  return containers.filter((c) => {
    const ref = c.image.replace(/^sha256:/, "").toLowerCase();
    if (ref.length >= 12 && /^[0-9a-f]+$/.test(ref) && img.id.startsWith(ref)) return true;
    return tags.has(normRef(c.image));
  });
}

function inUseCount(img: ImageInfo, containers: Container[]): number {
  return Math.max(img.containers ?? 0, usersOf(img, containers).length);
}

export function ImagesTab() {
  const ct = useCt();
  const { engine, res } = ct;
  const images = useMemo(() => res.images.data ?? [], [res.images.data]);
  const containers = useMemo(() => res.containers.data ?? [], [res.containers.data]);
  const [search, setSearch] = useState("");
  const [showDangling, setShowDangling] = useState(false);
  /** null = cerrado; texto = imagen precargada. */
  const [pull, setPull] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: "name" | "size" | "created"; dir: 1 | -1 }>({ key: "name", dir: 1 });

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return images
      .filter((i) => (showDangling ? true : !i.dangling))
      .filter((i) => !s || i.tags.some((t) => t.toLowerCase().includes(s)) || i.shortId.includes(s))
      .sort((a, b) => {
        const v = (i: ImageInfo) => (sort.key === "name" ? (i.tags[0] ?? "~").toLowerCase() : sort.key === "size" ? (i.size ?? 0) : (i.created ?? 0));
        const x = v(a);
        const y = v(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
  }, [images, search, showDangling, sort]);

  const dangling = images.filter((i) => i.dangling).length;

  const remove = (img: ImageInfo) => {
    const users = usersOf(img, containers);
    const count = inUseCount(img, containers);
    const ref = img.tags.length === 1 ? img.tags[0] : img.id;
    ct.review({
      title: `Eliminar imagen ${img.tags[0] ?? img.shortId}`,
      message:
        count > 0 ? (
          <span className="ct-warn-text">
            <AlertTriangle size={13} /> Esta imagen la usa{count > 1 ? "n" : ""} {count} contenedor{count > 1 ? "es" : ""}
            {users.length ? `: ${users.map((u) => u.name).join(", ")}` : ""}. Elimínalos antes o marca «Forzar» (también los borra en Podman).
          </span>
        ) : img.tags.length > 1 ? (
          `Tiene ${img.tags.length} etiquetas; se borran todas.`
        ) : (
          "Se borra la imagen del servidor. Podrás volver a descargarla."
        ),
      options: count > 0 ? [{ key: "force", label: "Forzar el borrado aunque esté en uso (-f)" }] : img.tags.length > 1 ? [{ key: "force", label: "Forzar (necesario con varias etiquetas)", initial: true }] : undefined,
      build: (o) => [removeImages(engine, [ref], !!o.force)],
      danger: true,
      runLabel: "Eliminar",
      success: "Imagen eliminada",
      reload: ["images", "containers", "df"],
    });
  };

  const prune = () => {
    if (res.df.loadedAt === 0) void ct.reload("df");
    ct.review({
      title: "Limpiar imágenes sin usar",
      message: "Libera espacio borrando imágenes que no usa ningún contenedor (ni parado). Podrás volver a descargarlas.",
      options: [
        {
          key: "all",
          label: "Incluir también las que tienen nombre (-a)",
          hint: "Si no, solo las «colgantes» (sin nombre, restos de compilaciones y actualizaciones)",
        },
      ],
      details: (o) => <PruneList all={!!o.all} images={images} containers={containers} engine={engine} />,
      build: (o) => [pruneImages(engine, !!o.all)],
      danger: true,
      runLabel: "Limpiar",
      timeoutSecs: 300,
      success: (r) => `Imágenes sin usar eliminadas\n${reclaimed(r.result?.stdout ?? "")}`,
      reload: ["images", "df"],
    });
  };

  const sortBy = (key: "name" | "size" | "created") => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === "name" ? 1 : -1 }));
  const th = (key: "name" | "size" | "created", label: string, cls: string) => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="ct-th" onClick={() => sortBy(key)}>
        {label}
        {sort.key === key && <span className="ct-sort">{sort.dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </th>
  );

  return (
    <div className="ct-tab-body">
      <div className="ct-toolbar">
        <div className="ct-search">
          <Search size={13} />
          <input className="input" placeholder="Buscar imagen" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar imágenes" />
          {search && (
            <button className="icon-btn" onClick={() => setSearch("")} aria-label="Limpiar búsqueda">
              <X size={12} />
            </button>
          )}
        </div>
        <label className="checkbox" title="Imágenes sin nombre (restos de compilaciones o actualizaciones)">
          <input type="checkbox" checked={showDangling} onChange={(e) => setShowDangling(e.target.checked)} /> Mostrar sin nombre ({dangling})
        </label>
        <span className="faint">{images.length} imágenes</span>
        <span className="ct-grow" />
        <button className="icon-btn" onClick={() => void ct.reload("images", "containers")} title="Actualizar" aria-label="Actualizar" disabled={res.images.loading}>
          <RefreshCw size={14} className={res.images.loading ? "ct-spin" : undefined} />
        </button>
        <button className="btn btn-sm" onClick={prune} disabled={!images.length}>
          <Brush size={13} /> Limpiar sin usar
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => setPull("")}>
          <Download size={13} /> Descargar imagen
        </button>
      </div>
      {res.images.error && (
        <div className="ct-error ct-error-inline" role="alert">
          <pre>{res.images.error}</pre>
          <button className="btn btn-sm" onClick={() => void ct.reload("images")}>
            Reintentar
          </button>
        </div>
      )}
      <div className="ct-table-wrap">
        {res.images.data === null && res.images.loading ? (
          <div className="empty-state">
            <span className="spinner" />
            <div>Leyendo imágenes…</div>
          </div>
        ) : (
          <table className="ct-table">
            <thead>
              <tr>
                {th("name", "Imagen", "ct-col-name")}
                <th className="ct-col-id">ID</th>
                {th("size", "Tamaño", "ct-col-num")}
                {th("created", "Creada", "ct-col-created")}
                <th className="ct-col-state">En uso</th>
                <th className="ct-col-actions">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((img) => {
                const n = inUseCount(img, containers);
                const users = usersOf(img, containers);
                return (
                  <tr key={img.id} tabIndex={0} onKeyDown={(e) => e.target === e.currentTarget && e.key === "Delete" && remove(img)}>
                    <td className="ct-col-name mono" title={img.tags.join("\n") || "<sin nombre>"}>
                      <span className="ct-cell-flex">
                        <span className="ct-ellipsis">{img.tags[0] ?? <span className="faint">&lt;sin nombre&gt;</span>}</span>
                        {img.tags.length > 1 && <span className="ct-tag">+{img.tags.length - 1}</span>}
                      </span>
                    </td>
                    <td className="ct-col-id mono faint">{img.shortId}</td>
                    <td className="ct-col-num mono">{img.size !== null ? formatBytes(img.size) : "—"}</td>
                    <td className="ct-col-created faint">{ago(img.created)}</td>
                    <td className="ct-col-state" title={users.map((u) => u.name).join("\n")}>
                      {n > 0 ? <span className="ct-yes">Sí ({n})</span> : <span className="faint">No</span>}
                    </td>
                    <td className="ct-col-actions">
                      <span className="ct-actions">
                        <button
                          className="icon-btn ct-go"
                          title="Crear contenedor con esta imagen"
                          aria-label="Crear contenedor"
                          onClick={() => ct.openRunForm({ image: img.tags[0] ?? img.id })}
                          tabIndex={-1}
                        >
                          <Rocket size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          title="Actualizar (volver a descargar)"
                          aria-label="Actualizar imagen"
                          disabled={!img.tags[0] || img.tags[0].startsWith("localhost/")}
                          onClick={() => setPull(img.tags[0] ?? "")}
                          tabIndex={-1}
                        >
                          <Download size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          title="Ver vulnerabilidades (Administración → Vulnerabilidades)"
                          aria-label="Ver vulnerabilidades de la imagen"
                          onClick={() => useVulnNav.getState().open(ct.sessionId, img.id, img.tags[0] ?? img.shortId)}
                          tabIndex={-1}
                        >
                          <Bug size={13} />
                        </button>
                        <button className="icon-btn ct-danger" title="Eliminar" aria-label="Eliminar imagen" onClick={() => remove(img)} tabIndex={-1}>
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="ct-norows">
                    {images.length ? "Ninguna imagen coincide" : "No hay imágenes. Descarga una con «Descargar imagen»."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {pull !== null && <PullDialog initial={pull} onClose={() => setPull(null)} />}
    </div>
  );
}

/** «Total reclaimed space: 1.2GB» → texto en español. */
export function reclaimed(stdout: string): string {
  const m = /total reclaimed space:\s*(.+)/i.exec(stdout);
  if (m) return `Espacio liberado: ${m[1].trim()}`;
  const n = stdout.split("\n").filter((l) => /^[0-9a-f]{12,}$|^deleted:|^untagged:/i.test(l.trim())).length;
  return n ? `${n} elementos eliminados` : "No había nada que limpiar";
}

function PruneList({ all, images, containers, engine }: { all: boolean; images: ImageInfo[]; containers: Container[]; engine: Engine }) {
  const ct = useCt();
  const list = images.filter((i) => inUseCount(i, containers) === 0 && (all || i.dangling));
  const sum = list.reduce((s, i) => s + (i.size ?? 0), 0);
  const df = ct.res.df.data?.find((d) => d.type.toLowerCase() === "images");
  return (
    <div>
      <div className="ct-summary">
        <strong>{list.length}</strong> imágenes · hasta <strong>{formatBytes(sum)}</strong>
        {df && df.reclaimable !== null && (
          <span className="faint">
            {" "}
            · según «{engine} system df», recuperable: {formatBytes(df.reclaimable)}
          </span>
        )}
      </div>
      <div className="faint ct-small">Las capas compartidas entre imágenes solo se liberan si nadie más las usa, así que el espacio real puede ser menor.</div>
      {list.length > 0 && (
        <ul className="ct-list ct-list-scroll">
          {list.slice(0, 200).map((i) => (
            <li key={i.id} className="mono">
              {i.tags[0] ?? `<sin nombre> ${i.shortId}`} <span className="faint">{i.size !== null ? formatBytes(i.size) : ""}</span>
            </li>
          ))}
          {list.length > 200 && <li className="faint">… y {list.length - 200} más</li>}
        </ul>
      )}
    </div>
  );
}

function PullDialog({ initial, onClose }: { initial: string; onClose: () => void }) {
  const ct = useCt();
  const [ref, setRef] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [out, setOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(0);

  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [busy]);

  const v = ref.trim();
  const invalid = v ? validateImage(v) : null;
  const cmd = { ...pullImage(ct.engine, v || "<imagen>"), mergeStderr: true };

  const pull = async () => {
    if (!v || invalid || busy) return;
    setBusy(true);
    setError(null);
    setOut(null);
    started.current = Date.now();
    setElapsed(0);
    const r = await ct.run([cmd], 600);
    setBusy(false);
    if (r.ok) {
      setOut(r.result?.stdout ?? "");
      toast.success("Imagen descargada", v);
      void ct.reload("images", "df");
    } else setError(r.error);
  };

  return (
    <AdmModal title="Descargar imagen" onClose={busy ? () => {} : onClose} width={640}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void pull();
        }}
      >
        <div className="modal-body">
          <label className="field">
            <span>Imagen (registro/nombre:etiqueta)</span>
            <input
              className="input mono"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="docker.io/library/nginx:alpine"
              autoFocus
              spellCheck={false}
              disabled={busy}
            />
          </label>
          {invalid && <div className="field-error">{invalid}</div>}
          {ct.engine === "podman" && v && !v.includes("/") && (
            <div className="ct-hint-line faint">Consejo: en Podman usa el nombre completo (docker.io/library/{v}) para no depender de los registros configurados.</div>
          )}
          <pre className="ct-cmd">{ct.render(cmd)}</pre>
          {busy && (
            <div className="ct-progress-line">
              <span className="spinner ct-spinner-sm" /> Descargando… {elapsed} s
              <div className="progress ct-indeterminate">
                <div />
              </div>
            </div>
          )}
          {out !== null && <pre className="ct-output">{out.split("\n").slice(-30).join("\n") || "Listo"}</pre>}
          {error && (
            <div className="ct-error" role="alert">
              <AlertTriangle size={14} />
              <pre>{error}</pre>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn ct-footer-left"
            disabled={!v || !!invalid || busy}
            title="Ver el progreso detallado en la terminal"
            onClick={() => {
              if (ct.toTerminal(pullImage(ct.engine, v), true)) onClose();
            }}
          >
            <TerminalSquare size={13} /> En la terminal
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {out !== null ? "Cerrar" : "Cancelar"}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!v || !!invalid || busy}>
            {busy ? <span className="spinner ct-spinner-sm" /> : <Download size={13} />} Descargar
          </button>
        </div>
      </form>
    </AdmModal>
  );
}
