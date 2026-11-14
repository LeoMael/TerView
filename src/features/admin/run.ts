// Ejecución de lecturas y cambios de administración en el servidor (canal exec + stdin).
import { snippets } from "../../api/snippets";
import type { ExecResult } from "../../api/types";
import {
  buildExec,
  elevationFailure,
  elevationFailureMessage,
  forgetSudo,
  sudoRejected,
  type Elevation,
  type ElevationFailure,
} from "../privileges";
import { innerScript, readKeysScript, type Plan } from "./commands";
import { parseRead, parseShadowOutput, splitSections, READ_SCRIPT, SHADOW_SCRIPT, type ReadResult, type ShadowEntry } from "./parse";

/** Error de elevación (contraseña de sudo incorrecta, sudo denegado…). */
export class ElevationError extends Error {
  failure: ElevationFailure;
  constructor(failure: ElevationFailure) {
    super(elevationFailureMessage(failure));
    this.name = "ElevationError";
    this.failure = failure;
  }
}

/**
 * Ejecuta `inner` con la elevación indicada. `secret` va al stdin del script interior.
 * Si la contraseña de sudo resulta incorrecta, se olvida (`sudoRejected`) y se lanza `ElevationError`.
 * `execId` (opcional, `newExecId()`) permite cancelarlo con `snippets.cancelExec`: se detiene también
 * en el servidor y la promesa falla con el error `Canceled`.
 */
export async function runScript(
  sessionId: string,
  inner: string,
  el: Elevation,
  secret = "",
  timeoutSecs = 60,
  execId?: string,
): Promise<ExecResult> {
  const req = buildExec(inner, el, secret);
  const r = await snippets.execStdin(sessionId, req.command, req.stdin, timeoutSecs, execId);
  const f = elevationFailure(r.exitCode, r.stderr);
  if (f) {
    // Contraseña incorrecta: se olvida la de memoria y, si era la guardada (o la de la conexión), queda
    // «failed» para que el panel muestre el aviso y no se vuelva a probar sola (cada intento cuenta para sudo).
    if (f === "bad-password") sudoRejected(sessionId);
    else if (f === "denied") forgetSudo(sessionId);
    throw new ElevationError(f);
  }
  return r;
}

export async function runPlan(sessionId: string, plan: Plan, el: Elevation): Promise<ExecResult> {
  return runScript(sessionId, innerScript(plan), el, plan.secret ?? "", plan.timeoutSecs ?? 60);
}

/** true si el comando salió bien. */
export function succeeded(r: ExecResult): boolean {
  return r.exitCode === 0 && !r.timedOut;
}

/** Texto de error legible a partir del resultado. */
export function failureText(r: ExecResult): string {
  if (r.timedOut) return "El comando tardó demasiado y se canceló";
  const err = r.stderr.trim();
  if (err) return err;
  return `El comando terminó con código ${r.exitCode ?? "desconocido"}`;
}

/** Lectura como usuario normal: usuarios, grupos, shells, sesiones, herramientas. */
export async function readServer(sessionId: string): Promise<ReadResult> {
  const r = await runScript(sessionId, READ_SCRIPT, { kind: "none" }, "", 20);
  return parseRead(r.stdout);
}

/** Estado de contraseñas (bloqueos, caducidad) desde /etc/shadow, como root. */
export async function readShadow(sessionId: string, el: Elevation): Promise<Map<string, ShadowEntry>> {
  const r = await runScript(sessionId, SHADOW_SCRIPT, el, "", 20);
  if (!succeeded(r)) throw new Error(failureText(r));
  return parseShadowOutput(r.stdout);
}

/** Líneas de ~usuario/.ssh/authorized_keys (sin vacías). */
export async function readKeys(sessionId: string, user: string, el: Elevation): Promise<string[]> {
  const r = await runScript(sessionId, readKeysScript(user), el, "", 20);
  if (!succeeded(r)) throw new Error(failureText(r));
  const s = splitSections(r.stdout);
  if (!s.has("end")) throw new Error("No se pudo leer authorized_keys");
  return (s.get("keys") ?? []).filter((l) => l.trim() !== "");
}

export interface ElevatedRead {
  result: ExecResult;
  /** Se leyó como root (se ve todo). */
  elevated: boolean;
  /** Si se intentó elevar y falló (contraseña de sudo incorrecta…), el motivo. */
  elevationError: ElevationError | null;
}

/**
 * Lectura con la elevación disponible (null = sin elevar). Si sudo falla, se repite como usuario normal
 * para mostrar al menos lo que se pueda ver. Exige que la salida termine en «@@end».
 */
export async function readElevated(
  sessionId: string,
  script: string,
  el: Elevation | null,
  timeoutSecs = 30,
): Promise<ElevatedRead> {
  let elevationError: ElevationError | null = null;
  let r: ExecResult | null = null;
  if (el && el.kind !== "none") {
    try {
      r = await runScript(sessionId, script, el, "", timeoutSecs);
    } catch (e) {
      if (!(e instanceof ElevationError)) throw e;
      elevationError = e;
    }
  }
  const elevated = r !== null;
  if (!r) r = await runScript(sessionId, script, { kind: "none" }, "", timeoutSecs);
  if (!splitSections(r.stdout).has("end")) throw new Error(failureText(r));
  return { result: r, elevated, elevationError };
}
