import { CheckCircle2, Info, XCircle, X } from "lucide-react";
import { useToasts } from "../../stores/toasts";

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === "success" ? <CheckCircle2 size={18} /> : t.kind === "error" ? <XCircle size={18} /> : <Info size={18} />}
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.message && <span>{t.message}</span>}
          </div>
          <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Cerrar">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
