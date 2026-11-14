// Panel lateral con el detalle de un hallazgo (o de la fila agrupada del kernel).
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Box, CloudDownload, ExternalLink, RotateCcw, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage } from "../../api/core";
import { vulnscan, type Finding, type Report, type Target, type VulnDetail as Detail } from "../../api/vulnscan";
import { canUpdateImage, fixSuggestion, kernelSuggestion, targetOf, type FixSuggestion, type SudoTool } from "../../features/vulnscan";
import { toast } from "../../stores/toasts";
import { useAdmin } from "./context";
import { CommandActions, findingLinks, originLabel, SevTag, SOURCE_LABEL } from "./vulnUi";

const ImageUpdateDialog = lazy(() => import("./ImageUpdateDialog").then((m) => ({ default: m.ImageUpdateDialog })));

function open(url: string) {
  openUrl(url).catch((e) => toast.error("No se pudo abrir el enlace", e));
}

/** Botón «Actualizar imagen» y qué contenedores se recrean (según el último análisis). */
function ImageUpdate({ report, target }: { report: Report; target: Target }) {
  const { disabled } = useAdmin();
  const [open, setOpen] = useState(false);
  const names = target.image?.containers.map((c) => c.name) ?? [];
  return (
    <>
      <div className="vs-d-actions">
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setOpen(true)}
          disabled={disabled}
          title="Descarga la versión nueva y recrea sus contenedores. Antes muestra los comandos y pide confirmación."
        >
          <CloudDownload size={12} /> Actualizar imagen
        </button>
      </div>
      <p className="vs-d-recreate">
        {names.length ? (
          <>
            Se recrean: <strong>{names.join(", ")}</strong>
          </>
        ) : (
          <span className="faint">Ningún contenedor la usa: solo se descarga la versión nueva.</span>
        )}
      </p>
      {open && (
        <Suspense fallback={null}>
          <ImageUpdateDialog report={report} target={target} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

function Fix({ sessionId, fix, update }: { sessionId: string; fix: FixSuggestion; update?: ReactNode }) {
  return (
    <section className="vs-d-sec">
      <h4>Cómo arreglarlo</h4>
      {update}
      {fix.command && (
        <>
          <pre className="mono vs-cmd">{fix.command}</pre>
          <div className="vs-d-actions">
            <CommandActions sessionId={sessionId} text={fix.command} />
          </div>
        </>
      )}
      {fix.notes.map((n, i) => (
        <p key={i} className="vs-d-note">
          {n}
        </p>
      ))}
      <p className="vs-d-note faint">
        {update
          ? "«Actualizar imagen» muestra los comandos exactos y pide confirmación antes de ejecutar nada."
          : "SSHorus no lo ejecuta: revísalo antes de pulsar Enter."}
      </p>
    </section>
  );
}

function Containers({ report, f }: { report: Report; f: Finding }) {
  const img = targetOf(report, f)?.image;
  if (!img) return null;
  return (
    <section className="vs-d-sec">
      <h4>Imagen</h4>
      <div className="mono vs-d-wrap">{img.tags.join(", ") || "(sin etiqueta)"}</div>
      <div className="faint">
        {img.id}
        {img.os ? ` · ${img.os}` : ""}
        {img.method ? ` · leída: ${img.method}` : ""}
      </div>
      {img.containers.length ? (
        <ul className="vs-d-list">
          {img.containers.map((c) => (
            <li key={c.id}>
              <Box size={12} /> {c.name} <span className="faint">({c.state})</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="faint">Ningún contenedor la usa.</div>
      )}
    </section>
  );
}

export function VulnDetail({
  report,
  finding,
  kernel,
  sessionId,
  tool,
  onClose,
}: {
  report: Report;
  /** El hallazgo (null si es la fila agrupada del kernel). */
  finding: Finding | null;
  /** Hallazgos del kernel (fila agrupada). */
  kernel: Finding[] | null;
  sessionId: string;
  tool: SudoTool;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = finding?.id ?? null;

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!id) return;
    let alive = true;
    setLoading(true);
    vulnscan
      .detail(id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  if (!finding && kernel) {
    const fix = kernelSuggestion(report, kernel, tool);
    const pkgs = [...new Set(kernel.map((k) => `${k.package} ${k.installed}`))];
    return (
      <aside className="vs-detail" aria-label="Detalle del kernel">
        <div className="vs-d-head">
          <RotateCcw size={14} />
          <strong>Kernel: {kernel.length} vulnerabilidades</strong>
          <span className="adm-spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar detalle">
            <X size={14} />
          </button>
        </div>
        <div className="vs-d-body">
          <p>Actualiza el kernel y reinicia: así se arreglan todas a la vez. Despliega la fila para verlas una por una.</p>
          <section className="vs-d-sec">
            <h4>Instalado</h4>
            {pkgs.map((p) => (
              <div key={p} className="mono">
                {p}
              </div>
            ))}
            {report.host.kernel && <div className="faint">En uso ahora (uname): {report.host.kernel}</div>}
          </section>
          <Fix sessionId={sessionId} fix={fix} />
        </div>
      </aside>
    );
  }
  if (!finding) return null;
  const f = finding;
  const fix = fixSuggestion(report, f, tool);
  const target = targetOf(report, f);
  const links = findingLinks(report, f);
  const sevBits: string[] = [];
  if (f.distroSeverity) sevBits.push(`${f.upstream || targetOf(report, f)?.kind === "image" ? "Base" : "Distro"}: ${f.distroSeverity}`);
  if (f.cvss !== null) sevBits.push(`CVSS ${f.cvss.toLocaleString("es")}`);

  return (
    <aside className="vs-detail" aria-label={`Detalle de ${f.id}`}>
      <div className="vs-d-head">
        <SevTag s={f.severity} />
        <strong className="mono vs-d-id">{f.id}</strong>
        <span className="adm-spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Cerrar detalle">
          <X size={14} />
        </button>
      </div>
      <div className="vs-d-body">
        {(f.aliases.length > 0 || f.advisories.length > 0) && (
          <div className="vs-d-wrap faint mono">{[...f.advisories, ...f.aliases].join(" · ")}</div>
        )}
        {f.summary && <p className="vs-d-summary">{f.summary}</p>}
        <dl className="vs-d-grid">
          <dt>Paquete</dt>
          <dd className="mono">
            {f.package}
            {f.binaries.length > 0 && f.binaries.join(",") !== f.package && (
              <div className="faint vs-d-wrap">{f.binaries.join(", ")}</div>
            )}
          </dd>
          <dt>Instalada</dt>
          <dd className="mono">{f.installed || "—"}</dd>
          <dt>Arreglada en</dt>
          <dd className="mono">{f.fixed ?? (f.hasFix ? "hay arreglo" : <span className="faint">aún sin arreglo</span>)}</dd>
          <dt>Gravedad</dt>
          <dd>{sevBits.length ? sevBits.join(" · ") : "Sin datos"}</dd>
          {f.status && (
            <>
              <dt>Estado</dt>
              <dd>{f.status}</dd>
            </>
          )}
          <dt>Dónde</dt>
          <dd>{originLabel(report, f.target)}</dd>
          <dt>Fuente</dt>
          <dd>{f.sources.map((s) => SOURCE_LABEL[s]).join(", ")}</dd>
        </dl>
        {f.unimportant && <p className="vs-d-note">La distro lo considera sin importancia (no suele afectar en la práctica).</p>}
        {f.upstream && <p className="vs-d-note">Programa sin paquete de la distro: se compara su versión de origen, el resultado es aproximado.</p>}
        <Containers report={report} f={f} />
        <Fix sessionId={sessionId} fix={fix} update={target && canUpdateImage(target) ? <ImageUpdate report={report} target={target} /> : undefined} />
        <section className="vs-d-sec">
          <h4>Descripción</h4>
          {loading && <span className="spinner adm-spinner-btn" aria-label="Cargando" />}
          {error && <div className="faint">No se pudo leer la descripción de OSV: {error}</div>}
          {detail?.details && <div className="vs-d-text">{detail.details}</div>}
          {detail && !detail.details && !detail.summary && <div className="faint">OSV no tiene descripción para este aviso.</div>}
          {detail?.published && <div className="faint">Publicado: {detail.published.slice(0, 10)}</div>}
        </section>
        <section className="vs-d-sec">
          <h4>Enlaces</h4>
          <div className="vs-d-links">
            {links.map((l) => (
              <button key={l.url} className="vs-link" onClick={() => open(l.url)} title={l.url}>
                <ExternalLink size={11} /> {l.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}
