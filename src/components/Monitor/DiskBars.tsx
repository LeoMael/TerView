// Uso de cada disco (punto de montaje) en barras.
import { formatBytes } from "../../lib/format";
import type { DiskUsage } from "../../features/monitor";

export function DiskBars({ disks, limit }: { disks: DiskUsage[]; limit: number }) {
  if (!disks.length) return <div className="muted mon-empty-row">No se encontraron discos</div>;
  return (
    <ul className="mon-disks" aria-label="Uso de los discos">
      {disks.map((d) => {
        const level = d.pct >= limit ? "crit" : d.pct >= limit - 10 ? "warn" : "ok";
        const label = `${d.mount}: ${d.pct} % usado, ${formatBytes(d.usedKb * 1024)} de ${formatBytes(d.sizeKb * 1024)}, quedan ${formatBytes(d.availKb * 1024)}`;
        return (
          <li key={d.mount} className="mon-disk" title={`${d.fs} → ${d.mount}`}>
            <div className="mon-disk-head">
              <span className="mon-disk-mount mono">{d.mount}</span>
              <span className="mon-disk-num">
                <strong>{d.pct} %</strong>
                <span className="muted">
                  {" "}
                  · {formatBytes(d.usedKb * 1024)} de {formatBytes(d.sizeKb * 1024)}
                </span>
              </span>
            </div>
            <div
              className="mon-meter"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={d.pct}
              aria-label={label}
            >
              <div className={`mon-meter-fill mon-${level}`} style={{ width: `${Math.min(100, d.pct)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
