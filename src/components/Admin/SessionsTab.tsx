// Sub-pestaña «Conectados ahora»: sesiones con terminal (`who`) y botón para cerrarlas.
import { useMemo, useState } from "react";
import { LogOut } from "lucide-react";
import { killSessionPlan, validateTty, type WhoEntry } from "../../features/admin";
import { useAdmin } from "./context";
import { VirtualTable, type Column } from "./VirtualTable";
import { PlanModal } from "./PlanReview";

type Row = WhoEntry & { key: string };

export function SessionsTab() {
  const { read, readOnly, env, me } = useAdmin();
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState<Row | null>(null);
  const rows: Row[] = useMemo(() => (read?.who ?? []).map((w, i) => ({ ...w, key: `${w.tty}-${i}` })), [read]);
  const canKill = !readOnly && !!env?.killTool;
  const killTitle = readOnly ? "Necesitas root o sudo" : !env?.killTool ? "No hay pkill (procps) ni ps de busybox en el servidor" : undefined;

  const columns: Column<Row>[] = useMemo(
    () => [
      {
        key: "user",
        label: "Usuario",
        width: "minmax(110px, 1fr)",
        render: (w) => (
          <span className="adm-name">
            {w.user}
            {w.user === me && <span className="adm-you">tú</span>}
          </span>
        ),
      },
      { key: "tty", label: "Terminal", width: "100px", render: (w) => <span className="mono">{w.tty}</span> },
      { key: "since", label: "Desde", width: "minmax(130px, 1fr)", render: (w) => w.since || <span className="faint">—</span>, title: (w) => w.since },
      { key: "from", label: "Origen", width: "minmax(130px, 1fr)", render: (w) => <span className="mono">{w.from || "local"}</span>, title: (w) => w.from },
      {
        key: "act",
        label: "",
        width: "130px",
        render: (w) => (
          <button
            className="btn btn-sm adm-btn-danger-soft adm-row-btn"
            disabled={!canKill || !!validateTty(w.tty)}
            title={killTitle}
            onClick={(e) => {
              e.stopPropagation();
              setTarget(w);
            }}
          >
            <LogOut size={12} /> Cerrar sesión
          </button>
        ),
      },
    ],
    [me, canKill, killTitle],
  );

  const plan = target && env ? killSessionPlan(env, target.tty, target.user) : null;

  return (
    <div className="adm-pane">
      <div className="adm-toolbar">
        <span className="muted">Sesiones con terminal según <code>who</code>.</span>
      </div>
      <VirtualTable
        label="Sesiones abiertas"
        columns={columns}
        rows={rows}
        rowKey={(w) => w.key}
        selected={selected}
        onSelect={setSelected}
        placeholder={
          <div className="adm-empty-text">
            No hay sesiones con terminal registradas.
            <div className="faint">
              Las conexiones sin terminal (como las que usa TerView para archivos y comandos) no aparecen, y algunos
              servidores o contenedores no registran las sesiones.
            </div>
          </div>
        }
      />
      <div className="adm-statusbar">
        {rows.length} {rows.length === 1 ? "sesión" : "sesiones"}
      </div>
      {plan && target && (
        <PlanModal
          title="Cerrar sesión"
          plan={plan}
          onCancel={() => setTarget(null)}
          onDone={() => setTarget(null)}
          runLabel="Cerrar sesión"
        >
          <p className="dialog-message">
            Se terminarán a la fuerza todos los procesos de <strong>{target.user}</strong> en la terminal{" "}
            <span className="mono">{target.tty}</span>
            {target.from ? ` (desde ${target.from})` : ""}. Lo que no haya guardado se perderá.
            {target.user === me && " ¡Ojo: es tu propio usuario; podría ser una de tus terminales!"}
          </p>
        </PlanModal>
      )}
    </div>
  );
}
