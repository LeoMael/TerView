// «Actualizar imagen»: ejecución en el servidor (como el dueño de la imagen) y nuevo análisis de esa
// imagen al terminar. Los comandos y el plan salen de imageUpdate.ts (puro); aquí solo se ejecutan.
// Cada ejecución lleva su execId para poder cancelarla como el resto de comandos que van aparte.
import { errorMessage, isApiError } from "../../api/core";
import { newExecId, snippets } from "../../api/snippets";
import type { ExecResult } from "../../api/types";
import { vulnscan, type Engine, type ImageRaw, type Report, type Target, type UserCtx } from "../../api/vulnscan";
import { runScript } from "../admin/run";
import type { Elevation } from "../privileges";
import { imageKey, type Owner } from "./imageUpdate";
import { loadStoreUsers, useVulnScan } from "./run";

/** Lo que se cancela con «Cancelar». */
export class UpdateCancel {
  canceled = false;
  execId: string | null = null;
  scanId: string | null = null;

  async cancel(): Promise<void> {
    this.canceled = true;
    await Promise.allSettled([
      this.execId ? snippets.cancelExec(this.execId) : Promise.resolve(false),
      this.scanId ? vulnscan.cancel(this.scanId) : Promise.resolve(false),
    ]);
  }
}

export class UpdateCanceled extends Error {
  constructor() {
    super("Cancelado");
  }
}

/** Elevación para el dueño: el conectado sin elevar; root u otro usuario, elevando (null = falta sudo). */
export function elevationFor(owner: Owner, el: Elevation | null): Elevation | null {
  if (owner.kind === "self") return { kind: "none" };
  return el && el.kind !== "none" ? el : null;
}

/** UID y HOME del dueño (otro usuario). Usa la lista del escáner, o la lee con sudo. */
export async function ownerCtx(sessionId: string, owner: Owner, el: Elevation): Promise<UserCtx | null> {
  if (owner.kind !== "user") return null;
  const find = () => useVulnScan.getState().users[sessionId]?.users.find((u) => u.name === owner.name);
  const u = find() ?? (await loadStoreUsers(sessionId, el), find());
  if (!u) throw new Error(`No se encontró el usuario «${owner.name}» con contenedores en el servidor`);
  return { name: u.name, uid: u.uid, home: u.home };
}

/** Script completo que se envía (sin la elevación): `inner` envuelto para el dueño. */
export function ownerScript(engine: Engine, user: UserCtx | null, inner: string): Promise<string> {
  return vulnscan.script({ kind: "asOwner", engine, user, script: inner });
}

/** Ejecuta `inner` como el dueño. Lanza `UpdateCanceled` si se canceló y `ElevationError` si falla sudo. */
export async function runAsOwner(
  sessionId: string,
  engine: Engine,
  user: UserCtx | null,
  el: Elevation,
  inner: string,
  timeoutSecs: number,
  c: UpdateCancel,
): Promise<ExecResult> {
  if (c.canceled) throw new UpdateCanceled();
  const script = await ownerScript(engine, user, inner);
  const execId = newExecId();
  c.execId = execId;
  try {
    return await runScript(sessionId, script, el, "", timeoutSecs, execId);
  } catch (e) {
    if (isApiError(e, "Canceled") || c.canceled) throw new UpdateCanceled();
    throw e;
  } finally {
    c.execId = null;
  }
}

/** Una ejecución del vulnscan (listado o lectura de imagen) con el contexto del dueño. */
async function scanScript(
  sessionId: string,
  req: Parameters<typeof vulnscan.script>[0],
  el: Elevation,
  timeoutSecs: number,
  c: UpdateCancel,
): Promise<ExecResult> {
  if (c.canceled) throw new UpdateCanceled();
  const script = await vulnscan.script(req);
  const execId = newExecId();
  c.execId = execId;
  try {
    return await runScript(sessionId, script, el, "", timeoutSecs, execId);
  } catch (e) {
    if (isApiError(e, "Canceled") || c.canceled) throw new UpdateCanceled();
    throw e;
  } finally {
    c.execId = null;
  }
}

export interface RescanResult {
  report: Report;
  /** Clave de la imagen nueva en el informe (null si ya no está). */
  key: string | null;
  /** Vulnerabilidades que quedan en ella (sin las «sin importancia»). */
  remaining: number;
}

/**
 * Vuelve a analizar la imagen `tag` del dueño (su id nuevo tras el pull) y la pone en lugar de la vieja
 * en el informe. El informe nuevo queda guardado en el historial; quien llama lo pone en pantalla
 * (`useVulnScan.setReport`) cuando le convenga (al cerrar el diálogo, para que no desaparezca antes).
 */
export async function rescanImage(o: {
  sessionId: string;
  report: Report;
  target: Target;
  tag: string;
  engine: Engine;
  user: UserCtx | null;
  el: Elevation;
  useOsv: boolean;
  useTrivy: boolean;
  cancel: UpdateCancel;
  onProgress: (text: string) => void;
}): Promise<RescanResult> {
  const { sessionId, engine, user, el, cancel } = o;
  const owner = o.target.user;
  o.onProgress("Buscando la imagen nueva…");
  const listing = await scanScript(sessionId, { kind: "images", engine, user }, el, 60, cancel);
  const view = await vulnscan.parseImages(engine, listing.stdout, 1000);
  const img = view.selected.find((i) => i.tags.includes(o.tag));
  if (!img) throw new Error(view.error ?? `No se encontró la imagen «${o.tag}» en el servidor`);
  o.onProgress(`Leyendo los paquetes de ${o.tag}…`);
  const trivy = o.useTrivy && user === null && o.report.host.tools.includes("trivy");
  const r = await scanScript(sessionId, { kind: "image", engine, user, imageId: img.id, trivy }, el, trivy ? 180 : 120, cancel);
  const images: ImageRaw[] = [
    { engine, user: owner, listing: listing.stdout, imageId: "", output: null, error: null },
    {
      engine,
      user: owner,
      listing: null,
      imageId: img.id,
      output: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated },
      error: r.timedOut ? "tardó demasiado" : null,
    },
  ];
  if (cancel.canceled) throw new UpdateCanceled();
  o.onProgress(o.useOsv ? "Consultando OSV.dev…" : "Juntando resultados…");
  const scanId = newExecId();
  cancel.scanId = scanId;
  const unlisten = await vulnscan.onProgress((p) => {
    if (p.scanId === scanId) o.onProgress(p.text);
  });
  let report: Report;
  try {
    report = await vulnscan.rescanImage(o.report.serverId, o.report.id, o.target.key, images, o.useOsv, scanId);
  } catch (e) {
    if (isApiError(e, "Canceled") || cancel.canceled) throw new UpdateCanceled();
    throw new Error(errorMessage(e));
  } finally {
    unlisten();
    cancel.scanId = null;
  }
  const key = imageKey(engine, owner, img.id);
  const has = report.targets.some((t) => t.key === key);
  const remaining = report.findings.filter((f) => f.target === key && !f.unimportant).length;
  return { report, key: has ? key : null, remaining };
}
