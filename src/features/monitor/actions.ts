// Acciones sobre el servidor desde el Monitor.
import { snippets } from "../../api/snippets";
import { buildKillCommand, parseKillOutput, type KillResult } from "./sample";

/** Envía TERM (o KILL con `force`) al proceso y comprueba un segundo después si sigue vivo. */
export async function killProcess(sessionId: string, pid: number, force: boolean): Promise<KillResult> {
  const r = await snippets.exec(sessionId, buildKillCommand(pid, force), 10);
  return parseKillOutput(r.stdout, r.stderr);
}
