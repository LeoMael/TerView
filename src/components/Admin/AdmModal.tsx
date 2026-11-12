// Ventana modal de Administración: como ui/Modal, pero el contenido pone su propio cuerpo y pie
// (para poder cambiar entre formulario y revisión del comando dentro del mismo diálogo).
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** Pila de modales abiertos: Escape cierra solo el de arriba. */
const stack: object[] = [];

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

export function AdmModal({ title, onClose, children, width = 520 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const token = {};
    stack.push(token);
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Foco inicial: el primer control con autofocus o el primero enfocable.
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>("[autofocus], input, select, textarea, button:not(.adm-modal-x)");
      first?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stack[stack.length - 1] === token) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(token), 1);
      prev?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal adm-modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn adm-modal-x" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
