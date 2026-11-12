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
}

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
  theme: "dark" | "light" | "system";
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
  | "NotImplemented"
  | "Unknown";

export interface ApiErrorPayload {
  kind: ApiErrorKind;
  message: string;
  hostKey: HostKeyInfo | null;
}
