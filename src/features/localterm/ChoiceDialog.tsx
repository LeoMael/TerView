// Diálogo con varias opciones (más de «Aceptar / Cancelar»), usable con await:
//   const r = await choiceDialog({ title, message, choices: [{ value: "a", label: "A", primary: true }, …] });
// Devuelve el `value` elegido o null si se cierra. Requiere <ChoiceDialogHost /> montado (lo monta App).
import type { ReactNode } from "react";
import { create } from "zustand";
import { Modal } from "../../components/ui/Modal";

export interface Choice<T extends string> {
  value: T;
  label: string;
  primary?: boolean;
}

interface ChoiceOpts<T extends string> {
  title: string;
  message: ReactNode;
  choices: Choice<T>[];
  width?: number;
}

interface Pending {
  opts: ChoiceOpts<string>;
  resolve: (v: string | null) => void;
}

const useChoice = create<{ pending: Pending | null }>(() => ({ pending: null }));

export function choiceDialog<T extends string>(opts: ChoiceOpts<T>): Promise<T | null> {
  return new Promise((resolve) => {
    useChoice.getState().pending?.resolve(null);
    useChoice.setState({ pending: { opts, resolve: resolve as (v: string | null) => void } });
  });
}

export function ChoiceDialogHost() {
  const pending = useChoice((s) => s.pending);
  if (!pending) return null;
  const done = (v: string | null) => {
    useChoice.setState({ pending: null });
    pending.resolve(v);
  };
  const { opts } = pending;
  return (
    <Modal
      open
      title={opts.title}
      width={opts.width ?? 500}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>
            Cancelar
          </button>
          {opts.choices.map((c) => (
            <button
              key={c.value}
              autoFocus={c.primary}
              className={c.primary ? "btn btn-primary" : "btn"}
              onClick={() => done(c.value)}
            >
              {c.label}
            </button>
          ))}
        </>
      }
    >
      <div className="dialog-message">{opts.message}</div>
    </Modal>
  );
}
