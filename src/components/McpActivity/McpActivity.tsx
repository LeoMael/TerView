// «Actividad del asistente»: cada acción del asistente de IA, en qué servidor, con qué resultado y
// quién la aprobó. Lo mismo queda en el archivo mcp-audit.jsonl de la carpeta de configuración.
import type { ReactNode } from "react";
import { Ban, CheckCircle2, CircleDot, Lock, Square, Trash2, XCircle } from "lucide-react";
import { Modal } from "../ui/Modal";
import { mcp, type AuditEntry, type AuditStatus } from "../../api/mcp";
import { snippets } from "../../api/snippets";
import { toast } from "../../stores/toasts";
import { closeActivity, useMcp } from "../../features/mcp/store";
import "../../features/mcp/Mcp.css";

const STATUS: Record<AuditStatus, { label: string; icon: ReactNode }> = {
  running: { label: "En curso", icon: <CircleDot size={14} /> },
  ok: { label: "Hecho", icon: <CheckCircle2 size={14} /> },
  error: { label: "Error", icon: <XCircle size={14} /> },
  denied: { label: "Denegado", icon: <Ban size={14} /> },
  locked: { label: "Bloqueado", icon: <Lock size={14} /> },
};

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString("es")} ${time}`;
}

function duration(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Row({ e }: { e: AuditEntry }) {
  const st = STATUS[e.status];
  return (
    <div className={`mcp-act-row mcp-st-${e.status}`}>
      <span className="mcp-act-status" title={st.label}>
        {st.icon}
      </span>
      <div className="mcp-act-main">
        <div className="mcp-act-top">
          <span className="mcp-act-tool">{e.tool}</span>
          {e.serverName && <span className="mcp-act-server">{e.serverName}</span>}
          <span className="mcp-act-time">{when(e.at)}</span>
        </div>
        {e.detail && (
          <div className="mcp-act-detail mono" title={e.detail}>
            {e.detail}
          </div>
        )}
        <div className="mcp-act-meta">
          <span>{st.label}</span>
          {e.approvedBy && <span>· aprobó: {e.approvedBy}</span>}
          {e.durationMs !== null && <span>· {duration(e.durationMs)}</span>}
          {e.client && <span className="faint">· {e.client}</span>}
        </div>
        {e.message && e.status !== "ok" && <div className="mcp-act-msg">{e.message}</div>}
        {e.message && e.status === "ok" && <div className="mcp-act-msg faint">{e.message}</div>}
      </div>
      {e.status === "running" && e.execId && (
        <button
          className="btn btn-sm"
          title="Detener el comando (también en el servidor)"
          onClick={() => {
            if (e.execId) void snippets.cancelExec(e.execId).catch((err) => toast.error("No se pudo detener", err));
          }}
        >
          <Square size={12} /> Detener
        </button>
      )}
    </div>
  );
}

export function McpActivity() {
  const open = useMcp((s) => s.activityOpen);
  const activity = useMcp((s) => s.activity);
  const auditPath = useMcp((s) => s.status?.auditPath ?? null);
  if (!open) return null;
  return (
    <Modal
      open
      title="Actividad del asistente"
      onClose={closeActivity}
      width="min(860px, 94vw)"
      footer={
        <>
          <span className="mcp-act-path faint" title={auditPath ?? undefined}>
            {auditPath ? `Registro: ${auditPath}` : ""}
          </span>
          <button
            className="btn"
            onClick={() => {
              void mcp.clearActivity().then(() => useMcp.setState((s) => ({ activity: s.activity.filter((x) => x.status === "running") })));
            }}
            disabled={activity.length === 0}
            title="Vacía esta lista. El archivo de registro se conserva."
          >
            <Trash2 size={14} /> Vaciar lista
          </button>
          <button className="btn btn-primary" onClick={closeActivity} autoFocus>
            Cerrar
          </button>
        </>
      }
    >
      {activity.length === 0 ? (
        <div className="empty-state">Todavía no hay actividad del asistente.</div>
      ) : (
        <div className="mcp-act-list">
          {activity.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </div>
      )}
    </Modal>
  );
}
