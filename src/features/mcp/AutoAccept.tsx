// «Aceptar automáticamente» por servidor: el asistente deja de pedir permiso durante un tiempo.
// - Cambios normales: lo que hoy pide permiso y no es peligroso.
// - Todo: también lo peligroso y sudo (advertencia en rojo y confirmación).
// Duración: 15 min, 1 h o hasta cerrar TerView (solo en memoria) o «siempre» (en mcp.json).
// Nunca vale con TerView bloqueado ni en servidores sin acceso Completo (lo comprueba el motor).
import { useEffect, useState } from "react";
import { AlertTriangle, Zap } from "lucide-react";
import { mcp, type McpAutoDuration, type McpAutoLevel, type McpAutoState } from "../../api/mcp";
import { confirmDialog } from "../../components/ui/dialogs";
import { toast } from "../../stores/toasts";
import { activeAuto, useMcp } from "./store";
import "./Mcp.css";

export const AUTO_LEVELS: { v: McpAutoLevel; label: string }[] = [
  { v: "off", label: "Apagado" },
  { v: "changes", label: "Cambios normales" },
  { v: "all", label: "Todo (incluido sudo)" },
];

export const AUTO_DURATIONS: { v: McpAutoDuration; label: string }[] = [
  { v: "15m", label: "15 min" },
  { v: "1h", label: "1 hora" },
  { v: "session", label: "Hasta cerrar TerView" },
  { v: "always", label: "Siempre" },
];

/** Texto corto del estado: «Cambios normales · 12 min más». */
export function autoText(a: McpAutoState, now = Date.now()): string {
  const lvl = a.level === "all" ? "Todo, incluido sudo" : "Cambios normales";
  if (a.saved) return `${lvl} · siempre`;
  if (a.until === null) return `${lvl} · hasta cerrar TerView`;
  const min = Math.max(1, Math.ceil((a.until - now) / 60000));
  return `${lvl} · ${min} min más`;
}

/** Activa o apaga el modo (con confirmación para «Todo»). true si quedó aplicado. */
export async function setAutoAccept(
  serverId: string,
  serverName: string,
  level: McpAutoLevel,
  duration: McpAutoDuration,
): Promise<boolean> {
  if (level === "all") {
    const ok = await confirmDialog({
      title: "Aceptar TODO automáticamente",
      danger: true,
      confirmText: "Activar",
      message: (
        <div className="mcp-danger" role="alert">
          <AlertTriangle size={16} />
          <div>
            El asistente podrá ejecutar <strong>sin preguntarte</strong> comandos peligrosos (rm -rf, prune, reboot…) y
            con <strong>sudo</strong> en «{serverName}». TerView pondrá la contraseña de sudo si la tiene. Úsalo solo si
            confías en lo que está haciendo.
          </div>
        </div>
      ),
    });
    if (!ok) return false;
  }
  try {
    useMcp.setState({ auto: await mcp.setAuto(serverId, level, duration) });
    if (level === "off") toast.info("Aceptar automáticamente apagado", serverName);
    else toast.success("Aceptar automáticamente activado", serverName);
    return true;
  } catch (e) {
    toast.error("No se pudo cambiar «Aceptar automáticamente»", e);
    return false;
  }
}

/** Apaga el modo automático en todos los servidores. */
export async function autoOffAll() {
  try {
    useMcp.setState({ auto: await mcp.autoOffAll() });
    toast.info("Aceptar automáticamente apagado", "El asistente vuelve a pedir permiso.");
  } catch (e) {
    toast.error("No se pudo apagar «Aceptar automáticamente»", e);
  }
}

/** Reloj de un minuto para refrescar los «N min más» (y ocultar lo caducado). */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 20000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** Modo automático vigente de un servidor (o undefined). */
export function useAutoOf(serverId: string): McpAutoState | undefined {
  const now = useMinuteClock();
  return useMcp((s) => activeAuto(s.auto, now).find((a) => a.serverId === serverId));
}

/** Selector de nivel + duración (Ajustes y diálogo de permiso). `onApplied` tras activarlo. */
export function AutoAcceptPicker({
  serverId,
  serverName,
  onApplied,
  compact,
}: {
  serverId: string;
  serverName: string;
  onApplied?: (level: McpAutoLevel) => void;
  compact?: boolean;
}) {
  const current = useAutoOf(serverId);
  const [level, setLevel] = useState<McpAutoLevel>(current?.level ?? "changes");
  const [duration, setDuration] = useState<McpAutoDuration>(current?.saved ? "always" : "1h");
  const [busy, setBusy] = useState(false);

  const apply = async (lvl: McpAutoLevel) => {
    setBusy(true);
    const ok = await setAutoAccept(serverId, serverName, lvl, duration);
    setBusy(false);
    if (ok) onApplied?.(lvl);
  };

  return (
    <div className={compact ? "mcp-auto mcp-auto-compact" : "mcp-auto"}>
      <div className="mcp-auto-row">
        <span className="mcp-auto-label">Qué:</span>
        <div className="st-segmented" role="radiogroup" aria-label={`Aceptar automáticamente en ${serverName}`}>
          {AUTO_LEVELS.filter((o) => o.v !== "off").map((o) => (
            <button
              key={o.v}
              role="radio"
              aria-checked={level === o.v}
              className={level === o.v ? `active mcp-auto-${o.v}` : ""}
              onClick={() => setLevel(o.v)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mcp-auto-row">
        <span className="mcp-auto-label">Durante:</span>
        <div className="st-segmented" role="radiogroup" aria-label="Duración">
          {AUTO_DURATIONS.map((o) => (
            <button key={o.v} role="radio" aria-checked={duration === o.v} className={duration === o.v ? "active" : ""} onClick={() => setDuration(o.v)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {level === "all" && (
        <div className="mcp-danger" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>Peligroso:</strong> también se aceptarán solos sudo, rm -rf, prune, reboot… Se pide confirmación.
          </div>
        </div>
      )}
      <div className="mcp-auto-row">
        <button className={level === "all" ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"} disabled={busy} onClick={() => void apply(level)}>
          <Zap size={12} /> {current ? "Cambiar" : "Activar"}
        </button>
        {current && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void apply("off")}>
            Apagar
          </button>
        )}
      </div>
    </div>
  );
}
