// Pide y valida la contraseña de sudo. Queda en memoria mientras dure la conexión y, si se marca
// «Guardar para este servidor», también en la bóveda (o el llavero) como contraseña de sudo guardada.
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { confirmSudo, sudoModeOf, useStoredSudoState, useSudo } from "../../features/privileges";
import { profiles as profilesApi } from "../../api/profiles";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { AdmModal } from "./AdmModal";

/** Guarda la contraseña como «Contraseña de sudo: Guardar» del servidor. Devuelve si se pudo. */
async function saveForServer(profileId: string, password: string): Promise<boolean> {
  const srv = useProfiles.getState().getServer(profileId);
  if (!srv) return false;
  try {
    await profilesApi.setSecret(profileId, password, "sudo");
  } catch (e) {
    toast.error("No se pudo guardar la contraseña de sudo", e);
    return false;
  }
  if (srv.sudoMode !== "saved") {
    const saved = await useProfiles.getState().saveServer({ ...srv, sudoMode: "saved" });
    if (!saved) return false;
  }
  return true;
}

export function SudoDialog({
  sessionId,
  profileId,
  user,
  change = false,
  onClose,
}: {
  sessionId: string;
  profileId: string;
  user: string | null;
  /** «Cambiar contraseña de sudo…»: guardar marcado por defecto. */
  change?: boolean;
  onClose: () => void;
}) {
  const stored = useStoredSudoState(sessionId);
  const failed = stored === "failed";
  const mode = sudoModeOf(profileId);
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(change || failed || mode === "saved");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await confirmSudo(sessionId, password);
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      setPassword("");
      return;
    }
    const kept = save && (await saveForServer(profileId, password));
    if (kept) useSudo.setState((s) => ({ stored: { ...s.stored, [sessionId]: "ok" } }));
    setBusy(false);
    setPassword("");
    toast.success("sudo confirmado", kept ? "Contraseña guardada para este servidor." : undefined);
    onClose();
  };

  const note = failed
    ? mode === "login"
      ? "La contraseña de la conexión no sirve para sudo."
      : "La contraseña guardada no funcionó."
    : null;

  return (
    <AdmModal title={change ? "Cambiar contraseña de sudo" : "Contraseña de sudo"} onClose={onClose} width={400}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="modal-body">
          {note && (
            <div className="field-error" role="status">
              {note}
            </div>
          )}
          <label
            className="field"
            title="Se comprueba con sudo -v y se envía por la entrada estándar, nunca en la línea de comandos."
          >
            <span>
              Contraseña de <strong>{user ?? "tu usuario"}</strong> en el servidor
            </span>
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
          <label className="checkbox" title="Se guarda cifrada con tu PIN (o en el llavero si no tienes PIN).">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            Guardar para este servidor
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
