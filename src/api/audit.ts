// Auditoría del servidor: tipos del informe y su historial en el motor (`src-tauri/src/audit/`).
// Las comprobaciones se hacen en la interfaz (`src/features/audit/`); el motor solo guarda.
import { call } from "./core";
import type { AiExplanation } from "./vulnscan";

/** bien · aviso · mal · dato (no puntúa) · sin comprobar. */
export type CheckStatus = "ok" | "warn" | "bad" | "info" | "skip";

export type CategoryId = "ssh" | "users" | "net" | "updates" | "web" | "containers" | "system" | "logins" | "hardening";

export interface Fix {
  command: string;
  /** Puede cortar el acceso o un servicio: hay que escribir una palabra para confirmar. */
  danger: boolean;
  /** Solo para copiar: hay que revisarlo a mano. */
  manual: boolean;
  note: string | null;
}

export interface Check {
  id: string;
  category: CategoryId;
  title: string;
  status: CheckStatus;
  /** Una línea, sin nombres de usuario ni direcciones (es lo que va a la IA). */
  detail: string;
  /** Lo afectado (usuarios, puertos, archivos…). Solo se ve en este equipo. */
  items: string[];
  fix: Fix | null;
  /** 1 leve · 2 medio · 3 grave. */
  weight: number;
}

export interface CategoryScore {
  id: CategoryId;
  label: string;
  score: number | null;
  grade: string | null;
  summary: string;
}

export interface AuditReport {
  id: string;
  serverId: string;
  createdAt: string;
  durationMs: number;
  elevated: boolean;
  os: string;
  score: number | null;
  grade: string | null;
  summary: string;
  categories: CategoryScore[];
  checks: Check[];
  ai: AiExplanation | null;
}

export interface AuditMeta {
  id: string;
  createdAt: string;
  elevated: boolean;
  score: number | null;
  grade: string | null;
  bad: number;
  warn: number;
  hasAi: boolean;
}

export const audit = {
  save: (report: AuditReport) => call<AuditReport>("audit_save", { report }),
  historyList: (serverId: string) => call<AuditMeta[]>("audit_history_list", { serverId }),
  historyGet: (serverId: string, reportId: string) => call<AuditReport>("audit_history_get", { serverId, reportId }),
  latest: (serverId: string) => call<AuditReport | null>("audit_latest", { serverId }),
  /** Sin `reportId`: borra todo el historial del servidor. */
  historyDelete: (serverId: string, reportId?: string) =>
    call<void>("audit_history_delete", { serverId, reportId: reportId ?? null }),
  setAi: (serverId: string, reportId: string, ai: AiExplanation | null) =>
    call<AuditReport>("audit_set_ai", { serverId, reportId, ai }),
};
