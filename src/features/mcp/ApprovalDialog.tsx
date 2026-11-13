// Diálogo «Permiso del asistente»: el asistente de IA quiere cambiar algo en un servidor.
// Muestra el comando exacto (o el archivo con sus diferencias) y espera tu respuesta.
// Si nadie responde a tiempo, el motor lo deniega solo y el diálogo se cierra.
// También ofrece «Aceptar automáticamente en este servidor…» (ver AutoAccept.tsx): al activarlo, si el
// modo elegido cubre esta petición, se permite ya.
import { useEffect, useState } from "react";
import { AlertTriangle, Bot, Zap } from "lucide-react";
import { Modal } from "../../components/ui/Modal";
import { mcp, type McpApprovalRequest, type McpDecision } from "../../api/mcp";
import { toast } from "../../stores/toasts";
import { useMcp } from "./store";
import { AutoAcceptPicker } from "./AutoAccept";
import "./Mcp.css";

function useSecondsLeft(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="mcp-diff" aria-label="Diferencias">
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("@@")
          ? "mcp-diff-hunk"
          : line.startsWith("+")
            ? "mcp-diff-add"
            : line.startsWith("-")
              ? "mcp-diff-del"
              : line.startsWith("(")
                ? "mcp-diff-note"
                : "";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function alwaysLabel(r: McpApprovalRequest): string {
  if (r.tool === "run_command" || r.tool === "run_catalog_command") return "Permitir siempre este comando en este servidor";
  if (r.tool === "write_file") return "Permitir siempre en este archivo";
  if (r.tool === "connect") return "Permitir siempre conectar";
  if (r.tool === "scan_vulnerabilities") return "Permitir siempre analizar este servidor";
  return "Permitir siempre esto en este servidor";
}

function Request({ req, total }: { req: McpApprovalRequest; total: number }) {
  const left = useSecondsLeft(req.expiresAt);
  const [busy, setBusy] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const who = req.client ? `El asistente (${req.client})` : "El asistente";

  const answer = async (d: McpDecision) => {
    setBusy(true);
    try {
      await mcp.reply(req.id, d);
    } catch (e) {
      toast.error("No se pudo enviar la respuesta", e);
    } finally {
      // El motor avisa con «approval-done»; por si acaso, se quita ya de la cola.
      useMcp.setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== req.id) }));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={total > 1 ? `Permiso del asistente (1 de ${total})` : "Permiso del asistente"}
      onClose={() => void answer("deny")}
      width="min(680px, 94vw)"
      footer={
        <>
          <span className="mcp-countdown" aria-live="polite">
            Se denegará solo en {left} s
          </span>
          <button className="btn" onClick={() => void answer("deny")} disabled={busy} autoFocus>
            Denegar
          </button>
          {req.canRemember && (
            <button className="btn" onClick={() => void answer("always")} disabled={busy}>
              {alwaysLabel(req)}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => void answer("once")} disabled={busy}>
            Permitir una vez
          </button>
        </>
      }
    >
      <div className="mcp-ask">
        <p className="mcp-ask-lead">
          <Bot size={16} /> {who} {req.title} en <strong>{req.serverName}</strong>:
        </p>
        <pre className="mcp-command">{req.command}</pre>
        {req.danger.length > 0 && (
          <div className="mcp-danger" role="alert">
            <AlertTriangle size={16} />
            <div>
              <strong>Peligroso:</strong> {req.danger.join(", ")}. Esto se pregunta siempre (salvo con «Aceptar
              automáticamente: todo»).
            </div>
          </div>
        )}
        {req.diff && (
          <>
            <div className="section-label">Cambios en el archivo</div>
            <DiffView diff={req.diff} />
          </>
        )}
        <p className="mcp-ask-hint">
          Revisa bien qué hace antes de permitirlo. Todo queda en «Actividad del asistente».
        </p>
        {!showAuto ? (
          <button className="btn btn-sm mcp-auto-open" onClick={() => setShowAuto(true)} disabled={busy}>
            <Zap size={12} /> Aceptar automáticamente en este servidor…
          </button>
        ) : (
          <>
            <div className="section-label">Aceptar automáticamente en {req.serverName}</div>
            <AutoAcceptPicker
              compact
              serverId={req.serverId}
              serverName={req.serverName}
              onApplied={(lvl) => {
                // Si el modo cubre esta petición, se permite ya; si no (peligrosa con «cambios normales»), sigue aquí.
                if (lvl === "all" || (lvl === "changes" && req.danger.length === 0)) void answer("once");
                else setShowAuto(false);
              }}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

/** Muestra la petición más antigua; las demás esperan su turno. */
export function ApprovalDialogHost() {
  const approvals = useMcp((s) => s.approvals);
  const first = approvals[0];
  if (!first) return null;
  return <Request key={first.id} req={first} total={approvals.length} />;
}
