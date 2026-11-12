// "Descargar y abrir carpeta": cuando termina el lote, muestra lo descargado en el gestor de
// archivos del sistema (tauri-plugin-opener → revealItemInDir; permitido por `opener:default`).
// DUEÑO: agente SFTP/Explorador.
import { downloadDir } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { FileEntry } from "../../api/types";
import { isWindows } from "../../lib/platform";
import { batchJobIds, isActiveStatus, useTransfers } from "../../stores/transfers";
import { toast } from "../../stores/toasts";

/** Carpeta "Descargas" del sistema (null si no se puede saber). */
export async function systemDownloadDir(): Promise<string | null> {
  try {
    const d = await downloadDir();
    return d || null;
  } catch {
    return null;
  }
}

function joinLocal(dir: string, name: string): string {
  const sep = isWindows || (dir.includes("\\") && !dir.includes("/")) ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Rutas locales de los elementos raíz del lote (usa la del motor si ya la conoce:
 *  puede cambiar por "mantener ambos" o por nombres no válidos en Windows). */
export function rootPaths(batchId: string, dir: string, entries: FileEntry[]): string[] {
  const jobs = useTransfers.getState().jobs;
  const byName = new Map<string, string>();
  for (const id of batchJobIds(batchId)) {
    const j = jobs[id];
    if (j && j.status === "done" && !j.name.includes("/")) byName.set(j.name, j.localPath);
  }
  const out: string[] = [];
  for (const e of entries) {
    const known = byName.get(e.name);
    if (known) {
      out.push(known);
      continue;
    }
    // Renombrado ("a (2).txt"): busca un trabajo hecho del mismo origen.
    let found: string | undefined;
    for (const id of batchJobIds(batchId)) {
      const j = jobs[id];
      if (j && j.status === "done" && j.remotePath === e.path) {
        found = j.localPath;
        break;
      }
    }
    out.push(found ?? joinLocal(dir, e.name));
  }
  return out;
}

/** Espera a que el lote termine y abre el gestor de archivos con lo descargado seleccionado. */
export function revealWhenDone(batchId: string, dir: string, entries: FileEntry[]) {
  let seen = false;
  let finished = false;
  const check = () => {
    if (finished) return;
    const b = useTransfers.getState().batches[batchId];
    if (!b) {
      // Aún no llegó el primer evento del lote, o se quitó de la lista.
      if (seen) stop();
      return;
    }
    seen = true;
    if (isActiveStatus(b.status) || b.status === "paused") return;
    stop();
    if (b.done === 0) return; // cancelado, omitido u error: no hay nada nuevo que mostrar
    const paths = rootPaths(batchId, dir, entries);
    revealItemInDir(paths).catch((err) => {
      toast.error("No se pudo abrir la carpeta", err);
    });
  };
  const unsub = useTransfers.subscribe(check);
  function stop() {
    finished = true;
    unsub();
  }
  check();
}
