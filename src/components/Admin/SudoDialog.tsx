// Pide y valida la contraseña de sudo. Queda en memoria mientras dure la conexión y, si se marca
// «Guardar para este servidor», también en la bóveda (o el llavero) como contraseña de sudo guardada.
// Antes de preguntar busca la que ya hay (`obtainSudoPassword`: en memoria, guardada u otra pestaña del
// mismo servidor): si sirve, se cierra solo. Lo usan Administración, Contenedores y el escáner.
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import {
  confirmSudo,
  defaultSaveChecked,
  obtainSudoPassword,
  storedFailed,
  sudoModeOf,
  setStoredSudo,
  useStoredSudoState,
} from "../../features/privileges";
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
  const failed = storedFailed(stored);
  const mode = sudoModeOf(profileId);
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(() => defaultSaveChecked({ change, failed, mode }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Primero se busca la que ya hay; el formulario solo aparece si no sirve ninguna.
  const [looking, setLooking] = useState(!change);

  useEffect(() => {
    if (change) return;
    let alive = true;
    void obtainSudoPassword(sessionId, profileId).then((r) => {
      if (!alive) return;
      if (r.ok) {
        if (r.source !== "memory") {
          toast.success(
            "sudo confirmado",
            r.source === "stored"
              ? "Se usó la contraseña guardada de este servidor."
              : "Se usó la de otra pestaña de este servidor.",
          );
        }
        onClose();
        return;
      }
      setSave(defaultSaveChecked({ change, failed: r.storedFailed, mode: sudoModeOf(profileId) }));
      setLooking(false);
    });
    return () => {
      alive = false;
    };
    // Solo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El aviso «la guardada no funcionó» ya se ve: que los paneles no vuelvan a abrir el diálogo solos.
  useEffect(() => {
    if (stored === "failed" && !looking) setStoredSudo(sessionId, "rejected");
  }, [stored, looking, sessionId]);

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
    if (kept) setStoredSudo(sessionId, "ok");
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
          {looking ? (
            <div className="faint" role="status">
              <span className="spinner adm-spinner-btn" /> Buscando la contraseña de sudo guardada…
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || looking || !password}>
            {busy ? <span className="spinner adm-spinner-btn" /> : <KeyRound size={13} />}
            Confirmar
          </button>
        </div>
      </form>
    </AdmModal>
  );
}
