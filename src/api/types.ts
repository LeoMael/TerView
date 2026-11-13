// Tipos compartidos con el motor. ESPEJO EXACTO de `src-tauri/src/types.rs`.
// Si cambias uno, cambia el otro.

// ───────── Eventos globales (listen) ─────────
export const EV_TRANSFER_UPDATE = "transfer://update"; // payload: TransferJob[] (solo los que cambiaron)
export const EV_TRANSFER_REMOVED = "transfer://removed"; // payload: string[] (ids)
export const EV_TERMINAL_EXIT = "terminal://exit"; // payload: TerminalExit
export const EV_SESSION_CLOSED = "session://closed"; // payload: SessionClosed
export const EV_SESSION_RECONNECTING = "session://reconnecting"; // payload: SessionReconnecting
export const EV_SESSION_RECONNECTED = "session://reconnected"; // payload: SessionInfo (mismo id)

// ───────── Servidores y proyectos ─────────
export type AuthMethod = "password" | "key" | "agent";

export interface ServerProfile {
  /** "" al crear; el motor asigna uno. */
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
  defaultPath: string | null;
  color: string | null;
  /** Terminales persistentes (tmux) de este servidor. null/ausente = usar el ajuste general. */
  tmux?: TmuxMode | null;
  /** De dónde sale la contraseña de sudo. Ausente = «ask». */
  sudoMode?: SudoMode;
}

/** Contraseña de sudo: pedirla cada vez, usar la de la conexión o usar una guardada aparte. */
export type SudoMode = "ask" | "login" | "saved";

/** Cuándo abrir las terminales dentro de tmux: «auto» si está instalado, «always» (avisa si falta) o «never». */
export type TmuxMode = "auto" | "always" | "never";

export interface Bookmark {
  serverId: string;
  path: string;
  label: string | null;
}

export interface Project {
  /** "" al crear; el motor asigna uno. */
  id: string;
  name: string;
  serverIds: string[];
  bookmarks: Bookmark[];
  color: string | null;
}

export interface ProfilesData {
  servers: ServerProfile[];
  projects: Project[];
}

export interface Settings {
  /** Apariencia (lista en src/styles/themes.ts); "system" sigue el modo claro u oscuro del equipo. */
  theme: import("../styles/themes").ThemeId;
  /** Color de acento elegido ("" = el de la apariencia). */
  accent: import("../styles/themes").AccentId;
  /** Tamaño de letra de la interfaz en px (13 por defecto). */
  uiFontSize: number;
  terminalFontSize: number;
  terminalFontFamily: string;
  transferConcurrency: number;
  showHiddenFiles: boolean;
  confirmDelete: boolean;
  editorMaxBytes: number;
  /** Tamaños de paneles guardados (porcentajes). Clave libre, p. ej. "session", "main". */
  layout: Record<string, number[]>;
  /** Señal de vida SSH en segundos (5..120); caída detectada tras ~3 intervalos. */
  keepaliveSecs: number;
  autoReconnect: boolean;
  /** 1..20 */
  reconnectAttempts: number;
  editorFontSize: number;
  editorFontFamily: string;
  /** Mantener ~/.ssh/config sincronizado. */
  sshConfigSync: boolean;
  /** Si el destino existe al transferir. */
  transferConflict: "overwrite" | "skip" | "newer" | "ask";
  /** Terminales persistentes (tmux) por defecto. */
  terminalTmux: TmuxMode;
  /** Bloquear tras estos minutos sin uso (0 = nunca). Solo con PIN: 5/10/15/30/60. */
  lockMinutes: number;
  /** Se dijo «Ahora no» a crear el PIN: no volver a preguntar al iniciar. */
  vaultPromptDismissed: boolean;
  /** Escáner de vulnerabilidades. */
  vulnscan: import("./vulnscan").VulnScanSettings;
  /** IA opcional para explicar informes del escáner (el token no va aquí). */
  ai: import("./vulnscan").AiSettings;
  /** Terminal local y asistentes (Claude Code, Codex): qué contexto se les da y cómo. */
  localAi: LocalAiSettings;
  /** Atajos de teclado cambiados por el usuario: id de acción → combinación ("" = sin atajo).
   *  Solo se guardan los distintos de los de por defecto (lista en src/features/shortcuts/keys.ts). */
  shortcuts: Record<string, string>;
}

/** Cómo trabaja el asistente con los servidores: ssh directo, el MCP de TerView o las dos. */
export type LocalAiMode = "both" | "direct" | "mcp";

export interface LocalAiSettings {
  mode: LocalAiMode;
  includeServers: boolean;
  /** Host y puerto de cada servidor. */
  includeHosts: boolean;
  includeProjects: boolean;
  /** La pestaña que se estaba mirando al abrir el asistente. */
  includeActive: boolean;
  includeDate: boolean;
  /** Última carpeta elegida para las terminales locales (null = carpeta personal). */
  lastCwd: string | null;
}

// ───────── SSH ─────────
export interface HostKeyInfo {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  keyOpenssh: string;
}

export interface SessionInfo {
  id: string;
  profileId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  connectedAt: number;
}

export interface SessionReconnecting {
  sessionId: string;
  attempt: number;
  maxAttempts: number;
  nextRetrySecs: number;
  reason: string;
  /** Espera a que se desbloquee TerView para usar la contraseña guardada. */
  waitingUnlock: boolean;
}

export interface SessionClosed {
  sessionId: string;
  reason: string;
}

// ───────── Terminal ─────────
export interface TerminalExit {
  termId: string;
  code: number | null;
}

/** Abrir la terminal dentro de una sesión tmux (parámetro de `term_open`). */
export interface TmuxOpen {
  /** Nombre estable (`terview-…`). Si ya existe, se engancha a ella. */
  name: string;
  /** Volcar el historial de la sesión antes de engancharse (terminal recién creada). */
  replay: boolean;
}

export interface TermOpened {
  termId: string;
  /** Nombre de la sesión tmux si la terminal es persistente; null = shell normal. */
  tmux: string | null;
  /** Se pidió tmux pero no está instalado. */
  tmuxMissing: boolean;
  /** Se pidió tmux y no se pudo usar: motivo. */
  tmuxProblem: string | null;
}

/** Sesión tmux de TerView viva en el servidor. */
export interface TmuxSession {
  name: string;
  /** Segundos desde epoch. */
  created: number | null;
  activity: number | null;
  /** Clientes enganchados ahora (0 = nadie la mira). */
  attached: number;
  windows: number;
  /** Programa en primer plano. */
  command: string;
  path: string;
}

export interface TmuxList {
  installed: boolean;
  version: string | null;
  sessions: TmuxSession[];
}

// ───────── SFTP ─────────
export type FileKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  isDirLink: boolean;
  size: number;
  /** Unix segundos */
  modified: number | null;
  permissions: number | null;
  permissionsStr: string;
  uid: number | null;
  gid: number | null;
}

export interface RemoteText {
  path: string;
  content: string;
  size: number;
  modified: number | null;
}

// ───────── Transferencias ─────────
export type TransferDirection = "upload" | "download";
export type TransferStatus = "queued" | "running" | "paused" | "done" | "skipped" | "error" | "canceled";

export interface TransferJob {
  id: string;
  batchId: string;
  sessionId: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  name: string;
  size: number;
  transferred: number;
  status: TransferStatus;
  error: string | null;
  /** bytes/s */
  speed: number;
  createdAt: number;
  finishedAt: number | null;
}

// ───────── ~/.ssh/config ─────────
export interface SshConfigExport {
  path: string;
  count: number;
}

// ───────── Biblioteca de comandos ─────────
export type SnippetScope = "global" | "project" | "server";

export interface Snippet {
  /** "" al crear */
  id: string;
  name: string;
  description: string | null;
  /** Plantilla con {{variable}} o {{variable:defecto}} */
  command: string;
  category: string;
  scope: SnippetScope;
  scopeId: string | null;
  dangerous: boolean;
  sudo: boolean;
  readOnly: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

// ───────── Errores ─────────
export type ApiErrorKind =
  | "NotFound"
  | "SessionNotFound"
  | "Network"
  | "AuthFailed"
  | "NeedsPassword"
  | "NeedsPassphrase"
  | "NeedsOtp"
  | "HostKeyUnknown"
  | "HostKeyChanged"
  | "Ssh"
  | "Sftp"
  | "Io"
  | "FileTooLarge"
  | "Keyring"
  | "Invalid"
  | "Canceled"
  | "Locked"
  | "NotImplemented"
  | "Unknown";

export interface ApiErrorPayload {
  kind: ApiErrorKind;
  message: string;
  hostKey: HostKeyInfo | null;
}
