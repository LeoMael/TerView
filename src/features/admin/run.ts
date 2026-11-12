// Ejecución de lecturas y cambios de administración en el servidor (canal exec + stdin).
import { snippets } from "../../api/snippets";
import type { ExecResult } from "../../api/types";
import {
  buildExec,
  elevationFailure,
  elevationFailureMessage,
  forgetSudo,
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
 * Si la contraseña de sudo resulta incorrecta, se olvida y se lanza `ElevationError`.
 */
export async function runScript(
  sessionId: string,
  inner: string,
  el: Elevation,
  secret = "",
  timeoutSecs = 60,
): Promise<ExecResult> {
  const req = buildExec(inner, el, secret);
  const r = await snippets.execStdin(sessionId, req.command, req.stdin, timeoutSecs);
  const f = elevationFailure(r.exitCode, r.stderr);
  if (f) {
    if (f === "bad-password" || f === "denied") forgetSudo(sessionId);
    throw new ElevationError(f);
  }
  return r;
}

export async function runPlan(sessionId: string, plan: Plan, el: Elevation): Promise<ExecResult> {
  return runScript(sessionId, innerScript(plan), el, plan.secret ?? "");
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
