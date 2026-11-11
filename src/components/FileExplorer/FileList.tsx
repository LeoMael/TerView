// Lista de archivos con columnas ordenables y ventana virtual (filas de alto fijo).
import { memo, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { FileEntry } from "../../api/types";
import { formatBytes, formatDate } from "../../lib/format";
import { EntryIcon, isDirLike } from "./icons";

export const ROW_H = 28;
export const HEADER_H = 28;
const OVERSCAN = 12;

export type SortKey = "name" | "size" | "modified" | "permissions";
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
  { key: "name", label: "Nombre", cls: "fx-c-name" },
  { key: "size", label: "Tamaño", cls: "fx-c-size" },
  { key: "modified", label: "Modificado", cls: "fx-c-date" },
  { key: "permissions", label: "Permisos", cls: "fx-c-perm" },
];

export interface RowHandlers {
  onMouseDown: (e: ReactMouseEvent, entry: FileEntry) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (e: ReactMouseEvent, entry: FileEntry) => void;
}

interface Props {
  rows: FileEntry[];
  selected: Set<string>;
  cursor: string | null;
  dropTarget: string | null;
  sort: SortState;
  onSort: (key: SortKey) => void;
  handlers: RowHandlers;
  onEmptyMouseDown: () => void;
  onEmptyContextMenu: (e: ReactMouseEvent) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Contenido a mostrar en lugar de filas (vacío, sin coincidencias…). */
  placeholder?: ReactNode;
}

export function FileList(p: Props) {
  const { rows, containerRef } = p;
  const [view, setView] = useState({ top: 0, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
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
  }, [containerRef]);

  const start = Math.max(0, Math.floor((view.top - HEADER_H) / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
  const slice = rows.slice(start, end);

  return (
    <div
      ref={containerRef}
      className="fx-list"
      role="grid"
      aria-rowcount={rows.length}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (!t.closest(".fx-row") && !t.closest(".fx-head")) p.onEmptyMouseDown();
      }}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".fx-row")) return;
        p.onEmptyContextMenu(e);
      }}
    >
      <div className="fx-head" role="row" style={{ height: HEADER_H }}>
        {COLUMNS.map((c) => (
          <button key={c.key} className={`fx-head-cell ${c.cls}`} role="columnheader" onClick={() => p.onSort(c.key)} tabIndex={-1}>
            <span>{c.label}</span>
            {p.sort.key === c.key && (p.sort.dir === 1 ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
          </button>
        ))}
      </div>
      {p.placeholder ?? (
        <div className="fx-body" style={{ height: rows.length * ROW_H }}>
          {slice.map((entry, i) => (
            <Row
              key={entry.path}
              entry={entry}
              index={start + i}
              selected={p.selected.has(entry.path)}
              cursor={p.cursor === entry.path}
              dropTarget={p.dropTarget === entry.path}
              handlers={p.handlers}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  entry: FileEntry;
  index: number;
  selected: boolean;
  cursor: boolean;
  dropTarget: boolean;
  handlers: RowHandlers;
}

const Row = memo(function Row({ entry, index, selected, cursor, dropTarget, handlers }: RowProps) {
  const dir = isDirLike(entry);
  const hidden = entry.name.startsWith(".");
  let cls = "fx-row";
  if (selected) cls += " selected";
  if (cursor) cls += " cursor";
  if (dropTarget) cls += " drop-target";
  if (hidden) cls += " hidden-file";
  return (
    <div
      className={cls}
      role="row"
      aria-selected={selected}
      style={{ transform: `translateY(${index * ROW_H}px)`, height: ROW_H }}
      data-fx-path={entry.path}
      data-fx-dir={dir ? "1" : undefined}
      onMouseDown={(e) => handlers.onMouseDown(e, entry)}
      onDoubleClick={() => handlers.onDoubleClick(entry)}
      onContextMenu={(e) => handlers.onContextMenu(e, entry)}
      title={entry.kind === "symlink" ? `${entry.name} (enlace simbólico)` : undefined}
    >
      <div className="fx-cell fx-c-name">
        <EntryIcon entry={entry} />
        <span className="fx-name-text">{entry.name}</span>
      </div>
      <div className="fx-cell fx-c-size">{dir ? "—" : formatBytes(entry.size)}</div>
      <div className="fx-cell fx-c-date">{formatDate(entry.modified)}</div>
      <div className="fx-cell fx-c-perm mono">{entry.permissionsStr}</div>
    </div>
  );
});
