// Inspeccionar un contenedor: resumen legible (variables, montajes, red, puertos, reinicio) + JSON completo.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Copy, Eye, EyeOff } from "lucide-react";
import { inspect, parseInspect, RESTART_LABELS, type Container, type InspectSummary, type RestartPolicy } from "../../features/containers";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { AdmModal } from "../Admin/AdmModal";
import { useCt } from "./context";

/** Variables que suelen ser secretas: se ocultan hasta que el usuario las muestre. */
const SECRET_RE = /pass|secret|token|key|pwd|credential/i;

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="ct-sec">
      <h4 className="section-label">
        {title}
        {count !== undefined && <span className="ct-count">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

function fmtDate(s: string): string {
  if (!s || s.startsWith("0001-")) return "—";
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(t) ? new Date(t).toLocaleString() : s;
}

export function InspectDialog({ container, onClose }: { container: Container; onClose: () => void }) {
  const ct = useCt();
  const [data, setData] = useState<{ summary: InspectSummary | null; raw: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [view, setView] = useState<"summary" | "json">("summary");

  useEffect(() => {
    let alive = true;
    void ct.run([inspect(ct.engine, container.id)], 30).then((r) => {
      if (!alive) return;
      if (r.ok && r.result) {
        const p = parseInspect(r.result.stdout);
        if (p.raw === null) setError("La respuesta no es JSON válido");
        setData(p);
      } else setError(r.error ?? "No se pudo inspeccionar");
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container.id]);

  const json = useMemo(() => (data?.raw ? JSON.stringify(data.raw, null, 2) : ""), [data]);
  const s = data?.summary;
  const rp = s?.restartPolicy || "no";

  return (
    <AdmModal title={`Inspeccionar «${container.name}»`} onClose={onClose} width={860}>
      <div className="modal-body ct-inspect">
        <div className="ct-toolbar">
          <div className="ct-seg ct-seg-sm" role="radiogroup" aria-label="Vista">
            <button role="radio" aria-checked={view === "summary"} className={view === "summary" ? "on" : ""} onClick={() => setView("summary")}>
              Resumen
            </button>
            <button role="radio" aria-checked={view === "json"} className={view === "json" ? "on" : ""} onClick={() => setView("json")}>
              JSON completo
            </button>
          </div>
          <span className="ct-grow" />
          <button
            className="btn btn-sm"
            disabled={!json}
            onClick={() =>
              clipboard.write(json).then(
                () => toast.success("JSON copiado"),
                (e) => toast.error("No se pudo copiar", e),
              )
            }
          >
            <Copy size={13} /> Copiar JSON
          </button>
        </div>
        {error && (
          <div className="ct-error ct-error-inline" role="alert">
            <AlertTriangle size={14} />
            <pre>{error}</pre>
          </div>
        )}
        {!data && !error && (
          <div className="empty-state">
            <span className="spinner" />
          </div>
        )}
        {view === "json" && json && <pre className="ct-json">{json}</pre>}
        {view === "summary" && s && (
          <div className="ct-inspect-grid">
            <Section title="General">
              <dl className="ct-kv">
                <dt>Imagen</dt>
                <dd className="mono">{s.image}</dd>
                <dt>Estado</dt>
                <dd>{s.state || "—"}</dd>
                <dt>Creado</dt>
                <dd>{fmtDate(s.created)}</dd>
                <dt>Iniciado</dt>
                <dd>{fmtDate(s.startedAt)}</dd>
                <dt>Reinicio</dt>
                <dd>
                  {RESTART_LABELS[rp.split(":")[0] as RestartPolicy] ?? rp} <span className="faint mono">({rp})</span>
                  {s.restartCount ? <span className="faint"> · {s.restartCount} reinicios</span> : null}
                </dd>
                <dt>Comando</dt>
                <dd className="mono ct-break">{s.command || "—"}</dd>
                {s.workingDir && (
                  <>
                    <dt>Carpeta de trabajo</dt>
                    <dd className="mono">{s.workingDir}</dd>
                  </>
                )}
                <dt>ID</dt>
                <dd className="mono ct-break">{s.id}</dd>
              </dl>
            </Section>
            <Section title="Puertos" count={s.ports.length}>
              {s.ports.length === 0 ? (
                <div className="faint">Sin puertos publicados</div>
              ) : (
                <table className="ct-mini">
                  <tbody>
                    {s.ports.map((p, i) => (
                      <tr key={i}>
                        <td className="mono">{p.host || <span className="faint">sin publicar</span>}</td>
                        <td className="faint">→</td>
                        <td className="mono">{p.container}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
            <Section title="Red" count={s.networks.length}>
              {s.networks.length === 0 ? (
                <div className="faint">Sin redes (modo de red del anfitrión o rootless sin IP propia)</div>
              ) : (
                <table className="ct-mini">
                  <tbody>
                    {s.networks.map((n) => (
                      <tr key={n.name}>
                        <td>{n.name}</td>
                        <td className="mono">{n.ip || "—"}</td>
                        <td className="faint mono">{n.gateway ? `gw ${n.gateway}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
            <Section title="Montajes" count={s.mounts.length}>
              {s.mounts.length === 0 ? (
                <div className="faint">Sin volúmenes ni carpetas montadas</div>
              ) : (
                <table className="ct-mini">
                  <tbody>
                    {s.mounts.map((m, i) => (
                      <tr key={i}>
                        <td>
                          <span className="ct-tag">{m.type === "volume" ? "volumen" : m.type === "bind" ? "carpeta" : m.type}</span>
                        </td>
                        <td className="mono ct-break">{m.type === "volume" && m.name ? m.name : m.source}</td>
                        <td className="faint">→</td>
                        <td className="mono ct-break">
                          {m.destination}
                          {!m.rw && <span className="faint"> (solo lectura)</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
            <Section title="Variables de entorno" count={s.env.length}>
              <button className="btn btn-sm ct-sec-btn" onClick={() => setShowSecrets((v) => !v)}>
                {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />} {showSecrets ? "Ocultar secretos" : "Mostrar secretos"}
              </button>
              <table className="ct-mini">
                <tbody>
                  {s.env.map((e, i) => (
                    <tr key={i}>
                      <td className="mono ct-strong">{e.key}</td>
                      <td className="mono ct-break">{SECRET_RE.test(e.key) && !showSecrets ? "●●●●●●" : e.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            {Object.keys(s.labels).length > 0 && (
              <Section title="Etiquetas" count={Object.keys(s.labels).length}>
                <table className="ct-mini">
                  <tbody>
                    {Object.entries(s.labels).map(([k, v]) => (
                      <tr key={k}>
                        <td className="mono ct-break">{k}</td>
                        <td className="mono ct-break faint">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </AdmModal>
  );
}
