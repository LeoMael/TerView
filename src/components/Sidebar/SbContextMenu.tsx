// Menú contextual de la barra lateral (con submenús y teclado).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

export type MenuItem =
  | "separator"
  | {
      label: string;
      icon?: ReactNode;
      onClick?: () => void;
      danger?: boolean;
      disabled?: boolean;
      submenu?: MenuItem[];
    };

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function SbContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest(".sb-menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onBlur = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [onClose]);

  return createPortal(<MenuPanel x={x} y={y} items={items} onClose={onClose} autoFocus />, document.body);
}

function MenuPanel({
  x,
  y,
  items,
  onClose,
  autoFocus,
  onBack,
}: Props & { autoFocus?: boolean; onBack?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number; focus: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ left, top });
    if (autoFocus) el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y, autoFocus]);

  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? []);

  const openSubmenu = (index: number, btn: HTMLElement, focus: boolean) => {
    const r = btn.getBoundingClientRect();
    const right = r.right + 2;
    // Si no cabe a la derecha, se abre a la izquierda del menú.
    const sx = right + 200 > window.innerWidth ? Math.max(4, r.left - 202) : right;
    setOpenSub({ index, x: sx, y: r.top - 4, focus });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (list.length === 0) return;
      const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next].focus();
    } else if (e.key === "ArrowLeft" && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    } else if (e.key === "ArrowRight") {
      const btn = document.activeElement as HTMLButtonElement | null;
      const idx = btn?.dataset.index ? Number(btn.dataset.index) : -1;
      const it = items[idx];
      if (btn && it && it !== "separator" && it.submenu) {
        e.preventDefault();
        e.stopPropagation();
        openSubmenu(idx, btn, true);
      }
    }
  };

  return (
    <>
      <div
        ref={ref}
        className="context-menu sb-menu"
        style={{ left: pos.left, top: pos.top }}
        role="menu"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) =>
          it === "separator" ? (
            <hr key={`sep-${i}`} />
          ) : (
            <button
              key={`${it.label}-${i}`}
              role="menuitem"
              data-index={i}
              className={it.danger ? "danger" : undefined}
              disabled={it.disabled}
              aria-haspopup={it.submenu ? "menu" : undefined}
              onMouseEnter={(e) => {
                if (it.submenu) openSubmenu(i, e.currentTarget, false);
                else if (openSub) setOpenSub(null);
              }}
              onClick={(e) => {
                if (it.submenu) {
                  openSubmenu(i, e.currentTarget, true);
                  return;
                }
                onClose();
                it.onClick?.();
              }}
            >
              <span className="sb-menu-icon">{it.icon}</span>
              <span className="sb-menu-label">{it.label}</span>
              {it.submenu && <ChevronRight size={14} className="sb-menu-chevron" />}
            </button>
          ),
        )}
      </div>
      {openSub && (() => {
        const it = items[openSub.index];
        if (it === "separator" || !it?.submenu) return null;
        return (
          <MenuPanel
            key={openSub.index}
            x={openSub.x}
            y={openSub.y}
            items={it.submenu}
            onClose={onClose}
            autoFocus={openSub.focus}
            onBack={() => {
              const idx = openSub.index;
              setOpenSub(null);
              ref.current?.querySelector<HTMLButtonElement>(`button[data-index="${idx}"]`)?.focus();
            }}
          />
        );
      })()}
    </>
  );
}
