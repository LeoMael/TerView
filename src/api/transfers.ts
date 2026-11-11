import { call } from "./core";
import type { TransferJob } from "./types";

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
};
