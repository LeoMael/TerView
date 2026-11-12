// Pide y valida la contraseña de sudo (se guarda solo en memoria para esta conexión).
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { confirmSudo } from "../../features/privileges";
import { toast } from "../../stores/toasts";
import { AdmModal } from "./AdmModal";

export function SudoDialog({ sessionId, user, onClose }: { sessionId: string; user: string | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await confirmSudo(sessionId, password);
    setBusy(false);
    if (r.ok) {
      setPassword("");
      toast.success("sudo confirmado", "La contraseña queda solo en memoria mientras dure esta conexión");
      onClose();
    } else {
      setError(r.message);
      setPassword("");
    }
  };

  return (
    <AdmModal title="Contraseña de sudo" onClose={onClose} width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="modal-body">
          <p className="dialog-message">
            Escribe la contraseña de <strong>{user ?? "tu usuario"}</strong> en el servidor. Se comprueba con{" "}
            <code>sudo -v</code>, se envía siempre por la entrada estándar (nunca en la línea de comandos) y se guarda
            solo en memoria hasta que cierres la conexión o pulses «Olvidar contraseña de sudo».
          </p>
          <label className="field">
            <span>Contraseña</span>
            <input
              className="input"
              type="password"
              value={password}
              autoFocus
              autoComplete="off"
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              aria-invalid={!!error}
            />
          </label>
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>
            {busy ? <span className="spinner adm-spinner-btn" /> : <KeyRound size={13} />}
            Confirmar
          </button>
        </div>
      </form>
    </AdmModal>
  );
}
