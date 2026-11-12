// Resumen del informe: tarjetas por gravedad, «con arreglo» y diferencia con el análisis anterior.
import type { Report, Severity } from "../../api/vulnscan";
import { SEV_LABEL } from "./vulnUi";

export interface ScanDiff {
  added: number;
  fixed: number;
}

/** Diferencia por clave de hallazgo (sin contar lo «sin importancia»). */
export function diffReports(cur: Report, prev: Report): ScanDiff {
  const keys = (r: Report) => new Set(r.findings.filter((f) => !f.unimportant).map((f) => f.key));
  const a = keys(cur);
  const b = keys(prev);
  let added = 0;
  let fixed = 0;
  for (const k of a) if (!b.has(k)) added++;
  for (const k of b) if (!a.has(k)) fixed++;
  return { added, fixed };
}

const CARDS: Severity[] = ["critical", "high", "medium", "low"];

export function VulnSummary({
  report,
  diff,
  severity,
  onSeverity,
}: {
  report: Report;
  diff: ScanDiff | null;
  severity: Severity | "all";
  onSeverity: (s: Severity | "all") => void;
}) {
  const s = report.summary;
  const n: Record<Severity, number> = { critical: s.critical, high: s.high, medium: s.medium, low: s.low, unknown: s.unknown };
  const pick = (v: Severity) => onSeverity(severity === v ? "all" : v);
  return (
    <div className="vs-summary">
      {CARDS.map((c) => (
        <button
          key={c}
          className={`vs-card vs-card-${c}${severity === c ? " on" : ""}`}
          onClick={() => pick(c)}
          aria-pressed={severity === c}
          title={`Ver solo gravedad ${SEV_LABEL[c].toLowerCase()}`}
        >
          <span className="vs-card-n">{n[c]}</span>
          <span className="vs-card-l">{SEV_LABEL[c]}</span>
        </button>
      ))}
      <div className="vs-summary-side">
        <button
          className={`vs-link${severity === "unknown" ? " on" : ""}`}
          onClick={() => pick("unknown")}
          title="Sin gravedad de la distro ni CVSS"
        >
          Sin clasificar: <strong>{s.unknown}</strong>
        </button>
        <span>
          Con arreglo: <strong>{s.withFix}</strong> de {s.total}
        </span>
        {diff && (
          <span title="Comparado con el análisis anterior de este servidor">
            {diff.added === 0 && diff.fixed === 0 ? (
              <span className="faint">Igual que el análisis anterior</span>
            ) : (
              <>
                <span className={diff.added ? "vs-up" : "faint"}>+{diff.added} nuevas</span>
                {", "}
                <span className={diff.fixed ? "vs-down" : "faint"}>−{diff.fixed} arregladas</span>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
