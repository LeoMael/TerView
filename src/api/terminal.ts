import { Channel } from "@tauri-apps/api/core";
import { call } from "./core";

export const terminal = {
  /** Abre una shell. `onData` recibe los bytes crudos del servidor. Devuelve termId. */
  open: (sessionId: string, cols: number, rows: number, onData: (data: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (msg) => onData(new Uint8Array(msg));
    return call<string>("term_open", { sessionId, cols, rows, onData: channel });
  },
  write: (termId: string, data: string) => call<void>("term_write", { termId, data }),
  resize: (termId: string, cols: number, rows: number) => call<void>("term_resize", { termId, cols, rows }),
  close: (termId: string) => call<void>("term_close", { termId }),
};
