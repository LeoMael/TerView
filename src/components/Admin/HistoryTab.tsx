// Sub-pestaña «Historial»: cambios hechos desde la app en este servidor (sin contraseñas).
import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Trash2, XCircle } from "lucide-react";
import { HISTORY_LIMIT, useAdminHistory, useHistoryOf } from "../../features/admin";
import { confirmDialog } from "../ui/dialogs";
import { useAdmin } from "./context";

function fmt(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function HistoryTab() {
  const { profileId } = useAdmin();
  const list = useHistoryOf(profileId);
  const clear = useAdminHistory((s) => s.clear);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    const n = new Set(open);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setOpen(n);
  };

  return (
    <div className="adm-pane">
      <div className="adm-toolbar">
        <span className="muted">
          Cambios hechos desde SSHorus en este servidor (se guardan en este equipo, máximo {HISTORY_LIMIT}). Nunca incluyen
          contraseñas.
        </span>
        <div className="adm-spacer" />
        <button
          className="btn btn-sm"
          disabled={!list.length}
          onClick={async () => {
            if (await confirmDialog({ title: "¿Borrar el historial?", message: "Se borrará el historial de administración de este servidor.", confirmText: "Borrar", danger: true }))
              clear(profileId);
          }}
        >
          <Trash2 size={13} /> Borrar historial
        </button>
      </div>
      {list.length === 0 ? (
        <div className="empty-state">Todavía no has hecho cambios en este servidor desde SSHorus.</div>
      ) : (
        <ul className="adm-history" aria-label="Historial de cambios">
          {list.map((e) => {
            const isOpen = open.has(e.id);
            return (
              <li key={e.id} className={`adm-hist${e.ok ? "" : " err"}`}>
                <button className="adm-hist-head" onClick={() => toggle(e.id)} aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {e.ok ? <CheckCircle2 size={13} className="adm-ok" /> : <XCircle size={13} className="adm-bad" />}
                  <span className="adm-hist-date mono">{fmt(e.at)}</span>
                  <span className="adm-hist-action">{e.action}</span>
                  <span className="adm-hist-server faint">{e.server}</span>
                </button>
                {isOpen && (
                  <div className="adm-hist-body">
                    <pre className="adm-cmd adm-cmd-sm">{e.command}</pre>
                    <div className={e.ok ? "adm-hist-result" : "adm-hist-result err"}>
                      <pre>{e.result}</pre>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
