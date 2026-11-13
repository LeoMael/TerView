// Motor simulado: responde a los comandos de Tauri (invoke) con datos falsos de ./datos.ts.
// Lo que no se conoce devuelve null y se anota en la consola con «[sim]».
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Channel } from "@tauri-apps/api/core";
import { DIRS, HOME, NGINX_CONF, COMPOSE, PHP, PROFILES, SNIPPETS, MCP_STATUS, MCP_CONFIG, MCP_ACTIVITY, MCP_CLIENT } from "./datos";
import { execOutput } from "./salidas";
import { terminalBanner } from "./terminal";

type Args = Record<string, unknown> | undefined;

const params = new URLSearchParams(location.search);
export const TEMA = (params.get("tema") ?? "dark") as "dark" | "light" | "system";

/** Tamaños de paneles: barra lateral un poco más ancha; `?sesion=40,60` cambia archivos/terminal. */
const LAYOUT: Record<string, number[]> = { main: [21, 79] };
if (params.get("sesion")) LAYOUT.session = params.get("sesion")!.split(",").map(Number);

let vaultLocked = params.get("bloqueado") === "1";
let sessionN = 0;
/** Sesión simulada → servidor (para el texto de la terminal). */
const SESSION_SERVER = new Map<string, string>();
let termN = 0;

const SERVER_BY_ID = new Map(PROFILES.servers.map((s) => [s.id, s]));

function log(...a: unknown[]) {
  console.log("[sim]", ...a);
}

function vaultStatus() {
  return { enabled: true, locked: vaultLocked, retryAfterSecs: 0, pinKind: "pin6" };
}

export function unlockVault() {
  vaultLocked = false;
  void emit("vault://state", vaultStatus());
}

/**
 * Salida de un exec. Con stdin (privileges/elevate.ts) el comando es siempre el mismo arranque corto
 * (`sh -c 'eval "$(dd …)"'`) y el script de verdad llega por stdin: las reglas se prueban primero contra
 * el stdin y luego contra comando + stdin.
 */
function exec(command: string, stdin = "") {
  const out = (stdin ? execOutput(stdin) : null) ?? execOutput(stdin ? `${command}\n${stdin}` : command);
  if (out === null) log("exec sin salida:", `${command}${stdin ? ` | ${stdin}` : ""}`.slice(0, 300).replace(/\s+/g, " "));
  return { stdout: out ?? "", stderr: "", exitCode: 0, durationMs: 180, truncated: false, timedOut: false };
}

const handlers: Record<string, (a: Args) => unknown> = {
  // App y plugins
  "plugin:app|version": () => "0.5.0",
  "plugin:app|tauri_version": () => "2.12.0",
  "plugin:app|name": () => "TerView",
  "plugin:updater|check": () => null,
  "plugin:app|bundle_type": () => "rpm",
  app_diagnostics: () => ({
    os: "linux",
    arch: "x86_64",
    osName: "Fedora Linux 44",
    kernel: "6.17.4",
    webviewVersion: "WebKitGTK 2.50",
    debugBuild: false,
    nvidiaDriver: false,
    env: [],
  }),

  // Ajustes y servidores
  settings_load: () => ({
    theme: TEMA,
    lockMinutes: 15,
    vaultPromptDismissed: true,
    layout: LAYOUT,
    ...(params.get("escena") === "ia" ? { ai: { enabled: true, baseUrl: "http://localhost:11434/v1", model: "llama3.1" } } : {}),
  }),
  settings_save: (a) => a?.settings,
  profiles_load: () => PROFILES,
  profiles_has_secret: () => true,
  profiles_sudo_password: () => null,
  ssh_config_conflicts: () => [],
  ssh_config_aliases: () => ({}),
  ssh_config_alias_info: (a) => ({ alias: String(a?.name ?? ""), suggestion: null, matches: [] }),
  snippets_load: () => SNIPPETS,

  // Bóveda
  vault_status: () => vaultStatus(),
  vault_activity: () => null,

  // SSH
  ssh_connect: (a) => {
    const p = SERVER_BY_ID.get(String(a?.profileId));
    sessionN += 1;
    SESSION_SERVER.set(`sess-${sessionN}`, p?.id ?? "");
    return {
      id: `sess-${sessionN}`,
      profileId: p?.id ?? "",
      name: p?.name ?? "servidor",
      host: p?.host ?? "",
      port: 22,
      username: p?.username ?? "",
      connectedAt: Math.floor(Date.now() / 1000),
    };
  },
  ssh_list_sessions: () => [],
  ssh_test_connection: () => ({ skipped: null, elapsedMs: 420 }),
  ssh_cancel_test: () => null,

  // Terminal
  term_open: (a) => {
    termN += 1;
    const ch = a?.onData as Channel<ArrayBuffer> | undefined;
    const srv = SERVER_BY_ID.get(SESSION_SERVER.get(String(a?.sessionId)) ?? "");
    const text = terminalBanner(termN, srv?.username ?? "deploy", srv?.name ?? "web-prod");
    if (ch) {
      setTimeout(() => {
        const bytes = new TextEncoder().encode(text);
        ch.onmessage(bytes.buffer);
      }, 150);
    }
    return { termId: `term-${termN}`, tmux: `terview-${srv?.name ?? "web-prod"}-${termN}`, tmuxMissing: false, tmuxProblem: null };
  },
  term_write: () => null,
  term_resize: () => null,
  term_tmux_list: () => ({ installed: true, version: "3.4", sessions: [] }),

  // SFTP
  sftp_home: () => HOME,
  sftp_list_dir: (a) => DIRS[String(a?.path)] ?? [],
  sftp_read_text: (a) => {
    const path = String(a?.path);
    const content = path.endsWith(".yml") ? COMPOSE : path.endsWith(".php") ? PHP : NGINX_CONF;
    return { path, content, size: content.length, modified: Math.floor(Date.now() / 1000) - 3000 };
  },

  // Transferencias, túneles
  transfer_list: () => [],
  transfer_conflicts: () => [],
  tunnels_list: () => [],
  tunnels_status: () => [],

  // Asistentes de IA (MCP)
  mcp_status: () => MCP_STATUS,
  mcp_config: () => MCP_CONFIG,
  mcp_activity: () => MCP_ACTIVITY,
  mcp_pending_approvals: () => [],
  mcp_client_config: () => MCP_CLIENT,
  mcp_get_token: () => MCP_CLIENT.token,

  // Exec
  exec_capture: (a) => exec(String(a?.command ?? "")),
  exec_capture_stdin: (a) => exec(String(a?.command ?? ""), String(a?.stdin ?? "")),
};

/** Respuestas de cada función en ./respuestas/*.ts (cada archivo exporta `respuestas`); van antes que las de arriba. */
const MAS = import.meta.glob<Record<string, (a: Args) => unknown>>("./respuestas/*.ts", { eager: true, import: "respuestas" });
export const extra: Record<string, (a: Args) => unknown> = Object.assign({}, ...Object.values(MAS));

export function installMotor() {
  mockWindows("main");
  mockIPC(
    async (cmd, args) => {
      const h = extra[cmd] ?? handlers[cmd];
      if (h) return h(args as Args);
      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) return null;
      log("sin respuesta:", cmd);
      return null;
    },
    { shouldMockEvents: true },
  );
}
