// Gráfica de área ligera en SVG (sin librerías): últimos minutos, cruz al pasar el ratón y por teclado.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { HistoryPoint } from "../../features/monitor";

export interface ChartSeries {
  key: keyof Omit<HistoryPoint, "t">;
  label: string;
  /** Variable CSS del color (p. ej. "--accent"). */
  color: string;
}

interface AreaChartProps {
  points: HistoryPoint[];
  series: ChartSeries[];
  /** Ventana visible (ms) que acaba en el último punto. */
  windowMs: number;
  /** Máximo fijo del eje Y (p. ej. 100 para %). Sin él se ajusta a los datos. */
  max?: number;
  /** Línea de referencia horizontal (p. ej. nº de CPU en la carga). */
  reference?: { value: number; label: string };
  format: (v: number) => string;
  height?: number;
  ariaLabel: string;
  /** Sin cruz ni etiquetas (tarjetas del resumen). */
  compact?: boolean;
}

/** Alto de la fila de la escala, encima de la gráfica (para que la etiqueta no tape los datos). */
const SCALE_ROW = 13;

/** Hueco entre muestras a partir del cual se corta la línea (p. ej. el panel estuvo oculto). */
const GAP_MS = 35000;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

const clock = (t: number) => {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function AreaChart({
  points,
  series,
  windowMs,
  max,
  reference,
  format,
  height = 64,
  ariaLabel,
  compact = false,
}: AreaChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const end = points.length ? points[points.length - 1].t : Date.now();
  const start = end - windowMs;
  const visible = useMemo(() => points.filter((p) => p.t >= start), [points, start]);

  // Si llega un punto nuevo mientras se navega con el teclado, la cruz no se sale del rango.
  useEffect(() => {
    if (hover !== null && hover >= visible.length) setHover(visible.length ? visible.length - 1 : null);
  }, [hover, visible.length]);

  const yMax = useMemo(() => {
    if (max !== undefined) return max;
    let m = reference?.value ?? 0;
    for (const p of visible) for (const s of series) m = Math.max(m, p[s.key] ?? 0);
    return niceMax(m * 1.1);
  }, [max, visible, series, reference]);

  const padTop = compact ? 2 : 4;
  const h = height;
  const w = Math.max(0, width);
  const x = (t: number) => ((t - start) / windowMs) * w;
  const y = (v: number) => padTop + (1 - Math.min(1, Math.max(0, v / yMax))) * (h - padTop - 1);

  const paths = useMemo(() => {
    return series.map((s) => {
      let line = "";
      let area = "";
      let seg: [number, number][] = [];
      const flush = () => {
        if (!seg.length) return;
        const d = seg.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
        line += d;
        const base = (h - 0.5).toFixed(1);
        area += `${d}L${seg[seg.length - 1][0].toFixed(1)},${base}L${seg[0][0].toFixed(1)},${base}Z`;
        seg = [];
      };
      let lastT = -Infinity;
      for (const p of visible) {
        const v = p[s.key];
        if (v === null || p.t - lastT > GAP_MS) flush();
        if (v !== null) seg.push([x(p.t), y(v)]);
        lastT = p.t;
      }
      flush();
      return { key: s.key, color: s.color, line, area };
    });
    // x/y dependen de w, start, yMax y h.
  }, [visible, series, w, start, yMax, h]);

  const hp = hover !== null ? visible[hover] : null;

  const pick = (clientX: number) => {
    const el = wrapRef.current;
    if (!el || !visible.length) return;
    const rect = el.getBoundingClientRect();
    const t = start + ((clientX - rect.left) / rect.width) * windowMs;
    let best = 0;
    for (let i = 1; i < visible.length; i++) if (Math.abs(visible[i].t - t) < Math.abs(visible[best].t - t)) best = i;
    setHover(best);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!visible.length) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const cur = hover ?? visible.length - 1;
      setHover(Math.max(0, Math.min(visible.length - 1, cur + (e.key === "ArrowLeft" ? -1 : 1))));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHover(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHover(visible.length - 1);
    } else if (e.key === "Escape") {
      setHover(null);
    }
  };

  const tipLeft = hp ? Math.min(Math.max(x(hp.t), 60), Math.max(60, w - 60)) : 0;

  return (
    <div
      ref={wrapRef}
      className={compact ? "mon-chart mon-chart-compact" : "mon-chart"}
      style={{ height: compact ? h : h + SCALE_ROW }}
      role="img"
      aria-label={ariaLabel}
      tabIndex={compact ? -1 : 0}
      onPointerMove={compact ? undefined : (e) => pick(e.clientX)}
      onPointerLeave={compact ? undefined : () => setHover(null)}
      onKeyDown={compact ? undefined : onKey}
      onBlur={() => setHover(null)}
    >
      {w > 0 && (
        <svg width={w} height={h} aria-hidden="true">
          {!compact && (
            <>
              <line className="mon-grid" x1={0} x2={w} y1={y(yMax / 2)} y2={y(yMax / 2)} />
              <line className="mon-grid" x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} />
            </>
          )}
          {reference && reference.value <= yMax && (
            <line className="mon-ref" x1={0} x2={w} y1={y(reference.value)} y2={y(reference.value)} />
          )}
          {paths.map((p) => (
            <g key={p.key} style={{ color: `var(${p.color})` }}>
              <path d={p.area} className="mon-area" />
              <path d={p.line} className="mon-line" />
            </g>
          ))}
          {hp && (
            <>
              <line className="mon-cross" x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={h} />
              {series.map((s) => {
                const v = hp[s.key];
                return v === null ? null : (
                  <circle key={s.key} className="mon-dot" cx={x(hp.t)} cy={y(v)} r={4} style={{ color: `var(${s.color})` }} />
                );
              })}
            </>
          )}
        </svg>
      )}
      {!compact && (
        <span className="mon-chart-scale" aria-hidden="true">
          {reference && reference.value <= yMax ? reference.label : format(yMax)}
        </span>
      )}
      {hp && (
        <div className="mon-tip" style={{ left: tipLeft }} aria-live="polite">
          {series.map((s) => {
            const v = hp[s.key];
            return (
              <div key={s.key} className="mon-tip-row">
                <span className="mon-key" style={{ background: `var(${s.color})` }} />
                <strong>{v === null ? "—" : format(v)}</strong>
                {series.length > 1 && <span className="muted">{s.label}</span>}
              </div>
            );
          })}
          <div className="faint">{clock(hp.t)}</div>
        </div>
      )}
    </div>
  );
}
