// Diálogo del PIN abierto desde el candado de la barra de pestañas (crear o cambiar).
import { Modal } from "../../components/ui/Modal";
import { useLock } from "./lockStore";
import { ChangePinForm, SetupPinForm, WhatItProtects } from "./PinForms";
import "./Lock.css";

export function PinDialogHost() {
  const dialog = useLock((s) => s.pinDialog);
  const enabled = useLock((s) => !!s.status?.enabled);
  const close = () => useLock.setState({ pinDialog: null });
  if (!dialog) return null;
  // Si el estado cambió mientras tanto (p. ej. otra ventana creó el PIN), no tiene sentido.
  if ((dialog === "change") !== enabled) return null;
  return (
    <Modal open title={dialog === "change" ? "Cambiar PIN" : "Proteger con PIN"} onClose={close} width={420}>
      {dialog === "change" ? (
        <ChangePinForm onDone={close} onCancel={close} />
      ) : (
        <div className="lock-form">
          <WhatItProtects />
          <SetupPinForm autoFocus onDone={close} onCancel={close} />
        </div>
      )}
    </Modal>
  );
}
