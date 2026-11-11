// Importar servidores de ~/.ssh/config. DUEÑO: agente Almacenamiento/Sidebar.
import { useEffect, useState } from "react";
import { FileSearch, KeyRound } from "lucide-react";
import { Modal } from "../ui/Modal";
import { profiles } from "../../api/profiles";
import { errorMessage } from "../../api/core";
import type { ServerProfile } from "../../api/types";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { SSH_CONFIG_LABEL } from "../../lib/platform";

function userHostPort(s: ServerProfile) {
  return `${s.username}@${s.host}:${s.port}`;
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; candidates: ServerProfile[] };

export function ImportSshConfigDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  /** Índices desmarcados (todo marcado por defecto). */
  const [off, setOff] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    profiles
      .importSshConfig()
      .then((candidates) => alive && setState({ phase: "ready", candidates }))
      .catch((e) => alive && setState({ phase: "error", message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, []);

  const candidates = state.phase === "ready" ? state.candidates : [];
  const chosen = candidates.filter((_, i) => !off.has(i));
  const allOn = off.size === 0;

  const toggle = (i: number) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const toggleAll = () => setOff(allOn ? new Set(candidates.map((_, i) => i)) : new Set());

  const submit = async () => {
    if (chosen.length === 0 || saving) return;
    setSaving(true);
    const n = await useProfiles.getState().importServers(chosen);
    setSaving(false);
    if (n > 0) toast.success(n === 1 ? "1 servidor importado" : `${n} servidores importados`);
    onClose();
  };

  return (
    <Modal
      open
      title={`Importar de ${SSH_CONFIG_LABEL}`}
      onClose={() => !saving && onClose()}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            {state.phase === "ready" && candidates.length > 0 ? "Cancelar" : "Cerrar"}
          </button>
          {state.phase === "ready" && candidates.length > 0 && (
            <button className="btn btn-primary" onClick={() => void submit()} disabled={chosen.length === 0 || saving}>
              {saving ? <span className="spinner sb-spinner" /> : null}
              Importar {chosen.length}
            </button>
          )}
        </>
      }
    >
      {state.phase === "loading" && (
        <div className="sb-imp-status">
          <span className="spinner sb-spinner" /> Leyendo {SSH_CONFIG_LABEL}…
        </div>
      )}
      {state.phase === "error" && <div className="field-error sb-imp-error">{state.message}</div>}
      {state.phase === "ready" && candidates.length === 0 && (
        <div className="empty-state sb-imp-empty">
          <FileSearch size={26} strokeWidth={1.5} />
          <div>No hay servidores nuevos en {SSH_CONFIG_LABEL}</div>
        </div>
      )}
      {state.phase === "ready" && candidates.length > 0 && (
        <>
          <div className="dialog-message">
            Se encontraron {candidates.length === 1 ? "1 servidor" : `${candidates.length} servidores`} que aún no
            están en TerView. Las contraseñas se pedirán al conectar.
          </div>
          <label className="checkbox sb-imp-all">
            <input
              type="checkbox"
              checked={allOn}
              ref={(el) => {
                if (el) el.indeterminate = !allOn && chosen.length > 0;
              }}
              onChange={toggleAll}
            />
            Seleccionar todos
          </label>
          <div className="sb-imp-list" role="group" aria-label="Servidores encontrados">
            {candidates.map((c, i) => (
              <label key={`${c.name}-${i}`} className="sb-imp-row" title={c.keyPath ?? undefined}>
                <input type="checkbox" checked={!off.has(i)} onChange={() => toggle(i)} />
                <span className="sb-imp-name">{c.name}</span>
                <span className="sb-imp-sub mono">{userHostPort(c)}</span>
                {c.auth === "key" && <KeyRound size={13} className="sb-imp-key" aria-label="Con llave" />}
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
