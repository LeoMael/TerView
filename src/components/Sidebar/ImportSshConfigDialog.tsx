// Importar servidores de ~/.ssh/config. DUEÑO: agente Almacenamiento/Sidebar.
import { useEffect, useState } from "react";
import { FileSearch, KeyRound } from "lucide-react";
import { Modal } from "../ui/Modal";
import { sshAliases, type SshImportCandidate } from "../../api/profiles";
import { errorMessage } from "../../api/core";
import type { ServerProfile } from "../../api/types";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { SSH_CONFIG_LABEL } from "../../lib/platform";
import "./ImportSshConfigDialog.css";

function userHostPort(s: ServerProfile) {
  return `${s.username}@${s.host}:${s.port}`;
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; candidates: SshImportCandidate[] };

export function ImportSshConfigDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  /** Índices desmarcados (todo lo nuevo marcado por defecto; lo que ya existe no se puede marcar). */
  const [off, setOff] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    sshAliases
      .importPreview()
      .then((candidates) => alive && setState({ phase: "ready", candidates }))
      .catch((e) => alive && setState({ phase: "error", message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, []);

  const candidates = state.phase === "ready" ? state.candidates : [];
  const isNew = (c: SshImportCandidate) => c.existingId === null;
  const fresh = candidates.flatMap((c, i) => (isNew(c) ? [i] : []));
  const existingCount = candidates.length - fresh.length;
  const chosen: ServerProfile[] = fresh.filter((i) => !off.has(i)).map((i) => candidates[i].server);
  const allOn = fresh.every((i) => !off.has(i));

  const toggle = (i: number) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const toggleAll = () => setOff(allOn ? new Set(fresh) : new Set());

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
            {state.phase === "ready" && fresh.length > 0 ? "Cancelar" : "Cerrar"}
          </button>
          {state.phase === "ready" && fresh.length > 0 && (
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
      {state.phase === "ready" && fresh.length === 0 && (
        <div className="empty-state sb-imp-empty">
          <FileSearch size={26} strokeWidth={1.5} />
          <div>No hay servidores nuevos en {SSH_CONFIG_LABEL}</div>
          {existingCount > 0 && (
            <div className="faint">
              {existingCount === 1 ? "El que hay ya está en TerView." : `Los ${existingCount} que hay ya están en TerView.`}
            </div>
          )}
        </div>
      )}
      {state.phase === "ready" && fresh.length > 0 && (
        <>
          <div className="dialog-message">
            Se encontraron {fresh.length === 1 ? "1 servidor" : `${fresh.length} servidores`} que aún no están en
            TerView
            {existingCount > 0 && ` (y ${existingCount === 1 ? "1 que ya está" : `${existingCount} que ya están`}, marcados abajo)`}.
            Las contraseñas se pedirán al conectar.
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
            {candidates.map((c, i) => {
              const s = c.server;
              const exists = !isNew(c);
              const title = exists
                ? `Ya está en TerView como «${c.existingName ?? s.name}»`
                : c.aliasUsedBy
                  ? `TerView ya exporta «${c.aliasUsedBy}» con el alias «${s.name}»: al exportar se te propondrá otro alias`
                  : (s.keyPath ?? undefined);
              return (
                <label key={`${s.name}-${i}`} className={`sb-imp-row${exists ? " ssh-imp-exists" : ""}`} title={title}>
                  <input type="checkbox" checked={!exists && !off.has(i)} disabled={exists} onChange={() => toggle(i)} />
                  <span className="sb-imp-name">{s.name}</span>
                  <span className="sb-imp-sub mono">{userHostPort(s)}</span>
                  {s.auth === "key" && <KeyRound size={13} className="sb-imp-key" aria-label="Con llave" />}
                  {exists ? (
                    <span className="ssh-imp-badge">Ya en TerView</span>
                  ) : (
                    c.aliasUsedBy && <span className="ssh-imp-badge warn">Alias en uso</span>
                  )}
                </label>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
