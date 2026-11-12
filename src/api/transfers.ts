import { call } from "./core";
import type { TransferDirection, TransferJob } from "./types";

/** Payload: `TransferConflict`. El destino existe y la política es "preguntar". */
export const EV_TRANSFER_CONFLICT = "transfer://conflict";
/** Payload: `string[]` (ids de trabajos cuya pregunta ya no está pendiente). */
export const EV_TRANSFER_CONFLICT_DONE = "transfer://conflict-done";

/** Pregunta pendiente de un trabajo que choca con un destino existente. Fechas en segundos Unix. */
export interface TransferConflict {
  jobId: string;
  batchId: string;
  sessionId: string;
  direction: TransferDirection;
  /** Ruta relativa dentro del lote ("fotos/a.jpg"). */
  name: string;
  /** Origen: local al subir, remoto al bajar. */
  source: string;
  /** Destino que ya existe. */
  destination: string;
  sourceSize: number | null;
  sourceMtime: number | null;
  destSize: number | null;
  destMtime: number | null;
  isLink: boolean;
}

/** Respuesta: sobrescribir / omitir / mantener ambos (renombrar) / solo si es más nuevo. */
export type ConflictAnswer = "overwrite" | "skip" | "rename" | "newer";

export const transfers = {
  /** Devuelve batchId. Acepta archivos y carpetas (recursivo). */
  upload: (sessionId: string, localPaths: string[], remoteDir: string) =>
    call<string>("transfer_upload", { sessionId, localPaths, remoteDir }),
  /** Devuelve batchId. Acepta archivos y carpetas (recursivo). */
  download: (sessionId: string, remotePaths: string[], localDir: string) =>
    call<string>("transfer_download", { sessionId, remotePaths, localDir }),
  list: () => call<TransferJob[]>("transfer_list"),
  /** ids: de trabajos o de lotes. */
  pause: (ids: string[]) => call<void>("transfer_pause", { ids }),
  resume: (ids: string[]) => call<void>("transfer_resume", { ids }),
  cancel: (ids: string[]) => call<void>("transfer_cancel", { ids }),
  retry: (ids: string[]) => call<void>("transfer_retry", { ids }),
  clearFinished: () => call<void>("transfer_clear_finished"),
  /** Preguntas de conflicto pendientes. */
  conflicts: () => call<TransferConflict[]>("transfer_conflicts"),
  /** `applyToAll`: vale para todos los conflictos de ese lote (pendientes y futuros). */
  resolveConflict: (jobId: string, answer: ConflictAnswer, applyToAll: boolean) =>
    call<void>("transfer_resolve_conflict", { jobId, answer, applyToAll }),
};
