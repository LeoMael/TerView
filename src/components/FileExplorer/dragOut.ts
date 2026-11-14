// Arrastrar del explorador remoto al escritorio o al gestor de archivos del sistema.
// DUEÑO: agente SFTP/Explorador.
//
// 1. Lo seleccionado se descarga a una carpeta nueva de la caché con el motor de transferencias
//    (se ve en el panel; se puede pausar o cancelar).
// 2. Con todo descargado, el motor empieza un arrastre nativo de esos archivos (`dragOut.start`).
//    Si el botón sigue apretado se arrastra en ese momento; si no, queda "listo" y el siguiente
//    arrastre de lo mismo es inmediato (mientras no cambie en el servidor).
//
// Arrastre propio vs. externo: mientras dura el arrastre nativo, la ventana de SSHorus también
// recibe los eventos de "soltar archivos" (con las rutas de la caché). El explorador los ignora
// con `ownDragActive()` / `isOwnDragPaths()` para no volver a subirlos al servidor.
import { dragOut } from "../../api/dragout";
import { transfers } from "../../api/transfers";
import type { FileEntry } from "../../api/types";
import { isWindows } from "../../lib/platform";
import { isActiveStatus, useTransfers } from "../../stores/transfers";
import { rootPaths } from "./revealDownload";

/** Por encima de esto (suma de archivos) se pregunta antes de preparar el arrastre. */
export const BIG_DRAG_BYTES = 1024 ** 3;

/** Error de "se canceló la preparación" (no se avisa con un mensaje de error). */
export class DragOutCanceled extends Error {
  constructor() {
    super("Cancelado");
    this.name = "DragOutCanceled";
  }
}

interface Prepared {
  size: number;
  modified: number | null;
  localPath: string;
}

/** Lo ya descargado a la caché, por sesión + ruta remota. */
const prepared = new Map<string, Prepared>();
let cacheRoot: string | null = null;
let nativeActive = false;

const keyOf = (sessionId: string, path: string) => `${sessionId}\n${path}`;

function normLocal(p: string): string {
  const s = p.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return isWindows ? s.toLowerCase() : s;
}

/** ¿Hay un arrastre nativo de SSHorus en marcha? */
export function ownDragActive(): boolean {
  return nativeActive;
}

/** ¿Todas las rutas están en la caché de arrastre? (= el arrastre salió de SSHorus). */
export function isOwnDragPaths(paths: string[]): boolean {
  if (!cacheRoot || !paths.length) return false;
  const root = `${normLocal(cacheRoot)}/`;
  return paths.every((p) => normLocal(p).startsWith(root));
}

/** Rutas locales si TODO lo pedido ya está preparado y no cambió en el servidor; si no, null. */
export function readyPaths(sessionId: string, entries: FileEntry[]): string[] | null {
  const out: string[] = [];
  for (const e of entries) {
    const p = prepared.get(keyOf(sessionId, e.path));
    if (!p || p.size !== e.size || p.modified !== e.modified) return null;
    out.push(p.localPath);
  }
  return out;
}

/** Olvida lo preparado (p. ej. si se borró de la caché). */
export function forgetPrepared(sessionId: string, entries: FileEntry[]) {
  for (const e of entries) prepared.delete(keyOf(sessionId, e.path));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera a que el lote termine del todo. Pausado = sigue esperando (se puede reanudar). */
async function waitBatch(batchId: string): Promise<void> {
  let seen = false;
  for (;;) {
    await sleep(250);
    const b = useTransfers.getState().batches[batchId];
    if (b) seen = true;
    else if (seen) throw new DragOutCanceled(); // se quitó de la lista
    if (b && (isActiveStatus(b.status) || b.status === "paused")) continue;
    if (!(await transfers.batchFinished(batchId))) continue;
    // El motor dice que terminó; los eventos de progreso llegan cada ~200 ms.
    const last = useTransfers.getState().batches[batchId];
    if (last && (isActiveStatus(last.status) || last.status === "paused")) continue;
    if (!last) return; // sin trabajos: carpetas vacías
    if (last.status === "done") return;
    if (last.status === "canceled") throw new DragOutCanceled();
    throw new Error(last.firstError ?? "Algunos archivos no se pudieron descargar");
  }
}

/**
 * Descarga `entries` a una carpeta nueva de la caché (con el motor de transferencias) y
 * devuelve las rutas locales, en el mismo orden. `onBatch` recibe el id del lote en cuanto existe.
 */
export async function prepareDragOut(
  sessionId: string,
  entries: FileEntry[],
  onBatch?: (batchId: string) => void,
): Promise<string[]> {
  const { root, dir } = await dragOut.dir();
  cacheRoot = root;
  const batchId = await transfers.download(
    sessionId,
    entries.map((e) => e.path),
    dir,
  );
  onBatch?.(batchId);
  await waitBatch(batchId);
  const paths = rootPaths(batchId, dir, entries);
  entries.forEach((e, i) => {
    prepared.set(keyOf(sessionId, e.path), { size: e.size, modified: e.modified, localPath: paths[i] });
  });
  return paths;
}

/** Arrastre nativo (hay que llamarlo con el botón apretado). `true` si se soltó en algún sitio. */
export async function startDragOut(paths: string[]): Promise<boolean> {
  nativeActive = true;
  try {
    return await dragOut.start(paths);
  } finally {
    nativeActive = false;
  }
}
