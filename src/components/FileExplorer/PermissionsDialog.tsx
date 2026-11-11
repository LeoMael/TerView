// Diálogo de permisos (rwx para dueño / grupo / otros + campo octal).
import { useState } from "react";
import { Modal } from "../ui/Modal";
import type { FileEntry } from "../../api/types";

interface Props {
  entries: FileEntry[];
  onCancel: () => void;
  onApply: (mode: number) => void;
}

const WHO = [
  { label: "Dueño", shift: 6 },
  { label: "Grupo", shift: 3 },
  { label: "Otros", shift: 0 },
];
const BITS = [
  { label: "Lectura", bit: 4 },
  { label: "Escritura", bit: 2 },
  { label: "Ejecución", bit: 1 },
];
const SPECIAL = [
  { label: "SetUID", bit: 0o4000 },
  { label: "SetGID", bit: 0o2000 },
  { label: "Sticky", bit: 0o1000 },
];

const toOctal = (m: number) => (m & 0o7777).toString(8).padStart(m & 0o7000 ? 4 : 3, "0");

export function PermissionsDialog({ entries, onCancel, onApply }: Props) {
  const first = entries[0];
  const [mode, setMode] = useState<number>((first?.permissions ?? 0o644) & 0o7777);
  const [octal, setOctal] = useState(toOctal(mode));
  const [error, setError] = useState<string | null>(null);

  const setBoth = (m: number) => {
    setMode(m);
    setOctal(toOctal(m));
    setError(null);
  };

  const onOctal = (v: string) => {
    setOctal(v);
    if (/^[0-7]{3,4}$/.test(v)) {
      setMode(parseInt(v, 8));
      setError(null);
    } else {
      setError("Escribe 3 o 4 dígitos entre 0 y 7 (p. ej. 755)");
    }
  };

  const submit = () => {
    if (!/^[0-7]{3,4}$/.test(octal)) {
      setError("Escribe 3 o 4 dígitos entre 0 y 7 (p. ej. 755)");
      return;
    }
    onApply(mode);
  };

  const title = entries.length === 1 ? `Permisos de «${first?.name}»` : `Permisos de ${entries.length} elementos`;
  const differs = entries.some((e) => ((e.permissions ?? 0) & 0o7777) !== ((first?.permissions ?? 0) & 0o7777));

  return (
    <Modal
      open
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={submit}>
            Aplicar
          </button>
        </>
      }
    >
      {differs && <div className="dialog-message">Los elementos tienen permisos distintos; se aplicarán estos a todos.</div>}
      <table className="fx-perm-table">
        <thead>
          <tr>
            <th />
            {BITS.map((b) => (
              <th key={b.bit}>{b.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((w) => (
            <tr key={w.shift}>
              <th scope="row">{w.label}</th>
              {BITS.map((b) => {
                const mask = b.bit << w.shift;
                return (
                  <td key={b.bit}>
                    <input
                      type="checkbox"
                      aria-label={`${w.label}: ${b.label}`}
                      checked={(mode & mask) !== 0}
                      onChange={(e) => setBoth(e.target.checked ? mode | mask : mode & ~mask)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fx-perm-special">
        {SPECIAL.map((s) => (
          <label key={s.bit} className="checkbox">
            <input type="checkbox" checked={(mode & s.bit) !== 0} onChange={(e) => setBoth(e.target.checked ? mode | s.bit : mode & ~s.bit)} />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
      <label className="field fx-perm-octal">
        <span>Octal</span>
        <input
          className="input mono"
          value={octal}
          maxLength={4}
          onChange={(e) => onOctal(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
      </label>
      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}
