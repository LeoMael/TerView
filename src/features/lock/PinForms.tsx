// Formularios del PIN: crear (primera vez y Ajustes), cambiar y desactivar.
import { useState, type FormEvent, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { errorMessage } from "../../api/core";
import { MIN_PIN, vault, type MoveReport } from "../../api/vault";
import { toast } from "../../stores/toasts";
import { applyVaultStatus } from "./lockStore";

/** Texto corto sobre qué se pierde si se olvida el PIN. */
export function ForgetWarning() {
  return (
    <div className="lock-warn">
      <TriangleAlert size={16} />
      <span>
        <strong>Si olvidas el PIN, se pierden las contraseñas guardadas</strong> (también el token de GitHub). Nadie puede
        recuperarlas. Tus servidores, proyectos y ajustes no se pierden: solo tendrías que volver a escribir las contraseñas.
      </span>
    </div>
  );
}

export function pinProblem(pin: string): string | null {
  if ([...pin].length < MIN_PIN) return `Usa al menos ${MIN_PIN} caracteres.`;
  if (!pin.trim()) return "No puede ser solo espacios.";
  return null;
}

// ───────── Fortaleza ─────────

export interface Strength {
  /** 0 vacío · 1 débil · 2 aceptable · 3 fuerte */
  level: 0 | 1 | 2 | 3;
  label: string;
  tip: string;
}

/** Estimación sencilla (no exacta): bits según el tipo de caracteres, con castigo a repeticiones. */
export function pinStrength(pin: string): Strength {
  const chars = [...pin];
  if (!chars.length) return { level: 0, label: "", tip: "" };
  const digitsOnly = /^\d+$/.test(pin);
  let pool = 0;
  if (/[a-z]/.test(pin)) pool += 26;
  if (/[A-Z]/.test(pin)) pool += 26;
  if (/\d/.test(pin)) pool += 10;
  if (/[^a-zA-Z\d]/.test(pin)) pool += 33;
  let bits = chars.length * Math.log2(Math.max(pool, 2));
  const unique = new Set(chars).size;
  if (unique <= 2) bits = Math.min(bits, 10);
  else if (unique < chars.length / 3) bits /= 2;
  const words = pin.trim().split(/[\s\-_.,]+/).filter((w) => [...w].length >= 3).length;

  if (digitsOnly && chars.length < 10) {
    return {
      level: 1,
      label: "Débil",
      tip: "Un PIN de números basta frente a alguien en tu PC. Para más seguridad, usa una frase de 4 o 5 palabras.",
    };
  }
  if (words >= 4 && bits >= 60) return { level: 3, label: "Fuerte", tip: "Buena frase: fácil de recordar y difícil de adivinar." };
  if (bits >= 70) return { level: 3, label: "Fuerte", tip: "Difícil de adivinar." };
  if (bits >= 45) {
    return { level: 2, label: "Aceptable", tip: "Mejor aún: una frase de 4 o 5 palabras que puedas recordar." };
  }
  return { level: 1, label: "Débil", tip: "Fácil de adivinar. Prueba con una frase de 4 o 5 palabras." };
}

function StrengthMeter({ pin }: { pin: string }) {
  const s = pinStrength(pin);
  return (
    <div className="lock-strength" aria-live="polite">
      <div className={`lock-strength-bar level-${s.level}`}>
        <span />
        <span />
        <span />
      </div>
      {s.level > 0 && (
        <small>
          <strong>{s.label}.</strong> {s.tip}
        </small>
      )}
      <small className="lock-hint">
        Un PIN corto te protege de alguien sentado en tu PC; una frase de 4 o 5 palabras te protege también si alguien
        ataca el archivo de la bóveda.
      </small>
    </div>
  );
}

function PinInput({
  label,
  value,
  onChange,
  autoFocus,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <small className="lock-hint">{hint}</small>}
    </label>
  );
}

function movedText(r: MoveReport): string {
  const n = r.moved === 1 ? "1 contraseña protegida" : `${r.moved} contraseñas protegidas`;
  return r.leftInKeyring > 0
    ? `${n}. ${r.leftInKeyring} copia(s) no se pudieron borrar del llavero del sistema.`
    : `${n}. Ya no están en el llavero del sistema.`;
}

/** Crear el PIN (y mover las contraseñas del llavero a la bóveda). */
export function SetupPinForm({
  onDone,
  onCancel,
  cancelLabel = "Cancelar",
  autoFocus,
}: {
  onDone?: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
  autoFocus?: boolean;
}) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = pinProblem(pin);
    if (p) return setError(p);
    if (pin !== again) return setError("Los dos PIN no coinciden.");
    setBusy(true);
    setError(null);
    try {
      const r = await vault.enable(pin);
      applyVaultStatus(await vault.status());
      toast.success("PIN creado", movedText(r));
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="lock-form" onSubmit={(e) => void submit(e)}>
      <PinInput
        label="PIN o contraseña maestra"
        value={pin}
        onChange={setPin}
        autoFocus={autoFocus}
        hint={`Al menos ${MIN_PIN} caracteres: números o, mejor, una frase de varias palabras.`}
      />
      <StrengthMeter pin={pin} />
      <PinInput label="Repite el PIN" value={again} onChange={setAgain} />
      <ForgetWarning />
      {error && <div className="lock-error">{error}</div>}
      <div className="lock-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !pin || !again}>
          {busy ? <span className="spinner" /> : null} {busy ? "Protegiendo…" : "Crear PIN"}
        </button>
      </div>
    </form>
  );
}

/** Cambiar el PIN (vuelve a cifrar la bóveda). */
export function ChangePinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [old, setOld] = useState("");
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = pinProblem(pin);
    if (p) return setError(p);
    if (pin !== again) return setError("Los dos PIN nuevos no coinciden.");
    setBusy(true);
    setError(null);
    try {
      await vault.changePin(old, pin);
      toast.success("PIN cambiado", "Usa el nuevo la próxima vez que desbloquees TerView.");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      vault.status().then(applyVaultStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="lock-form" onSubmit={(e) => void submit(e)}>
      <PinInput label="PIN actual" value={old} onChange={setOld} autoFocus />
      <PinInput label="PIN nuevo" value={pin} onChange={setPin} hint={`Al menos ${MIN_PIN} caracteres.`} />
      <StrengthMeter pin={pin} />
      <PinInput label="Repite el PIN nuevo" value={again} onChange={setAgain} />
      {error && <div className="lock-error">{error}</div>}
      <div className="lock-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !old || !pin || !again}>
          {busy ? <span className="spinner" /> : null} Cambiar PIN
        </button>
      </div>
    </form>
  );
}

/** Quitar el PIN: las contraseñas vuelven al llavero del sistema. */
export function DisablePinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await vault.disable(pin);
      applyVaultStatus(await vault.status());
      toast.success(
        "PIN desactivado",
        r.moved === 1 ? "1 contraseña volvió al llavero del sistema." : `${r.moved} contraseñas volvieron al llavero del sistema.`,
      );
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      vault.status().then(applyVaultStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="lock-form" onSubmit={(e) => void submit(e)}>
      <p className="lock-text">
        Las contraseñas guardadas vuelven al llavero del sistema y TerView deja de bloquearse. Escribe tu PIN para confirmar.
      </p>
      <PinInput label="PIN actual" value={pin} onChange={setPin} autoFocus />
      {error && <div className="lock-error">{error}</div>}
      <div className="lock-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-danger" disabled={busy || !pin}>
          {busy ? <span className="spinner" /> : null} Quitar PIN
        </button>
      </div>
    </form>
  );
}
