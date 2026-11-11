// Diálogos de confirmación y de texto, usables desde cualquier parte con await.
//   if (await confirmDialog({ title: "¿Borrar?", danger: true })) ...
//   const name = await promptDialog({ title: "Nueva carpeta", initial: "" });
// Requiere <DialogHost /> montado una vez (lo monta App).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Modal } from "./Modal";

interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface PromptOpts {
  title: string;
  message?: ReactNode;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
  /** "password" para ocultar el texto. */
  inputType?: "text" | "password";
  /** Selecciona solo el nombre sin extensión (útil para renombrar). */
  selectBaseName?: boolean;
  /** Devuelve mensaje de error o null si es válido. */
  validate?: (v: string) => string | null;
}

type Pending =
  | { type: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { type: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void };

const useDialogs = create<{ pending: Pending | null; set: (p: Pending | null) => void }>((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
}));

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().set({ type: "confirm", opts, resolve }));
}

export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().set({ type: "prompt", opts, resolve }));
}

export function DialogHost() {
  const pending = useDialogs((s) => s.pending);
  const clear = useDialogs((s) => s.set);
  if (!pending) return null;
  if (pending.type === "confirm") {
    const { opts, resolve } = pending;
    const done = (v: boolean) => {
      clear(null);
      resolve(v);
    };
    return (
      <Modal
        open
        title={opts.title}
        onClose={() => done(false)}
        footer={
          <>
            <button className="btn" onClick={() => done(false)}>
              {opts.cancelText ?? "Cancelar"}
            </button>
            <button autoFocus className={opts.danger ? "btn btn-danger" : "btn btn-primary"} onClick={() => done(true)}>
              {opts.confirmText ?? "Aceptar"}
            </button>
          </>
        }
      >
        {opts.message && <div className="dialog-message">{opts.message}</div>}
      </Modal>
    );
  }
  return <PromptView key={Math.random()} opts={pending.opts} onDone={(v) => { clear(null); pending.resolve(v); }} />;
}

function PromptView({ opts, onDone }: { opts: PromptOpts; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const v = opts.initial ?? "";
    const dot = v.lastIndexOf(".");
    if (opts.selectBaseName && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [opts]);
  const submit = () => {
    const err = opts.validate?.(value) ?? null;
    if (err) return setError(err);
    onDone(value);
  };
  return (
    <Modal
      open
      title={opts.title}
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {opts.confirmText ?? "Aceptar"}
          </button>
        </>
      }
    >
      {opts.message && <div className="dialog-message">{opts.message}</div>}
      <label className="field">
        {opts.label && <span>{opts.label}</span>}
        <input
          ref={ref}
          className="input"
          type={opts.inputType ?? "text"}
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}
