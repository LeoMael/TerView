// Ruta en migas de pan; clic en el espacio vacío (o Ctrl+L) la vuelve editable.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { pathSegments } from "../../lib/paths";
import { shortcutText, withShortcut } from "../../features/shortcuts/shortcuts";

interface Props {
  path: string;
  editing: boolean;
  onEditingChange: (v: boolean) => void;
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ path, editing, onEditingChange, onNavigate }: Props) {
  const [value, setValue] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    setValue(path);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [editing, path]);

  // Mantiene visible el final de la ruta cuando no cabe.
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="input mono fx-path-input"
        value={value}
        spellCheck={false}
        autoFocus
        aria-label="Ruta"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onEditingChange(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const v = value.trim();
            onEditingChange(false);
            if (v && v !== path) onNavigate(v);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onEditingChange(false);
          }
        }}
      />
    );
  }

  const segs = path ? pathSegments(path) : [];
  return (
    <div
      ref={crumbsRef}
      className="fx-crumbs"
      title={withShortcut("Clic para escribir una ruta", shortcutText("explorer.path"))}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(".fx-crumb")) onEditingChange(true);
      }}
    >
      {segs.map((s, i) => (
        <span key={s.path} className="fx-crumb-wrap">
          {i > 1 && <span className="fx-crumb-sep">/</span>}
          <button
            className={i === segs.length - 1 ? "fx-crumb current" : "fx-crumb"}
            onClick={() => s.path !== path && onNavigate(s.path)}
            tabIndex={-1}
          >
            {s.name}
          </button>
        </span>
      ))}
    </div>
  );
}
