// Tabla densa con ventana virtual (filas de alto fijo) y navegación con teclado.
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

export const ROW_H = 28;
const OVERSCAN = 10;

export interface Column<T> {
  key: string;
  label: string;
  /** Ancho para grid-template-columns (p. ej. "120px", "minmax(140px, 1fr)"). */
  width: string;
  render: (row: T) => ReactNode;
  /** Texto para el title de la celda (truncada). */
  title?: (row: T) => string;
  align?: "right";
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selected: string | null;
  onSelect: (key: string) => void;
  /** Enter o doble clic. */
  onActivate?: (row: T) => void;
  onContextMenu?: (e: MouseEvent, row: T) => void;
  /** Teclas extra (Supr…) con la fila seleccionada. */
  onKey?: (e: KeyboardEvent, row: T) => void;
  rowClass?: (row: T) => string;
  placeholder?: ReactNode;
  label: string;
}

function VirtualTableInner<T>(p: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  const template = p.columns.map((c) => c.width).join(" ");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  const index = p.selected === null ? -1 : p.rows.findIndex((r) => p.rowKey(r) === p.selected);

  const scrollTo = useCallback((i: number) => {
    const el = ref.current;
    if (!el) return;
    const top = i * ROW_H;
    const bottom = top + ROW_H + ROW_H; // + cabecera
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!p.rows.length) return;
    const page = Math.max(1, Math.floor(view.height / ROW_H) - 1);
    let next = index;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(p.rows.length - 1, index + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, index < 0 ? 0 : index - 1);
        break;
      case "PageDown":
        next = Math.min(p.rows.length - 1, index + page);
        break;
      case "PageUp":
        next = Math.max(0, index - page);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = p.rows.length - 1;
        break;
      case "Enter":
        if (index >= 0 && p.onActivate) {
          e.preventDefault();
          p.onActivate(p.rows[index]);
        }
        return;
      default:
        if (index >= 0) p.onKey?.(e, p.rows[index]);
        return;
    }
    e.preventDefault();
    if (next !== index && next >= 0) {
      p.onSelect(p.rowKey(p.rows[next]));
      scrollTo(next);
    }
  };

  const start = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const end = Math.min(p.rows.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);

  return (
    <div
      ref={ref}
      className="adm-table"
      role="grid"
      aria-label={p.label}
      aria-rowcount={p.rows.length + 1}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="adm-thead" role="row" style={{ gridTemplateColumns: template }}>
        {p.columns.map((c) => (
          <div key={c.key} role="columnheader" className={c.align === "right" ? "adm-right" : undefined}>
            {c.label}
          </div>
        ))}
      </div>
      {p.rows.length === 0 && p.placeholder ? (
        <div className="adm-table-empty">{p.placeholder}</div>
      ) : (
        <div className="adm-tbody" style={{ height: p.rows.length * ROW_H }}>
          {p.rows.slice(start, end).map((row, i) => {
            const k = p.rowKey(row);
            const sel = k === p.selected;
            return (
              <div
                key={k}
                role="row"
                aria-rowindex={start + i + 2}
                aria-selected={sel}
                className={`adm-tr${sel ? " sel" : ""}${p.rowClass ? ` ${p.rowClass(row)}` : ""}`}
                style={{ top: (start + i) * ROW_H, gridTemplateColumns: template }}
                onMouseDown={(e) => {
                  if (e.button === 0 || e.button === 2) p.onSelect(k);
                }}
                onDoubleClick={() => p.onActivate?.(row)}
                onContextMenu={(e) => {
                  if (!p.onContextMenu) return;
                  e.preventDefault();
                  p.onSelect(k);
                  p.onContextMenu(e, row);
                }}
              >
                {p.columns.map((c) => (
                  <div
                    key={c.key}
                    role="gridcell"
                    className={c.align === "right" ? "adm-right" : undefined}
                    title={c.title?.(row)}
                  >
                    {c.render(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const VirtualTable = memo(VirtualTableInner) as typeof VirtualTableInner;
