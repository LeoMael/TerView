// Informe visual de "Analizar servidor".
import type { ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Copy, Cpu, HardDrive, MemoryStick, RefreshCw, Server, Timer } from "lucide-react";
import { formatBytes } from "../../lib/format";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { DISTRO_LABEL } from "./catalog";
import { formatUptime, type ProcRow, type Report } from "./analysis";

export interface AnalysisState {
  running: boolean;
  report: Report | null;
  raw: string;
  stderr: string;
  error: string | null;
  at: number;
  durationMs: number;
}

const WARN_PCT = 85;

function Bar({ pct, label }: { pct: number; label?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const cls = p > WARN_PCT ? "bad" : p > 70 ? "mid" : "ok";
  return (
    <div className="cmd-bar" title={label ?? `${p.toFixed(0)} %`}>
      <div className={`cmd-bar-fill ${cls}`} style={{ width: `${p}%` }} />
    </div>
  );
}

function Card({ title, icon, children, wide }: { title: string; icon?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`cmd-card${wide ? " wide" : ""}`}>
      <h3>
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function ProcTable({ rows }: { rows: ProcRow[] }) {
  if (!rows.length) return <div className="faint">Sin datos</div>;
  return (
    <table className="cmd-table">
      <thead>
        <tr>
          <th className="cmd-col-pid">PID</th>
          <th className="cmd-col-user">Usuario</th>
          <th className="num">CPU %</th>
          <th className="num">Mem %</th>
          <th className="num">RSS</th>
          <th>Proceso</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.pid}>
            <td className="mono">{r.pid}</td>
            <td>{r.user}</td>
            <td className="num mono">{r.cpu.toFixed(1)}</td>
            <td className="num mono">{r.mem.toFixed(1)}</td>
            <td className="num mono">{formatBytes(r.rss)}</td>
            <td className="mono cmd-ellipsis" title={r.command}>
              {r.command}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AnalysisReport({
  state,
  onRerun,
  onClose,
  disabled,
}: {
  state: AnalysisState;
  onRerun: () => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const r = state.report;
  const copyRaw = async () => {
    try {
      await clipboard.write(state.raw);
      toast.success("Salida copiada");
    } catch (e) {
      toast.error("No se pudo copiar", e);
    }
  };

  return (
    <div className="cmd-report">
      <div className="cmd-report-head">
        <button className="icon-btn" title="Volver a la biblioteca" onClick={onClose}>
          <ArrowLeft size={16} />
        </button>
        <h2>Informe del servidor</h2>
        {r?.host && <span className="muted mono">{r.user ? `${r.user}@${r.host}` : r.host}</span>}
        <span className="cmd-spacer" />
        {!state.running && state.at > 0 && (
          <span className="faint">
            {new Date(state.at).toLocaleTimeString()} · {(state.durationMs / 1000).toFixed(1)} s
          </span>
        )}
        {state.raw && (
          <button className="icon-btn" title="Copiar salida en bruto" onClick={copyRaw}>
            <Copy size={14} />
          </button>
        )}
        <button className="btn btn-sm" disabled={state.running || disabled} onClick={onRerun}>
          <RefreshCw size={13} /> Volver a analizar
        </button>
      </div>

      {state.running && !r && (
        <div className="empty-state">
          <div className="spinner" />
          Analizando el servidor (solo lectura)…
        </div>
      )}
      {state.error && <div className="cmd-result-error cmd-report-error">{state.error}</div>}

      {r && (
        <div className="cmd-report-body">
          {r.incomplete && (
            <div className="cmd-notice warn">
              <AlertTriangle size={14} /> El análisis no terminó a tiempo: el informe puede estar incompleto.
            </div>
          )}
          <div className="cmd-cards">
            <Card title="Sistema" icon={<Server size={14} />}>
              <div className="cmd-kv">
                <span>Sistema</span>
                <b>{r.osName ?? "Desconocido"}</b>
                <span>Kernel</span>
                <b className="mono">{r.kernel ?? "—"}</b>
                <span>Equipo</span>
                <b className="mono">{r.host ?? "—"}</b>
                <span>Paquetes</span>
                <b>{r.distro ? `${DISTRO_LABEL[r.distro]} (${{ rpm: "dnf", deb: "apt", apk: "apk" }[r.distro]})` : "—"}</b>
              </div>
            </Card>

            <Card title="CPU y carga" icon={<Cpu size={14} />}>
              <div className="cmd-kv">
                <span>CPUs</span>
                <b>{r.cpus ?? "—"}</b>
                {r.cpuModel && (
                  <>
                    <span>Modelo</span>
                    <b className="cmd-ellipsis" title={r.cpuModel}>
                      {r.cpuModel}
                    </b>
                  </>
                )}
                <span>Carga</span>
                <b className="mono">{r.load ? r.load.map((x) => x.toFixed(2)).join("  ") : "—"}</b>
              </div>
              {r.load && r.cpus && (
                <div className="cmd-meter">
                  <div className="cmd-meter-label">
                    <span>Carga (1 min) / CPUs</span>
                    <span className={r.load[0] / r.cpus > WARN_PCT / 100 ? "cmd-bad" : ""}>
                      {((r.load[0] / r.cpus) * 100).toFixed(0)} %
                    </span>
                  </div>
                  <Bar pct={(r.load[0] / r.cpus) * 100} />
                </div>
              )}
            </Card>

            <Card title="Tiempo encendido" icon={<Timer size={14} />}>
              <div className="cmd-big">{r.uptimeSecs !== null ? formatUptime(r.uptimeSecs) : "—"}</div>
              {r.uptimeSecs !== null && (
                <div className="faint">desde {new Date(Date.now() - r.uptimeSecs * 1000).toLocaleString()}</div>
              )}
            </Card>

            <Card title="Memoria" icon={<MemoryStick size={14} />}>
              {r.mem && r.mem.total > 0 ? (
                <>
                  <Meter label="RAM" used={r.mem.total - r.mem.available} total={r.mem.total} />
                  {r.mem.swapTotal > 0 ? (
                    <Meter label="Swap" used={r.mem.swapTotal - r.mem.swapFree} total={r.mem.swapTotal} />
                  ) : (
                    <div className="faint">Sin swap</div>
                  )}
                </>
              ) : (
                <div className="faint">Sin datos</div>
              )}
            </Card>

            <Card title="Discos" icon={<HardDrive size={14} />} wide>
              {r.disks.length === 0 ? (
                <div className="faint">Sin datos</div>
              ) : (
                <table className="cmd-table">
                  <thead>
                    <tr>
                      <th>Montaje</th>
                      <th>Dispositivo</th>
                      <th className="num">Tamaño</th>
                      <th className="num">Usado</th>
                      <th className="num">Libre</th>
                      <th className="cmd-col-bar">Uso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.disks.map((d) => (
                      <tr key={d.mount} className={d.pct > WARN_PCT ? "cmd-row-bad" : undefined}>
                        <td className="mono">{d.mount}</td>
                        <td className="mono faint cmd-ellipsis" title={d.fs}>
                          {d.fs}
                        </td>
                        <td className="num mono">{formatBytes(d.size)}</td>
                        <td className="num mono">{formatBytes(d.used)}</td>
                        <td className="num mono">{formatBytes(d.avail)}</td>
                        <td className="cmd-col-bar">
                          <div className="cmd-bar-row">
                            <Bar pct={d.pct} />
                            <span className={`mono${d.pct > WARN_PCT ? " cmd-bad" : ""}`}>{d.pct.toFixed(0)} %</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Procesos que más CPU usan" wide>
              {r.psRaw ? <pre className="cmd-out">{r.psRaw}</pre> : <ProcTable rows={r.topCpu} />}
            </Card>
            <Card title="Procesos que más memoria usan" wide>
              {r.psRaw ? <div className="faint">El servidor no permite ordenar procesos (ps mínimo).</div> : <ProcTable rows={r.topMem} />}
            </Card>

            <Card title="Servicios fallidos">
              {r.failed === null ? (
                <div className="faint">systemd no está disponible en este servidor.</div>
              ) : r.failed.length === 0 ? (
                <div className="cmd-good">Ninguno ✓</div>
              ) : (
                <ul className="cmd-list-plain">
                  {r.failed.map((f) => (
                    <li key={f} className="cmd-bad mono">
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Contenedores">
              {r.containers.length === 0 ? (
                <div className="faint">Ni Podman ni Docker están instalados.</div>
              ) : (
                r.containers.map((c) => (
                  <div key={c.engine} className="cmd-engine">
                    <div className="cmd-engine-name">
                      {c.engine === "podman" ? "Podman" : "Docker"}{" "}
                      <span className="faint">
                        {c.rows.filter((x) => x.running).length} en marcha · {c.rows.length} en total
                      </span>
                    </div>
                    {c.error && <div className="cmd-bad cmd-small">{c.error}</div>}
                    <div className="cmd-engine-rows">
                      {[...c.rows]
                        .sort((a, b) => Number(b.running) - Number(a.running))
                        .map((x) => (
                          <div key={x.name} className="cmd-ctr" title={`${x.image}\n${x.status}`}>
                            <span className={`status-dot${x.running ? " on" : ""}`} />
                            <span className="mono cmd-ellipsis">{x.name}</span>
                            <span className="faint cmd-ellipsis">{x.status}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))
              )}
            </Card>

            <Card title="Puertos a la escucha" wide>
              {r.ports === null ? (
                <div className="faint">{r.portsNote}</div>
              ) : r.ports.length === 0 ? (
                <div className="faint">Ningún puerto a la escucha (o sin permisos para verlos).</div>
              ) : (
                <>
                  {r.portsNote && <div className="faint cmd-small">{r.portsNote}</div>}
                  <table className="cmd-table">
                    <thead>
                      <tr>
                        <th className="cmd-col-pid">Proto</th>
                        <th className="num">Puerto</th>
                        <th>Dirección</th>
                        <th>Proceso</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.ports.slice(0, 60).map((p, i) => (
                        <tr key={`${p.proto}-${p.local}-${p.port}-${i}`}>
                          <td>{p.proto}</td>
                          <td className="num mono">{p.port}</td>
                          <td className="mono">{p.local}</td>
                          <td className="mono">{p.process || <span className="faint">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {r.ports.length > 60 && <div className="faint cmd-small">… y {r.ports.length - 60} más</div>}
                </>
              )}
            </Card>

            <Card title="Últimos errores del sistema" wide>
              {r.journal === null ? (
                <div className="faint">No hay journal ni logs del sistema legibles.</div>
              ) : r.journal.lines.length === 0 ? (
                <div className="cmd-good">Sin errores recientes ✓</div>
              ) : (
                <pre className="cmd-out cmd-journal">{r.journal.lines.join("\n")}</pre>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Meter({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return (
    <div className="cmd-meter">
      <div className="cmd-meter-label">
        <span>{label}</span>
        <span className={pct > WARN_PCT ? "cmd-bad" : ""}>
          {formatBytes(used)} / {formatBytes(total)} · {pct.toFixed(0)} %
        </span>
      </div>
      <Bar pct={pct} />
    </div>
  );
}
