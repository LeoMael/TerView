// Diálogos del flujo de conexión (contraseña, frase, código 2FA, huella) + editores de servidor/proyecto.
// DUEÑO: agente Almacenamiento/Sidebar. App monta <ConnectDialogHost /> una vez.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { KeyRound, Lock, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import type { HostKeyInfo, ServerProfile } from "../api/types";
import { useProfiles } from "../stores/profiles";
import { ServerEditorHost } from "./ServerEditor";
import { ProjectEditorHost } from "./ProjectEditor";
import "./ConnectDialogs.css";

export interface SecretAnswer {
  value: string;
  remember: boolean;
}

type Pending =
  | {
      kind: "secret";
      type: "password" | "passphrase";
      seq: number;
      profile: ServerProfile;
      error: string | null;
      resolve: (v: SecretAnswer | null) => void;
    }
  | {
      kind: "otp";
      seq: number;
      profile: ServerProfile;
      prompt: string | null;
      error: string | null;
      resolve: (code: string | null) => void;
    }
  | { kind: "hostkey"; changed: boolean; seq: number; hostKey: HostKeyInfo; resolve: (trust: boolean) => void };

/** Cola de diálogos: si varias conexiones preguntan a la vez, se muestran de uno en uno. */
const useConnectDialogs = create<{ queue: Pending[] }>(() => ({ queue: [] }));

/** Recuerda la última elección de «Recordar en el llavero» durante la sesión. */
let lastRemember = true;

let seq = 0;
type NoSeq<T> = T extends unknown ? Omit<T, "seq"> : never;

function ask(np: NoSeq<Pending>) {
  const p = { ...np, seq: ++seq } as Pending;
  useConnectDialogs.setState((s) => ({ queue: [...s.queue, p] }));
}

function finish(p: Pending) {
  useConnectDialogs.setState((s) => ({ queue: s.queue.filter((x) => x.seq !== p.seq) }));
}

/** Pide la contraseña. null = cancelado. */
export function askPassword(profile: ServerProfile, error: string | null = null): Promise<SecretAnswer | null> {
  return new Promise((resolve) => ask({ kind: "secret", type: "password", profile, error, resolve }));
}

/** Pide la frase de la llave privada. null = cancelado. */
export function askPassphrase(profile: ServerProfile, error: string | null = null): Promise<SecretAnswer | null> {
  return new Promise((resolve) => ask({ kind: "secret", type: "passphrase", profile, error, resolve }));
}

/** Pide el código de verificación (2FA). `prompt` = pregunta del servidor. null = cancelado. */
export function askOtp(
  profile: ServerProfile,
  prompt: string | null,
  error: string | null = null,
): Promise<string | null> {
  return new Promise((resolve) => ask({ kind: "otp", profile, prompt, error, resolve }));
}

/** Pregunta si confiar en la huella del servidor (nueva o cambiada). */
export function confirmHostKey(hostKey: HostKeyInfo, changed: boolean): Promise<boolean> {
  return new Promise((resolve) => ask({ kind: "hostkey", changed, hostKey, resolve }));
}

export function ConnectDialogHost() {
  const pending = useConnectDialogs((s) => s.queue[0] ?? null);
  const loaded = useProfiles((s) => s.loaded);
  const load = useProfiles((s) => s.load);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  let dialog = null;
  if (pending?.kind === "secret") {
    const p = pending;
    dialog = (
      <SecretDialog
        key={p.seq}
        kind={p.type}
        profile={p.profile}
        error={p.error}
        onDone={(v) => {
          finish(p);
          p.resolve(v);
        }}
      />
    );
  } else if (pending?.kind === "otp") {
    const p = pending;
    dialog = (
      <OtpDialog
        key={p.seq}
        profile={p.profile}
        prompt={p.prompt}
        error={p.error}
        onDone={(v) => {
          finish(p);
          p.resolve(v);
        }}
      />
    );
  } else if (pending) {
    const p = pending;
    dialog = (
      <HostKeyDialog
        key={p.seq}
        hostKey={p.hostKey}
        changed={p.changed}
        onDone={(v) => {
          finish(p);
          p.resolve(v);
        }}
      />
    );
  }

  return (
    <>
      {dialog}
      <ServerEditorHost />
      <ProjectEditorHost />
    </>
  );
}

function SecretDialog({
  kind,
  profile,
  error,
  onDone,
}: {
  kind: "password" | "passphrase";
  profile: ServerProfile;
  error: string | null;
  onDone: (v: SecretAnswer | null) => void;
}) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(lastRemember);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const isPw = kind === "password";
  const submit = () => {
    if (isPw && value === "") return;
    lastRemember = remember;
    onDone({ value, remember });
  };

  return (
    <Modal
      open
      title={isPw ? "Contraseña" : "Frase de la llave"}
      onClose={() => onDone(null)}
      width={420}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={isPw && value === ""}>
            Conectar
          </button>
        </>
      }
    >
      <div className="cd-target">
        {isPw ? <Lock size={16} /> : <KeyRound size={16} />}
        <div className="cd-target-text">
          <strong>{profile.name}</strong>
          <span className="mono">
            {profile.username}@{profile.host}
            {profile.port !== 22 ? `:${profile.port}` : ""}
          </span>
        </div>
      </div>
      {!isPw && profile.keyPath && (
        <div className="dialog-message">
          La llave <span className="mono cd-inline">{profile.keyPath}</span> está protegida con una frase.
        </div>
      )}
      <label className="field">
        <span>{isPw ? "Contraseña" : "Frase"}</span>
        <input
          ref={ref}
          className="input"
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      {error && <div className="field-error">{error}</div>}
      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Recordar en el llavero del sistema
      </label>
    </Modal>
  );
}

/** Pregunta del servidor, o null si viene vacía. */
function cleanPrompt(prompt: string | null): string | null {
  const t = (prompt ?? "").trim();
  return t === "" ? null : t;
}

function OtpDialog({
  profile,
  prompt,
  error,
  onDone,
}: {
  profile: ServerProfile;
  prompt: string | null;
  error: string | null;
  onDone: (code: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const question = cleanPrompt(prompt);
  const code = value.trim();
  const submit = () => {
    if (code !== "") onDone(code);
  };

  return (
    <Modal
      open
      title="Código de verificación"
      onClose={() => onDone(null)}
      width={420}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={code === ""}>
            Verificar
          </button>
        </>
      }
    >
      <div className="cd-target">
        <ShieldCheck size={16} />
        <div className="cd-target-text">
          <strong>{profile.name}</strong>
          <span className="mono">
            {profile.username}@{profile.host}
            {profile.port !== 22 ? `:${profile.port}` : ""}
          </span>
        </div>
      </div>
      <div className="dialog-message">
        El servidor pide un segundo factor. Escribe el código de tu aplicación de autenticación.
      </div>
      <label className="field">
        <span>{question ?? "Código"}</span>
        <input
          ref={ref}
          className="input mono cd-otp"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={64}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}

function HostKeyDialog({
  hostKey,
  changed,
  onDone,
}: {
  hostKey: HostKeyInfo;
  changed: boolean;
  onDone: (trust: boolean) => void;
}) {
  const where = hostKey.port === 22 ? hostKey.host : `${hostKey.host}:${hostKey.port}`;
  const details = (
    <dl className="cd-hostkey">
      <dt>Servidor</dt>
      <dd className="mono">{where}</dd>
      <dt>Algoritmo</dt>
      <dd className="mono">{hostKey.algorithm}</dd>
      <dt>Huella</dt>
      <dd className="mono cd-fingerprint">{hostKey.fingerprint}</dd>
    </dl>
  );

  if (!changed) {
    return (
      <Modal
        open
        title="Servidor desconocido"
        onClose={() => onDone(false)}
        width={500}
        footer={
          <>
            <button className="btn" onClick={() => onDone(false)}>
              Cancelar
            </button>
            <button autoFocus className="btn btn-primary" onClick={() => onDone(true)}>
              Confiar y conectar
            </button>
          </>
        }
      >
        <div className="cd-banner cd-banner-info">
          <ShieldQuestion size={20} />
          <div>
            Es la primera vez que te conectas a <strong>{where}</strong>. Comprueba que la huella coincide con la del
            servidor antes de continuar.
          </div>
        </div>
        {details}
        <div className="cd-question">¿Confías en este servidor?</div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title="¡La huella del servidor cambió!"
      onClose={() => onDone(false)}
      width={520}
      footer={
        <>
          <button className="btn btn-danger cd-secondary-danger" onClick={() => onDone(true)}>
            Confiar en la nueva huella
          </button>
          <button autoFocus className="btn btn-primary" onClick={() => onDone(false)}>
            Cancelar
          </button>
        </>
      }
    >
      <div className="cd-banner cd-banner-danger">
        <ShieldAlert size={22} />
        <div>
          <strong>Posible ataque.</strong> La identidad de <strong>{where}</strong> no coincide con la que tenías
          guardada. Alguien podría estar suplantando al servidor para robar tus credenciales. También puede pasar si el
          servidor se reinstaló o cambió sus llaves.
        </div>
      </div>
      {details}
      <div className="dialog-message">
        Confírmalo con el administrador del servidor antes de aceptar. Si confías, la huella antigua se reemplazará.
      </div>
    </Modal>
  );
}
