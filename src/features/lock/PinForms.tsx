// Formularios del PIN (6 números): crear (primera vez y Ajustes), cambiar y quitar.
import { useRef, useState, type FormEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { errorMessage, isApiError } from "../../api/core";
import { isValidPin, PIN_LENGTH, vault, type MoveReport } from "../../api/vault";
import { toast } from "../../stores/toasts";
import { applyVaultStatus, useLock } from "./lockStore";
import { PinCode, PinField, type PinCodeHandle } from "./PinCode";

/** Una línea sobre qué se pierde si se olvida el PIN. */
export function ForgetWarning() {
  return (
    <div className="lock-warn" title="Servidores, proyectos y ajustes no se pierden.">
      <TriangleAlert size={16} />
      <span>Si lo olvidas, se pierden las contraseñas guardadas.</span>
    </div>
  );
}

/** «¿Qué protege?» plegable: todo lo que antes era texto fijo. */
export function WhatItProtects() {
  return (
    <details className="lock-details">
      <summary>¿Qué protege?</summary>
      <ul>
        <li>Cifra las contraseñas guardadas (de conexión y de sudo) y el token de GitHub con tu PIN y una llave de este equipo.</li>
        <li>Quien copie el archivo a otro PC no puede abrirlo.</li>
        <li>Tras 5 fallos hay que esperar, cada vez más (hasta 15 min). Nunca se borra nada por fallar.</li>
        <li>Al bloquear se tapan las ventanas; las conexiones siguen abiertas.</li>
        <li>No cifra servidores, ajustes ni tus llaves de ~/.ssh.</li>
      </ul>
    </details>
  );
}

function pinError(err: unknown): string {
  return isApiError(err, "AuthFailed") ? "PIN incorrecto." : errorMessage(err);
}

function movedText(r: MoveReport): string | undefined {
  if (r.moved === 0) return undefined;
  const n = r.moved === 1 ? "1 contraseña protegida" : `${r.moved} contraseñas protegidas`;
  return r.leftInKeyring > 0 ? `${n} (${r.leftInKeyring} copia(s) siguen en el llavero).` : `${n}.`;
}

/** PIN nuevo + repetición, con salto automático a la segunda casilla. */
function NewPinPair({
  pin,
  setPin,
  again,
  setAgain,
  autoFocus,
  onReady,
  disabled,
}: {
  pin: string;
  setPin: (v: string) => void;
  again: string;
  setAgain: (v: string) => void;
  autoFocus?: boolean;
  onReady: (pin: string, again: string) => void;
  disabled?: boolean;
}) {
  const second = useRef<PinCodeHandle>(null);
  return (
    <>
      <div className="field">
        <span>PIN nuevo ({PIN_LENGTH} números)</span>
        <PinCode
          value={pin}
          onChange={setPin}
          onComplete={() => second.current?.focus()}
          label="PIN nuevo"
          autoFocus={autoFocus}
          disabled={disabled}
        />
      </div>
      <div className="field">
        <span>Repítelo</span>
        <PinCode
          ref={second}
          value={again}
          onChange={setAgain}
          onComplete={(v) => onReady(pin, v)}
          onEnter={() => onReady(pin, again)}
          label="Repite el PIN"
          disabled={disabled}
        />
      </div>
    </>
  );
}

function checkPair(pin: string, again: string): string | null {
  if (!isValidPin(pin)) return `El PIN debe tener ${PIN_LENGTH} números.`;
  if (pin !== again) return "Los dos PIN no coinciden.";
  return null;
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

  const create = async (p: string, a: string) => {
    if (busy) return;
    const problem = checkPair(p, a);
    if (problem) {
      setError(problem);
      setAgain("");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await vault.enable(p);
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
    <form
      className="lock-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void create(pin, again);
      }}
    >
      <NewPinPair
        pin={pin}
        setPin={(v) => {
          setPin(v);
          setError(null);
        }}
        again={again}
        setAgain={(v) => {
          setAgain(v);
          setError(null);
        }}
        autoFocus={autoFocus}
        onReady={(p, a) => void create(p, a)}
        disabled={busy}
      />
      <ForgetWarning />
      {error && <div className="lock-error">{error}</div>}
      <div className="lock-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !pin || !again}>
          {busy ? <span className="spinner" /> : null} {busy ? "Creando…" : "Crear PIN"}
        </button>
      </div>
    </form>
  );
}

/** Cambiar el PIN (vuelve a cifrar la bóveda). El actual puede ser de texto (bóvedas antiguas). */
export function ChangePinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const kind = useLock((s) => s.status?.pinKind ?? "pin6");
  const [old, setOld] = useState("");
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (p: string, a: string) => {
    if (busy) return;
    const problem = !old ? "Escribe el PIN actual." : checkPair(p, a);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await vault.changePin(old, p);
      applyVaultStatus(await vault.status());
      toast.success("PIN cambiado");
      onDone();
    } catch (err) {
      setError(pinError(err));
      setOld("");
      vault.status().then(applyVaultStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="lock-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void change(pin, again);
      }}
    >
      <div className="field">
        <span>PIN actual</span>
        <PinField kind={kind} value={old} onChange={setOld} label="PIN actual" autoFocus disabled={busy} />
      </div>
      <NewPinPair
        pin={pin}
        setPin={setPin}
        again={again}
        setAgain={setAgain}
        onReady={(p, a) => void change(p, a)}
        disabled={busy}
      />
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
  const kind = useLock((s) => s.status?.pinKind ?? "pin6");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disable = async (p: string) => {
    if (busy || !p) return;
    setBusy(true);
    setError(null);
    try {
      await vault.disable(p);
      applyVaultStatus(await vault.status());
      toast.success("PIN quitado", "Las contraseñas volvieron al llavero del sistema.");
      onDone();
    } catch (err) {
      setError(pinError(err));
      setPin("");
      vault.status().then(applyVaultStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="lock-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void disable(pin);
      }}
    >
      <p className="lock-text">Las contraseñas vuelven al llavero del sistema.</p>
      <div className="field">
        <span>PIN actual</span>
        <PinField kind={kind} value={pin} onChange={setPin} label="PIN actual" autoFocus disabled={busy} />
      </div>
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
