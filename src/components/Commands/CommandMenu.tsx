// Menú contextual de un comando de la lista (clic derecho o Mayús+F10 / tecla de menú).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface CommandMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Raya separadora antes de este elemento. */
  sepBefore?: boolean;
  onSelect: () => void;
}

interface Props {
  x: number;
  y: number;
  items: CommandMenuItem[];
  onClose: () => void;
}

export function CommandMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length].focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="context-menu cmd-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <div key={it.label} role="none">
          {it.sepBefore && <hr />}
          <button
            role="menuitem"
            className={it.danger ? "danger" : undefined}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className="cmd-menu-icon">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
