// Pantalla de bloqueo (con «Olvidé mi PIN») y pantalla de primera vez para crear el PIN.
// LockGate envuelve la interfaz de cada ventana: al abrir con TerView bloqueado no la monta hasta
// desbloquear; si se bloquea después, la deja montada (las conexiones siguen) pero la tapa entera y
// la vuelve inerte.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, Lock, ShieldCheck } from "lucide-react";
import { errorMessage, isApiError } from "../../api/core";
import { vault, type VaultStatus } from "../../api/vault";
import { Logo } from "../../components/ui/Logo";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { applyVaultStatus, dismissVaultPrompt, LOCK_SCREEN_CLASS, useLock } from "./lockStore";
import { SetupPinForm, WhatItProtects } from "./PinForms";
import { PinField } from "./PinCode";
import "./Lock.css";

export function LockGate({ main, children }: { main: boolean; children: ReactNode }) {
  const status = useLock((s) => s.status);
  const everOpen = useLock((s) => s.everOpen);
  const setup = useShowSetup(main, status);
  if (!status) {
    return (
      <div className="app-boot">
        <div className="spinner" />
      </div>
    );
  }
  const locked = status.locked;
  return (
    <>
      {everOpen && (
        <div className="lock-content" inert={locked || setup} aria-hidden={locked || setup || undefined}>
          {children}
        </div>
      )}
      {locked && <LockScreen status={status} main={main} />}
      {!locked && setup && <SetupPrompt />}
    </>
  );
}

/** Cuenta atrás de la espera tras fallos (la decide el motor; aquí solo se muestra). */
function useRetryCountdown(status: VaultStatus): number {
  const [left, setLeft] = useState(status.retryAfterSecs);
  useEffect(() => {
    const until = Date.now() + status.retryAfterSecs * 1000;
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    if (status.retryAfterSecs <= 0) return;
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [status]);
  return left;
}

function formatWait(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

function LockScreen({ status, main }: { status: VaultStatus; main: boolean }) {
  const [mode, setMode] = useState<"pin" | "forgot">("pin");
  return (
    <div
      className={LOCK_SCREEN_CLASS}
      role="dialog"
      aria-modal="true"
      aria-label="TerView está bloqueado"
      // Que las teclas no lleguen a la interfaz de debajo (Escape cerraría diálogos, etc.).
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="lock-card">
        <Logo size={36} withName />
        {mode === "pin" ? (
          <UnlockForm status={status} main={main} onForgot={() => setMode("forgot")} />
        ) : (
          <ForgotPin onBack={() => setMode("pin")} />
        )}
      </div>
    </div>
  );
}

function UnlockForm({ status, main, onForgot }: { status: VaultStatus; main: boolean; onForgot: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wait = useRetryCountdown(status);
  const pin6 = status.pinKind === "pin6";

  const unlock = async (value: string) => {
    if (!value || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      applyVaultStatus(await vault.unlock(value));
    } catch (err) {
      setError(isApiError(err, "AuthFailed") ? "PIN incorrecto." : errorMessage(err));
      setPin("");
      // La espera tras fallos la lleva el motor: se pide para mostrar la cuenta atrás.
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
        void unlock(pin);
      }}
    >
      <h2 className="lock-title lock-title-center">
        <Lock size={18} /> Escribe tu PIN
      </h2>
      <PinField
        kind={status.pinKind}
        value={pin}
        onChange={(v) => {
          setPin(v);
          setError(null);
        }}
        onSubmit={(v) => void unlock(v)}
        label="PIN"
        autoFocus
        disabled={busy || wait > 0}
        invalid={!!error}
      />
      {busy && pin6 && (
        <div className="lock-hint lock-center">
          <span className="spinner" /> Comprobando…
        </div>
      )}
      {error && <div className="lock-error lock-center">{error}</div>}
      {wait > 0 && <div className="lock-error lock-center">Demasiados intentos. Espera {formatWait(wait)}.</div>}
      {!pin6 && (
        <button type="submit" className="btn btn-primary lock-submit" disabled={busy || !pin || wait > 0}>
          {busy ? <span className="spinner" /> : <KeyRound size={15} />} {busy ? "Comprobando…" : "Desbloquear"}
        </button>
      )}
      {main ? (
        <button type="button" className="lock-link" onClick={onForgot}>
          Olvidé mi PIN
        </button>
      ) : (
        <p className="lock-hint lock-center">¿Olvidaste el PIN? Ve a la ventana principal.</p>
      )}
    </form>
  );
}

const CONFIRM_WORD = "BORRAR";

function ForgotPin({ onBack }: { onBack: () => void }) {
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = word.trim().toUpperCase() === CONFIRM_WORD;

  const reset = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await vault.reset();
      useLock.setState({ offerSetup: true });
      applyVaultStatus(await vault.status());
      toast.info("Bóveda borrada", "TerView te pedirá las contraseñas otra vez.");
    } catch (err) {
      toast.error("No se pudo borrar la bóveda", err);
      setBusy(false);
    }
  };

  return (
    <div className="lock-form">
      <h2 className="lock-title">Olvidé mi PIN</h2>
      <p className="lock-text">Se borran las contraseñas guardadas y el token de GitHub. Lo demás se conserva.</p>
      <details className="lock-details">
        <summary>¿Qué se conserva?</summary>
        <ul>
          <li>Servidores, proyectos, comandos, túneles y ajustes.</li>
          <li>Tus llaves de ~/.ssh y tu copia en Gist.</li>
          <li>Las conexiones abiertas (al reconectar te pedirán la contraseña).</li>
        </ul>
      </details>
      <label className="field">
        <span>
          Escribe <strong>{CONFIRM_WORD}</strong> para confirmar
        </span>
        <input
          className="input"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={word}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void reset()}
        />
      </label>
      <div className="lock-actions">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          Volver
        </button>
        <button type="button" className="btn btn-danger" onClick={() => void reset()} disabled={!ok || busy}>
          {busy ? <span className="spinner" /> : null} Borrar y empezar de nuevo
        </button>
      </div>
    </div>
  );
}

/** Ofrecer crear el PIN: solo en la principal, sin bóveda, y si no se dijo «Ahora no» (o tras
 * «Olvidé mi PIN»). Los ajustes deben estar cargados para saberlo. */
function useShowSetup(main: boolean, status: VaultStatus | null): boolean {
  const loaded = useSettings((s) => s.loaded);
  const dismissed = useSettings((s) => s.settings.vaultPromptDismissed);
  const offer = useLock((s) => s.offerSetup);
  return main && !!status && !status.enabled && loaded && (!dismissed || offer);
}

/** Primera vez (o tras «Olvidé mi PIN»): crear el PIN. «Ahora no» no vuelve a preguntar. */
function SetupPrompt() {
  const offer = useLock((s) => s.offerSetup);
  return (
    <div
      className={`${LOCK_SCREEN_CLASS} lock-setup`}
      role="dialog"
      aria-modal="true"
      aria-label="Proteger con un PIN"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="lock-card lock-card-wide">
        <h2 className="lock-title">
          <ShieldCheck size={20} /> {offer ? "Crea un PIN nuevo" : "Protege tus contraseñas con un PIN"}
        </h2>
        <p className="lock-text">TerView se bloqueará al abrirlo y tras un rato sin uso.</p>
        <WhatItProtects />
        <SetupPinForm
          autoFocus
          cancelLabel="Ahora no"
          onDone={() => useLock.setState({ offerSetup: false })}
          onCancel={() => void dismissVaultPrompt()}
        />
      </div>
    </div>
  );
}
