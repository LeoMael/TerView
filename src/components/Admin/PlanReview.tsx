// Revisión de un cambio antes de ejecutarlo: comando exacto (sin contraseñas), confirmación y resultado.
import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronLeft, KeyRound, Play } from "lucide-react";
import { MASK, type Plan } from "../../features/admin";
import { wrapScript, type Elevation } from "../../features/privileges";
import { AdmModal } from "./AdmModal";
import { useAdmin } from "./context";

function elevationText(el: Elevation | null): string {
  switch (el?.kind) {
    case "root":
      return "Se ejecutará como root:";
    case "nopasswd":
      return `Se ejecutará como root mediante ${el.tool} (sin contraseña):`;
    case "password":
      return "Se ejecutará como root mediante sudo. Tu contraseña de sudo se envía por la entrada estándar, nunca en el comando:";
    default:
      return "Se ejecutará:";
  }
}

interface ReviewProps {
  plan: Plan;
  /** Si se indica, hay que escribir este texto para habilitar «Ejecutar» (confirmación fuerte). */
  confirmWord?: string;
  /** Contenido extra encima del comando (opciones del cambio). */
  children?: ReactNode;
  onBack?: () => void;
  onCancel: () => void;
  /** Tras ejecutar con éxito. */
  onDone: () => void;
  runLabel?: string;
}

/** Cuerpo + pie de la revisión, para usar dentro de un Modal (ver PlanModal). */
export function PlanReview({ plan, confirmWord, children, onBack, onCancel, onDone, runLabel }: ReviewProps) {
  const { elevation, runPlan, askSudo, disabled } = useAdmin();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needSudo, setNeedSudo] = useState(false);
  const fullScript = elevation ? wrapScript(["set -e", ...plan.steps].join("\n"), elevation) : "";

  const run = async () => {
    setBusy(true);
    setError(null);
    setNeedSudo(false);
    const out = await runPlan(plan);
    setBusy(false);
    if (out.ok) onDone();
    else {
      setError(out.error);
      setNeedSudo(out.needSudo);
    }
  };

  const blocked = !elevation || disabled || busy || (confirmWord !== undefined && typed !== confirmWord);

  return (
    <>
      <div className="modal-body adm-review">
        {children}
        <div className="adm-review-label">{elevationText(elevation)}</div>
        <pre className="adm-cmd" aria-label="Comandos que se ejecutarán">
          {plan.steps.join("\n")}
        </pre>
        {plan.secretLabel && (
          <div className="adm-stdin">
            <KeyRound size={13} /> Por la entrada estándar (no se ve en el comando ni en los registros):{" "}
            <code>{plan.secretLabel}</code>
          </div>
        )}
        {elevation && elevation.kind !== "none" && (
          <details className="adm-details">
            <summary>Script completo enviado al servidor</summary>
            <pre className="adm-cmd adm-cmd-sm">{fullScript}</pre>
            <div className="faint">
              {elevation.kind === "password" ? `Entrada estándar: contraseña de sudo (${MASK})` : "Entrada estándar: "}
              {plan.secretLabel ? `${elevation.kind === "password" ? ", luego " : ""}${plan.secretLabel}` : ""}
            </div>
          </details>
        )}
        {confirmWord !== undefined && (
          <label className="field adm-confirm-word">
            <span>
              Para confirmar, escribe <strong className="mono">{confirmWord}</strong>
            </span>
            <input
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={`Escribe ${confirmWord} para confirmar`}
            />
          </label>
        )}
        {error && (
          <div className="adm-error" role="alert">
            <AlertTriangle size={14} />
            <pre>{error}</pre>
          </div>
        )}
        {needSudo && (
          <button className="btn btn-sm" onClick={askSudo}>
            <KeyRound size={13} /> Introducir contraseña de sudo
          </button>
        )}
      </div>
      <div className="modal-footer">
        {onBack && (
          <button className="btn adm-footer-left" onClick={onBack} disabled={busy}>
            <ChevronLeft size={14} /> Volver
          </button>
        )}
        <button className="btn" onClick={onCancel} disabled={busy}>
          {error ? "Cerrar" : "Cancelar"}
        </button>
        <button
          className={plan.danger ? "btn btn-danger" : "btn btn-primary"}
          onClick={run}
          disabled={blocked}
          autoFocus={confirmWord === undefined}
        >
          {busy ? <span className="spinner adm-spinner-btn" /> : <Play size={13} />}
          {error ? "Reintentar" : (runLabel ?? "Ejecutar")}
        </button>
      </div>
    </>
  );
}

/** Modal autónomo para un cambio simple (bloquear, eliminar grupo…). */
export function PlanModal(props: Omit<ReviewProps, "onBack"> & { title: string; width?: number }) {
  const { title, width, ...rest } = props;
  return (
    <AdmModal title={title} onClose={props.onCancel} width={width ?? 560}>
      <PlanReview {...rest} />
    </AdmModal>
  );
}
