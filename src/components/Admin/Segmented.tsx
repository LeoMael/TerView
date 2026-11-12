// Grupo de botones de opción única (filtros). Se recorre con las flechas, como un grupo de radio.
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    let n = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + options.length) % options.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = options.length - 1;
    else return;
    e.preventDefault();
    onChange(options[n].value);
    ref.current?.querySelectorAll<HTMLButtonElement>("button")[n]?.focus();
  };
  return (
    <div ref={ref} className="adm-seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? "on" : undefined}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
