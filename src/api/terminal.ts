import { Channel } from "@tauri-apps/api/core";
import { call } from "./core";
import type { TermOpened, TmuxList, TmuxOpen } from "./types";

export const terminal = {
  /** Abre una shell (dentro de tmux si se pide y el servidor lo tiene). `onData` recibe los bytes crudos. */
  open: (
    sessionId: string,
    cols: number,
    rows: number,
    onData: (data: Uint8Array) => void,
    tmux: TmuxOpen | null = null,
  ) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (msg) => onData(new Uint8Array(msg));
    return call<TermOpened>("term_open", { sessionId, cols, rows, tmux, onData: channel });
  },
  write: (termId: string, data: string) => call<void>("term_write", { termId, data }),
  resize: (termId: string, cols: number, rows: number) => call<void>("term_resize", { termId, cols, rows }),
  close: (termId: string) => call<void>("term_close", { termId }),
  /** Sesiones tmux de SSHorus que siguen vivas en el servidor. */
  tmuxList: (sessionId: string) => call<TmuxList>("term_tmux_list", { sessionId }),
  /** Termina sesiones tmux de SSHorus. */
  tmuxKill: (sessionId: string, names: string[]) => call<void>("term_tmux_kill", { sessionId, names }),
};
