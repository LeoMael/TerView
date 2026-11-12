// Botón del asistente en la barra de pestañas (solo con el MCP encendido): abre «Actividad del
// asistente». Un punto avisa si algo espera tu permiso o se está ejecutando.
import { Bot } from "lucide-react";
import { openActivity, useMcp } from "./store";
import "./Mcp.css";

export function McpButton() {
  const enabled = useMcp((s) => !!s.status?.enabled);
  const waiting = useMcp((s) => s.approvals.length > 0);
  const running = useMcp((s) => s.activity.some((a) => a.status === "running"));
  if (!enabled) return null;
  const hint = waiting ? " (espera tu permiso)" : running ? " (trabajando)" : "";
  return (
    <button
      className="icon-btn tabs-side-btn mcp-btn"
      title={`Actividad del asistente${hint}`}
      aria-label={`Actividad del asistente${hint}`}
      onClick={openActivity}
    >
      <Bot size={16} />
      {(waiting || running) && <span className={waiting ? "mcp-btn-dot waiting" : "mcp-btn-dot"} />}
    </button>
  );
}
