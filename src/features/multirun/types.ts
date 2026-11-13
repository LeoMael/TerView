// Tipos de "Ejecutar en varios servidores".
import type { AuthMethod, ExecResult } from "../../api/types";

/** Estado de un servidor dentro de una ejecución. */
export type TargetStatus =
  | "queued" // en cola (esperando turno)
  | "connecting" // conectando en segundo plano
  | "attention" // necesita que el usuario haga algo (contraseña, huella, 2FA)
  | "running" // ejecutando el comando
  | "ok" // terminó con código 0
  | "error" // código distinto de 0 o fallo de conexión/ejecución
  | "timeout" // se agotó el tiempo
  | "canceled"; // cancelado por el usuario

/** Motivo por el que un servidor "requiere atención". */
export type AttentionKind = "password" | "passphrase" | "otp" | "hostkey" | "hostkey-changed" | "auth";

/** Privilegios conocidos del usuario remoto (solo informativo). */
export type PrivilegeHint = "root" | "sudo-nopasswd" | "sudo" | "maybe-sudo" | "user" | "unknown";

export interface TargetState {
  profileId: string;
  name: string;
  /** usuario@host[:puerto] */
  address: string;
  auth: AuthMethod;
  status: TargetStatus;
  /** Mensaje de error o del motivo de atención. */
  detail: string | null;
  attention: AttentionKind | null;
  sessionId: string | null;
  /** true = la sesión la abrió la ejecución (se desconecta al terminar). */
  owned: boolean;
  /** true = se reutilizó la sesión de una pestaña abierta. */
  reused: boolean;
  /** Inicio de la conexión / de la ejecución (ms, Date.now()). */
  connectStartedAt: number | null;
  execStartedAt: number | null;
  finishedAt: number | null;
  result: ExecResult | null;
  privilege: PrivilegeHint | null;
}

export interface RunSpec {
  /** Comando final (variables ya sustituidas). */
  command: string;
  /** Nombre del comando de la biblioteca, si se eligió uno. */
  label: string | null;
  timeoutSecs: number;
  concurrency: number;
  /** El comando usa sudo/doas: se consulta el nivel de privilegios por servidor. */
  usesSudo: boolean;
  /**
   * El comando usa sudo (sin -n): en cada servidor donde sudo pida contraseña se consigue como en el resto de
   * TerView (en memoria → guardada → otra pestaña → diálogo en cola) y se ejecuta con ella.
   */
  sudoPassword?: boolean;
}

export interface TargetInput {
  profileId: string;
  name: string;
  address: string;
  auth: AuthMethod;
}

export const FINAL_STATUSES: readonly TargetStatus[] = ["ok", "error", "timeout", "canceled"];

export function isFinal(s: TargetStatus): boolean {
  return FINAL_STATUSES.includes(s);
}

/** Cuenta como "error" para el filtro "Solo errores". */
export function isProblem(s: TargetStatus): boolean {
  return s === "error" || s === "timeout" || s === "attention";
}
