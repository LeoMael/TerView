// Llaves SSH de un usuario (~/.ssh/authorized_keys): ver, añadir y quitar líneas.
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeySquare, Plus, Trash2 } from "lucide-react";
import { errorMessage } from "../../api/core";
import { parsePublicKey, readKeys, setKeysPlan, type Plan, type UserRow } from "../../features/admin";
import { useAdmin } from "./context";
import { AdmModal } from "./AdmModal";
import { PlanReview } from "./PlanReview";

function describe(line: string): { type: string; body: string; comment: string; options: string } {
  const k = parsePublicKey(line);
  if (!k.ok) return { type: "?", body: line, comment: "", options: "" };
  const parts = k.line.split(/\s+/);
  const i = parts.indexOf(k.type);
  const body = parts[i + 1] ?? "";
  return {
    type: k.type.replace(/^ssh-/, "").replace(/@openssh\.com$/, ""),
    body: body.length > 28 ? `${body.slice(0, 12)}…${body.slice(-12)}` : body,
    comment: k.comment,
    options: parts.slice(0, i).join(" "),
  };
}

export function KeysDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { sessionId, elevation, me, readOnly } = useAdmin();
  const [lines, setLines] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  // Leer las de otro usuario exige root; las propias se pueden leer sin elevar.
  const readAs = useMemo(
    () => elevation ?? (user.name === me ? ({ kind: "none" } as const) : null),
    [elevation, user.name, me],
  );

  const load = useCallback(async () => {
    if (!readAs) {
      setLoadError("Necesitas root o sudo para ver las llaves de otro usuario");
      return;
    }
    setLoadError(null);
    try {
      setLines(await readKeys(sessionId, user.name, readAs));
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [sessionId, user.name, readAs]);

  useEffect(() => {
    void load();
  }, [load]);

  const title = `Llaves SSH de ${user.name}`;

  if (plan) {
    return (
      <AdmModal title={title} onClose={onClose} width={640}>
        <PlanReview
          plan={plan}
          onBack={() => setPlan(null)}
          onCancel={() => setPlan(null)}
          onDone={() => {
            setPlan(null);
            setNewKey("");
            void load();
          }}
        />
      </AdmModal>
    );
  }

  const add = () => {
    const k = parsePublicKey(newKey);
    if (!k.ok) return setKeyError(k.error);
    if (lines?.some((l) => l.trim() === k.line)) return setKeyError("Esa llave ya está");
    setPlan(setKeysPlan(user.name, [...(lines ?? []), k.line], `Añadir llave SSH a «${user.name}»`));
  };

  return (
    <AdmModal title={title} onClose={onClose} width={640}>
      <div className="modal-body">
        <p className="dialog-message">
          Archivo <span className="mono">{user.home}/.ssh/authorized_keys</span>. Al guardar se dejan la carpeta en 700
          y el archivo en 600, ambos del usuario.
        </p>
        {loadError ? (
          <div className="adm-error" role="alert">
            <pre>{loadError}</pre>
          </div>
        ) : lines === null ? (
          <div className="adm-loading">
            <span className="spinner" /> Leyendo llaves…
          </div>
        ) : lines.length === 0 ? (
          <div className="adm-note">Este usuario no tiene llaves autorizadas.</div>
        ) : (
          <ul className="adm-keys" aria-label="Llaves autorizadas">
            {lines.map((l, i) => {
              const d = describe(l);
              return (
                <li key={`${i}-${l}`} className="adm-key">
                  <KeySquare size={14} />
                  <span className="adm-key-type">{d.type}</span>
                  <span className="mono adm-key-body" title={l}>
                    {d.body}
                  </span>
                  <span className="adm-key-comment" title={d.options || d.comment}>
                    {d.comment || <span className="faint">sin comentario</span>}
                    {d.options && <span className="faint"> · con opciones</span>}
                  </span>
                  <button
                    className="icon-btn"
                    disabled={readOnly}
                    title={readOnly ? "Necesitas root o sudo" : "Quitar esta llave"}
                    aria-label={`Quitar llave ${d.comment || i + 1}`}
                    onClick={() =>
                      setPlan({
                        ...setKeysPlan(
                          user.name,
                          lines.filter((_, j) => j !== i),
                          `Quitar llave SSH${d.comment ? ` «${d.comment}»` : ""} de «${user.name}»`,
                        ),
                        danger: true,
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!readOnly && lines !== null && (
          <div className="field adm-mt">
            <span className="adm-field-label">Añadir llave pública</span>
            <textarea
              className="textarea mono adm-key-input"
              rows={2}
              value={newKey}
              spellCheck={false}
              placeholder="ssh-ed25519 AAAA… usuario@equipo"
              onChange={(e) => {
                setNewKey(e.target.value);
                setKeyError(null);
              }}
            />
            {keyError && (
              <div className="field-error" role="alert">
                {keyError}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
        {!readOnly && (
          <button className="btn btn-primary" disabled={!newKey.trim() || lines === null} onClick={add}>
            <Plus size={13} /> Añadir llave…
          </button>
        )}
      </div>
    </AdmModal>
  );
}
