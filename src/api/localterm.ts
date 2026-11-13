// Terminal local (del propio equipo) y asistentes de IA (motor: src-tauri/src/localterm/).
import { Channel } from "@tauri-apps/api/core";
import { call } from "./core";

export type AiTool = "claude" | "codex";

export interface LocalTermInfo {
  home: string;
  /** Shell que se abre por defecto. */
  shell: string;
  os: "linux" | "mac" | "windows";
}

export interface AiToolInfo {
  tool: AiTool;
  label: string;
  installed: boolean;
  path: string | null;
  /** Comando oficial de instalación para este sistema. */
  installCommand: string;
  /** Hace falta Node.js (npm) para instalarlo. */
  needsNode: boolean;
  npmFound: boolean;
}

export interface AiLaunch {
  tool: AiTool;
  /** Contexto de TerView (sin secretos). */
  context: string | null;
  /** Configurar el MCP de TerView. */
  mcp: boolean;
}

export interface LocalOpened {
  termId: string;
  cwd: string;
  program: string;
  /** Se abrió con el MCP de TerView. */
  mcp: boolean;
  /** Algo no salió como se pidió (p. ej. MCP apagado: solo contexto). */
  warning: string | null;
}

export interface ExportedAlias {
  serverId: string;
  alias: string;
}

export const localTerm = {
  info: () => call<LocalTermInfo>("local_term_info"),
  /** Abre la shell del sistema o, con `launch`, Claude Code / Codex. `onData` recibe los bytes crudos. */
  open: (
    opts: { cwd: string | null; cols: number; rows: number; launch: AiLaunch | null },
    onData: (data: Uint8Array) => void,
  ) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (msg) => onData(new Uint8Array(msg));
    return call<LocalOpened>("local_term_open", { opts, onData: channel });
  },
  write: (termId: string, data: string) => call<void>("local_term_write", { termId, data }),
  resize: (termId: string, cols: number, rows: number) => call<void>("local_term_resize", { termId, cols, rows }),
  /** Termina el programa y todo lo que lanzó. */
  close: (termId: string) => call<void>("local_term_close", { termId }),
  /** ¿Están instalados Claude Code y Codex? */
  detect: () => call<AiToolInfo[]>("local_ai_detect"),
  /** Alias de ~/.ssh/config exportados por TerView que llevan de verdad a cada servidor. */
  sshAliases: () => call<ExportedAlias[]>("local_ai_ssh_aliases"),
};
