// Estado del servidor MCP en la interfaz: estado del servidor, permisos pendientes y actividad.
// El estado de verdad vive en el motor (src-tauri/src/mcp); aquí se refleja con sus eventos.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  EV_MCP_ACTIVITY,
  EV_MCP_APPROVAL,
  EV_MCP_APPROVAL_DONE,
  EV_MCP_STATUS,
  EV_MCP_UI_REQUEST,
  mcp,
  type AuditEntry,
  type McpApprovalRequest,
  type McpStatus,
  type McpUiRequest,
} from "../../api/mcp";
import { handleUiRequest } from "./uiBridge";

/** Acciones que se guardan en la lista (las mismas que el motor). */
const KEEP = 300;

interface McpUiState {
  status: McpStatus | null;
  /** Peticiones de permiso pendientes, la más antigua primero. */
  approvals: McpApprovalRequest[];
  /** Actividad del asistente, la más reciente primero. */
  activity: AuditEntry[];
  activityOpen: boolean;
}

export const useMcp = create<McpUiState>(() => ({
  status: null,
  approvals: [],
  activity: [],
  activityOpen: false,
}));

export function openActivity() {
  useMcp.setState({ activityOpen: true });
  void refreshActivity();
}

export function closeActivity() {
  useMcp.setState({ activityOpen: false });
}

export async function refreshStatus() {
  try {
    useMcp.setState({ status: await mcp.status() });
  } catch {
    /* el motor aún arranca: llegará el evento */
  }
}

export async function refreshActivity() {
  try {
    useMcp.setState({ activity: await mcp.activity() });
  } catch {
    /* sin datos: la lista se queda como está */
  }
}

function upsertActivity(e: AuditEntry) {
  useMcp.setState((s) => {
    const i = s.activity.findIndex((x) => x.id === e.id);
    if (i >= 0) {
      const next = s.activity.slice();
      next[i] = e;
      return { activity: next };
    }
    return { activity: [e, ...s.activity].slice(0, KEEP) };
  });
}

let started = false;

/** Una vez, en la ventana principal: escucha al motor (permisos, actividad y peticiones). */
export function initMcp() {
  if (started) return;
  started = true;
  void listen<McpApprovalRequest>(EV_MCP_APPROVAL, (e) => {
    useMcp.setState((s) =>
      s.approvals.some((a) => a.id === e.payload.id) ? s : { approvals: [...s.approvals, e.payload] },
    );
  });
  void listen<string>(EV_MCP_APPROVAL_DONE, (e) => {
    useMcp.setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.payload) }));
  });
  void listen<AuditEntry>(EV_MCP_ACTIVITY, (e) => upsertActivity(e.payload));
  void listen<McpStatus>(EV_MCP_STATUS, (e) => useMcp.setState({ status: e.payload }));
  void listen<McpUiRequest>(EV_MCP_UI_REQUEST, (e) => void handleUiRequest(e.payload));
  void refreshStatus();
  void refreshActivity();
  void mcp
    .pendingApprovals()
    .then((approvals) => useMcp.setState({ approvals }))
    .catch(() => {});
}
