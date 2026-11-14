// Ejecuta una auditoría: el script propio, Puertos y Sitios web (los de Administración) con la elevación
// disponible, y el último informe del escáner. No instala ni cambia nada. Guarda el informe en el historial.
import { create } from "zustand";
import { audit, type AuditReport } from "../../api/audit";
import { vulnscan } from "../../api/vulnscan";
import { parsePorts, parseWeb, readElevated, PORTS_SCRIPT, WEB_SCRIPT, type ElevationError, type PortsResult, type WebResult } from "../admin";
import { refreshPrivilege, sudoRejected, type Elevation } from "../privileges";
import { runChecks } from "./checks";
import { AUDIT_SCRIPT } from "./script";
import { scoreChecks } from "./score";

interface AuditRunState {
  /** Paso en curso por sesión (no está = no se audita). */
  running: Record<string, string>;
  set: (sessionId: string, step: string | null) => void;
}

export const useAuditRun = create<AuditRunState>((set) => ({
  running: {},
  set: (sessionId, step) =>
    set((s) => {
      const running = { ...s.running };
      if (step === null) delete running[sessionId];
      else running[sessionId] = step;
      return { running };
    }),
}));

function onElevationError(sessionId: string, e: ElevationError | null) {
  if (e?.failure === "need-password") refreshPrivilege(sessionId);
  if (e?.failure === "bad-password") sudoRejected(sessionId);
}

export interface AuditOptions {
  sessionId: string;
  /** Id del servidor guardado (historial). */
  profileId: string;
  /** null = sin sudo. */
  elevation: Elevation | null;
  onStep?: (text: string) => void;
}

export async function runAudit(o: AuditOptions): Promise<AuditReport> {
  const started = Date.now();
  const step = (t: string) => {
    useAuditRun.getState().set(o.sessionId, t);
    o.onStep?.(t);
  };
  try {
    step("Revisando SSH, usuarios y el sistema…");
    const main = await readElevated(o.sessionId, AUDIT_SCRIPT, o.elevation, 180);
    onElevationError(o.sessionId, main.elevationError);
    // Si sudo falló, el resto se lee sin elevar (no se vuelve a probar la contraseña).
    const el = main.elevated ? o.elevation : null;
    step("Revisando puertos…");
    let ports: PortsResult | null = null;
    try {
      ports = parsePorts((await readElevated(o.sessionId, PORTS_SCRIPT, el, 30)).result.stdout);
    } catch {
      ports = null;
    }
    step("Revisando sitios web…");
    let web: WebResult | null = null;
    try {
      web = parseWeb((await readElevated(o.sessionId, WEB_SCRIPT, el, 60)).result.stdout);
    } catch {
      web = null;
    }
    const last = await vulnscan.latest(o.profileId).catch(() => null);
    const now = Date.now();
    const { checks, os } = runChecks({
      stdout: main.result.stdout,
      elevated: main.elevated,
      ports,
      web,
      vuln: last ? { createdAt: last.createdAt, summary: last.summary } : null,
      now,
    });
    const s = scoreChecks(checks);
    const report: AuditReport = {
      id: `aud-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      serverId: o.profileId,
      createdAt: new Date(now).toISOString(),
      durationMs: now - started,
      elevated: main.elevated,
      os,
      score: s.score,
      grade: s.grade,
      summary: s.summary,
      categories: s.categories,
      checks,
      ai: null,
    };
    step("Guardando…");
    return await audit.save(report);
  } finally {
    useAuditRun.getState().set(o.sessionId, null);
  }
}
