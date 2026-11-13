// Servidor MCP para asistentes de IA (motor: src-tauri/src/mcp/).
import { call } from "./core";

/** Payload: `ApprovalRequest`. El asistente pide permiso para algo. */
export const EV_MCP_APPROVAL = "mcp://approval";
/** Payload: id. La petición ya no está pendiente (respondida o vencida). */
export const EV_MCP_APPROVAL_DONE = "mcp://approval-done";
/** Payload: `AuditEntry`. Una acción del asistente empezó, cambió o terminó. */
export const EV_MCP_ACTIVITY = "mcp://activity";
/** Payload: `McpStatus`. */
export const EV_MCP_STATUS = "mcp://status";
/** Payload: `McpAutoState[]`. Cambió «Aceptar automáticamente» de algún servidor. */
export const EV_MCP_AUTO = "mcp://auto";
/** Payload: `McpUiRequest`. El motor pide algo a la interfaz. */
export const EV_MCP_UI_REQUEST = "mcp://ui-request";

/** Acceso del asistente a un servidor. */
export type McpAccess = "none" | "read" | "full";

export interface McpConfig {
  enabled: boolean;
  port: number;
  approvalTimeoutSecs: number;
  /** id de servidor → acceso (lo que falta = "none"). */
  access: Record<string, McpAccess>;
  /** id de servidor → acciones con «Permitir siempre». */
  remembered: Record<string, string[]>;
  /** id de servidor → «Aceptar automáticamente» guardado («siempre»). */
  autoAccept: Record<string, McpAutoLevel>;
}

/** «Aceptar automáticamente»: apagado, cambios normales o todo (también lo peligroso y sudo). */
export type McpAutoLevel = "off" | "changes" | "all";
/** Cuánto dura: lo temporal vive solo en memoria; «always» se guarda en mcp.json. */
export type McpAutoDuration = "15m" | "1h" | "session" | "always";

export interface McpAutoState {
  serverId: string;
  serverName: string;
  level: McpAutoLevel;
  /** Unix ms en que se apaga; null = hasta cerrar TerView o guardado (`saved`). */
  until: number | null;
  saved: boolean;
}

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string;
  error: string | null;
  approvalTimeoutSecs: number;
  bridgePath: string;
  bridgeFound: boolean;
  appImage: boolean;
  auditPath: string | null;
}

export interface McpClientConfig {
  claudeCodeStdio: string;
  claudeCodeHttp: string;
  claudeDesktopJson: string;
  url: string;
  token: string;
}

export interface McpApprovalRequest {
  id: string;
  serverId: string;
  serverName: string;
  tool: string;
  title: string;
  command: string;
  diff: string | null;
  danger: string[];
  canRemember: boolean;
  timeoutSecs: number;
  /** Unix ms en que se deniega solo. */
  expiresAt: number;
  client: string | null;
}

export type McpDecision = "once" | "always" | "deny";

export type AuditStatus = "running" | "ok" | "error" | "denied" | "locked";

export interface AuditEntry {
  id: string;
  /** Unix ms. */
  at: number;
  tool: string;
  serverId: string | null;
  serverName: string | null;
  detail: string;
  status: AuditStatus;
  approvedBy: string | null;
  message: string | null;
  durationMs: number | null;
  client: string | null;
  execId?: string | null;
  /** La aceptó el modo «Aceptar automáticamente». */
  auto?: boolean;
  /** Aceptada automáticamente aunque era peligrosa o con sudo. */
  autoDanger?: boolean;
}

export interface McpUiRequest {
  id: string;
  kind: "connect" | "catalog" | "ports" | "sites" | "containers" | "sudo" | "sudo-rejected" | string;
  payload: Record<string, unknown>;
}

export const mcp = {
  status: () => call<McpStatus>("mcp_status"),
  setEnabled: (enabled: boolean) => call<McpStatus>("mcp_set_enabled", { enabled }),
  setPort: (port: number) => call<McpStatus>("mcp_set_port", { port }),
  setApprovalTimeout: (secs: number) => call<McpConfig>("mcp_set_approval_timeout", { secs }),
  config: () => call<McpConfig>("mcp_config"),
  setAccess: (serverId: string, access: McpAccess) => call<McpConfig>("mcp_set_access", { serverId, access }),
  /** Borra una regla «Permitir siempre» (o todas las del servidor si `key` es null). */
  forgetRule: (serverId: string, key: string | null) => call<McpConfig>("mcp_forget_rule", { serverId, key }),
  getToken: () => call<string>("mcp_get_token"),
  regenerateToken: () => call<string>("mcp_regenerate_token"),
  clientConfig: () => call<McpClientConfig>("mcp_client_config"),
  pendingApprovals: () => call<McpApprovalRequest[]>("mcp_pending_approvals"),
  reply: (id: string, decision: McpDecision) => call<boolean>("mcp_approval_reply", { id, decision }),
  uiReply: (id: string, ok: boolean, value: unknown, error: string | null) =>
    call<boolean>("mcp_ui_reply", { id, ok, value: value ?? null, error }),
  activity: () => call<AuditEntry[]>("mcp_activity"),
  autoList: () => call<McpAutoState[]>("mcp_auto_list"),
  setAuto: (serverId: string, level: McpAutoLevel, duration: McpAutoDuration) =>
    call<McpAutoState[]>("mcp_set_auto", { serverId, level, duration }),
  autoOffAll: () => call<McpAutoState[]>("mcp_auto_off_all"),
  clearActivity: () => call<void>("mcp_activity_clear"),
};
