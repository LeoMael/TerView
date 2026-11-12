// Campo de contraseña con botón de ojo. Si el campo está vacío y hay una guardada, el ojo la trae del
// motor: con PIN hay que escribirlo antes (cuenta como intento); sin PIN se lee del llavero.
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { errorMessage, isApiError } from "../api/core";
import { profiles, type SecretKind } from "../api/profiles";
import { vault } from "../api/vault";
import { applyVaultStatus, useLock } from "./lock/lockStore";
import { PinField } from "./lock/PinCode";

export function SecretInput({
  profileId,
  kind,
  stored,
  value,
  onChange,
  placeholder,
  label,
}: {
  /** "" = servidor nuevo (no hay nada guardado). */
  profileId: string;
  kind: SecretKind;
  /** Hay una guardada. */
  stored: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
}) {
  const status = useLock((s) => s.status);
  const [shown, setShown] = useState(false);
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async (p?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const v = await profiles.revealSecret(profileId, kind, p);
      if (v === null) {
        setError("No hay ninguna guardada.");
      } else {
        onChange(v);
        setShown(true);
        setAsking(false);
      }
    } catch (err) {
      setError(isApiError(err, "AuthFailed") ? "PIN incorrecto." : errorMessage(err));
      vault.status().then(applyVaultStatus).catch(() => {});
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  const onEye = () => {
    if (shown) return setShown(false);
    if (value || !stored || !profileId) return setShown(true);
    if (status?.enabled) {
      setAsking(true);
      setError(null);
      return;
    }
    void reveal();
  };

  return (
    <>
      <div className="cd-inline-row">
        <input
          className="input cd-grow"
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={onEye}
          disabled={busy}
          title={shown ? "Ocultar" : stored && !value ? "Ver la guardada" : "Ver"}
          aria-label={shown ? "Ocultar contraseña" : "Ver contraseña"}
          aria-pressed={shown}
        >
          {shown ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      {asking && status && (
        <div className="cd-reveal">
          <span>Tu PIN para verla</span>
          <PinField
            kind={status.pinKind}
            value={pin}
            onChange={(v) => {
              setPin(v);
              setError(null);
            }}
            onSubmit={(v) => void reveal(v)}
            label="PIN"
            autoFocus
            disabled={busy}
            invalid={!!error}
          />
          <button type="button" className="ssha-linkbtn" onClick={() => setAsking(false)}>
            Cancelar
          </button>
        </div>
      )}
      {error && <div className="cd-err">{error}</div>}
    </>
  );
}
