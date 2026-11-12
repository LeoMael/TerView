// Vista previa al importar "Mis comandos": cuántos se añaden, actualizan u omiten antes de guardar.
import { useState } from "react";
import { AlertTriangle, FileJson } from "lucide-react";
import { Modal } from "../ui/Modal";
import { applyImport, type ImportPlan } from "./transfer";

interface Props {
  plan: ImportPlan;
  /** De dónde viene (ruta del archivo o «portapapeles»). */
  source: string;
  onClose: () => void;
}

const MAX_ROWS = 60;

export function ImportSnippetsDialog({ plan, source, onClose }: Props) {
  const [withUpdates, setWithUpdates] = useState(true);
  const [saving, setSaving] = useState(false);
  const nothing = plan.add.length === 0 && plan.update.length === 0;
  const count = plan.add.length + (withUpdates ? plan.update.length : 0);

  const submit = async () => {
    if (saving || count === 0) return;
    setSaving(true);
    await applyImport(plan, withUpdates);
    setSaving(false);
    onClose();
  };

  const rows = [
    ...plan.add.map((s) => ({ key: `a-${s.name}-${s.scope}`, name: s.name, cmd: s.command, tag: "nuevo" as const })),
    ...plan.update.map((u) => ({ key: `u-${u.before.id}`, name: u.after.name, cmd: u.after.command, tag: "actualiza" as const })),
  ];

  return (
    <Modal
      open
      title="Importar comandos"
      onClose={() => !saving && onClose()}
      width={540}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            {nothing ? "Cerrar" : "Cancelar"}
          </button>
          {!nothing && (
            <button className="btn btn-primary" onClick={() => void submit()} disabled={saving || count === 0}>
              {saving ? <span className="spinner cmd-spinner-xs" /> : null}
              Importar {count}
            </button>
          )}
        </>
      }
    >
      <div className="cmd-imp">
        <div className="cmd-imp-source faint" title={source}>
          <FileJson size={13} /> <span className="mono">{source}</span>
        </div>
        <div className="cmd-imp-stats" role="status">
          <span className="cmd-imp-stat add">
            <b>{plan.add.length}</b> {plan.add.length === 1 ? "se añade" : "se añaden"}
          </span>
          <span className="cmd-imp-stat upd">
            <b>{plan.update.length}</b> {plan.update.length === 1 ? "se actualiza" : "se actualizan"}
          </span>
          <span className="cmd-imp-stat">
            <b>{plan.skipped}</b> {plan.skipped === 1 ? "se omite (ya existe)" : "se omiten (ya existen)"}
          </span>
          {plan.invalidCount > 0 && (
            <span className="cmd-imp-stat bad">
              <b>{plan.invalidCount}</b> {plan.invalidCount === 1 ? "no es válido" : "no son válidos"}
            </span>
          )}
        </div>

        {plan.invalid.length > 0 && (
          <div className="cmd-note cmd-imp-invalid">
            <AlertTriangle size={13} />
            <span>
              {plan.invalid.join(" · ")}
              {plan.invalidCount > plan.invalid.length && ` · y ${plan.invalidCount - plan.invalid.length} más`}
            </span>
          </div>
        )}

        {nothing ? (
          <div className="cmd-imp-empty faint">
            {plan.total === 0 ? "El archivo no tiene comandos." : "No hay nada nuevo que importar."}
          </div>
        ) : (
          <>
            <div className="cmd-imp-list" role="list">
              {rows.slice(0, MAX_ROWS).map((r) => (
                <div
                  key={r.key}
                  role="listitem"
                  className={`cmd-imp-row${r.tag === "actualiza" && !withUpdates ? " off" : ""}`}
                  title={r.cmd}
                >
                  <span className={`cmd-imp-tag ${r.tag === "nuevo" ? "add" : "upd"}`}>{r.tag}</span>
                  <span className="cmd-imp-name">{r.name}</span>
                  <span className="cmd-imp-cmd mono">{r.cmd.split("\n")[0]}</span>
                </div>
              ))}
              {rows.length > MAX_ROWS && <div className="cmd-imp-more faint">y {rows.length - MAX_ROWS} más…</div>}
            </div>
            {plan.update.length > 0 && (
              <label className="checkbox cmd-imp-check">
                <input type="checkbox" checked={withUpdates} onChange={(e) => setWithUpdates(e.target.checked)} />
                Actualizar los que ya tengo con el mismo nombre ({plan.update.length})
              </label>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
