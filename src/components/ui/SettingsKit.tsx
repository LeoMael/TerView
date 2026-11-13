// Piezas comunes de las pantallas de ajustes: grupo (tarjeta), fila, interruptor, selector
// segmentado y número con − / +. BASE compartida (Ajustes y las fichas que quieran el mismo aspecto).
import { useEffect, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import "./SettingsKit.css";

/** Tarjeta con título opcional que agrupa filas relacionadas. */
export function SettingGroup({ title, hint, children }: { title?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-group">
      {(title || hint) && (
        <header className="st-group-head">
          {title && <h4 className="st-group-title">{title}</h4>}
          {hint && <p className="st-group-hint">{hint}</p>}
        </header>
      )}
      <div className="st-card">{children}</div>
    </section>
  );
}

/** Fila de ajuste: etiqueta y ayuda a la izquierda, control a la derecha.
 *  `stacked` pone el control debajo (para controles anchos, como el selector de apariencia). */
export function SettingRow({
  label,
  hint,
  children,
  stacked,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? "st-row st-row-stacked" : "st-row"}>
      <div className="st-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

/** Interruptor de encendido / apagado. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "st-switch on" : "st-switch"}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/** Selector de una opción entre pocas (botones pegados). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  /** `title`: ayuda corta al pasar el ratón por la opción. */
  options: { v: T; label: string; icon?: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="st-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={String(o.v)}
          role="radio"
          aria-checked={value === o.v}
          className={value === o.v ? "active" : ""}
          title={o.title}
          onClick={() => onChange(o.v)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Número con − / + y escritura libre; confirma al salir o con Enter. */
export function NumberStepper({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = () => {
    const n = Number(text.replace(",", "."));
    if (Number.isFinite(n)) onChange(clamp(Math.round(n / step) * step));
    else setText(String(value));
  };
  return (
    <div className="st-stepper">
      <button type="button" className="icon-btn" onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label="Menos">
        <Minus size={14} />
      </button>
      <input
        className="input st-num"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onChange(clamp(value + step));
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onChange(clamp(value - step));
          }
        }}
      />
      {suffix && <span className="st-suffix">{suffix}</span>}
      <button type="button" className="icon-btn" onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label="Más">
        <Plus size={14} />
      </button>
    </div>
  );
}
