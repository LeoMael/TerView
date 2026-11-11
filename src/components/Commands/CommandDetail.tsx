// Panel derecho: descripción, variables, vista previa exacta, acciones y resultado.
import { useMemo, useState } from "react";
import { Copy, CopyPlus, Pencil, Play, SquareTerminal, Terminal, Trash2 } from "lucide-react";
import { DISTRO_LABEL } from "./catalog";
import { captureBlockedReason, toTerminal } from "./actions";
import { CommandTags, Preview, ResultView, VarField, initialValues, rememberValues } from "./parts";
import type { CommandItem } from "./state";
import { missingVars, parseVars, renderTemplate, varLabel } from "./template";
import { useRun } from "./useRun";

interface Props {
  item: CommandItem;
  sessionId: string;
  disabled: boolean;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onCopyToMine?: () => void;
}

export function CommandDetail({ item, sessionId, disabled, onEdit, onDuplicate, onDelete, onCopyToMine }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(sessionId, item));
  const { state, start, cancel, clear } = useRun(sessionId);
  const vars = useMemo(() => parseVars(item.command), [item.command]);
  const missing = missingVars(item.command, values);
  const finalCmd = useMemo(() => renderTemplate(item.command, values, { fillMissing: true }), [item.command, values]);
  const blocked = captureBlockedReason(item);
  const missingMsg = missing.length ? `Completa: ${missing.map(varLabel).join(", ")}` : null;
  const off = disabled || missing.length > 0;

  const submit = async (mode: "insert" | "run" | "capture") => {
    if (off) return;
    rememberValues(sessionId, values);
    if (mode === "capture") {
      if (!blocked) await start(item, finalCmd);
      return;
    }
    await toTerminal(sessionId, item, finalCmd, mode === "run");
  };

  return (
    <div className="cmd-detail">
      <div className="cmd-detail-scroll">
        <div className="cmd-detail-head">
          <h2 className={item.dangerous ? "danger" : undefined}>{item.name}</h2>
          <span className="cmd-spacer" />
          {item.custom ? (
            <>
              <button className="icon-btn" title="Editar" onClick={onEdit}>
                <Pencil size={14} />
              </button>
              <button className="icon-btn" title="Duplicar" onClick={onDuplicate}>
                <CopyPlus size={14} />
              </button>
              <button className="icon-btn cmd-icon-danger" title="Eliminar" onClick={onDelete}>
                <Trash2 size={14} />
              </button>
            </>
          ) : (
            <button className="icon-btn" title="Copiar a Mis comandos (para modificarlo)" onClick={onCopyToMine}>
              <Copy size={14} />
            </button>
          )}
        </div>
        <div className="cmd-detail-sub">
          {item.description && <p className="cmd-desc">{item.description}</p>}
          <div className="cmd-detail-tags">
            <CommandTags item={item} />
            {item.distro && <span className="cmd-tag">{DISTRO_LABEL[item.distro]}</span>}
            {item.interactive && <span className="cmd-tag">interactivo</span>}
            <span className="faint">
              {item.custom ? `Mis comandos · ${item.group}` : `${item.category} · ${item.group}`}
            </span>
          </div>
        </div>

        {vars.length > 0 && (
          <div className="cmd-vars">
            {vars.map((v) => (
              <VarField
                key={v.name}
                name={v.name}
                spec={item.vars?.[v.name] ?? { default: v.default }}
                value={values[v.name] ?? ""}
                onChange={(val) => setValues((s) => ({ ...s, [v.name]: val }))}
                sessionId={disabled ? null : sessionId}
                disabled={disabled}
                showHint
                onEnter={(e) => {
                  e.preventDefault();
                  void submit(e.ctrlKey ? "capture" : e.altKey ? "insert" : "run");
                }}
              />
            ))}
          </div>
        )}

        <div className="cmd-preview-label">Se ejecutará:</div>
        <Preview item={item} values={values} />
        {item.sudo && (
          <div className="cmd-note">
            Usa sudo: la contraseña se escribe en la terminal y nunca se guarda.
          </div>
        )}

        <div className="cmd-actions">
          <button
            className="btn"
            disabled={off}
            title={missingMsg ?? "Escribe el comando en la terminal sin pulsar Enter (Alt+Enter)"}
            onClick={() => submit("insert")}
          >
            <SquareTerminal size={14} /> Insertar en terminal
          </button>
          <button
            className={item.dangerous ? "btn btn-danger" : "btn btn-primary"}
            disabled={off}
            title={missingMsg ?? "Ejecuta en la terminal activa (Enter)"}
            onClick={() => submit("run")}
          >
            <Terminal size={14} /> Ejecutar
          </button>
          {/* El span muestra el motivo aunque el botón esté desactivado. */}
          <span
            className="cmd-btn-wrap"
            title={
              blocked
                ? blocked.charAt(0).toLowerCase() + blocked.slice(1)
                : (missingMsg ?? "Lo corre aparte y muestra la salida aquí (Ctrl+Enter)")
            }
          >
            <button className="btn" disabled={off || !!blocked || !!state?.running} onClick={() => submit("capture")}>
              <Play size={14} /> Ejecutar y ver resultado
            </button>
          </span>
        </div>
        {state && <ResultView state={state} onCancel={cancel} onClose={clear} />}
      </div>
    </div>
  );
}
