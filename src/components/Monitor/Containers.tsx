// Contenedores (docker / podman stats --no-stream), cada 10 s mientras la sección está activa.
import type { ContainersState } from "../../features/monitor";
import { fmtPct } from "./format";

export function Containers({ state }: { state: ContainersState }) {
  const { result, error, loading } = state;
  if (!result && loading) {
    return (
      <div className="muted mon-empty-row">
        <span className="spinner" /> Leyendo contenedores…
      </div>
    );
  }
  if (!result) return error ? <div className="mon-error">{error}</div> : null;
  return (
    <>
      {error && <div className="mon-error">{error}</div>}
      {result.errors.map((e) => (
        <div key={e.engine} className="mon-error" title={e.message}>
          {e.engine}: {e.message}
        </div>
      ))}
      {result.containers.length ? (
        <div className="mon-table-wrap">
          <table className="mon-table" aria-label="Consumo de los contenedores">
            <thead>
              <tr>
                <th className="mon-name">Nombre</th>
                <th>Motor</th>
                <th className="mon-num">CPU</th>
                <th className="mon-num">Memoria</th>
                <th className="mon-num">Uso de memoria</th>
                <th className="mon-num">Red (entra / sale)</th>
                <th className="mon-num">Disco (lee / escribe)</th>
              </tr>
            </thead>
            <tbody>
              {result.containers.map((c) => (
                <tr key={`${c.engine}:${c.id}:${c.name}`}>
                  <td className="mon-name" title={`${c.name} (${c.id})`}>
                    {c.name}
                  </td>
                  <td className="muted">{c.engine}</td>
                  <td className="mon-num mono">{c.cpuPct === null ? "—" : fmtPct(c.cpuPct)}</td>
                  <td className="mon-num mono">{c.memPct === null ? "—" : fmtPct(c.memPct)}</td>
                  <td className="mon-num mono">{c.memUsage || "—"}</td>
                  <td className="mon-num mono">{c.netIO || "—"}</td>
                  <td className="mon-num mono">{c.blockIO || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !result.errors.length && <div className="muted mon-empty-row">No hay contenedores en marcha</div>
      )}
    </>
  );
}
