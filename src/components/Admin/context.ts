// Contexto compartido por las sub-pestañas de Administración.
import { createContext, useContext } from "react";
import type { ExecResult } from "../../api/types";
import type { AdminEnv, Plan, ReadResult, ShadowEntry, UserRow } from "../../features/admin";
import type { Elevation, ElevationState, PrivilegeInfo } from "../../features/privileges";

export interface RunOutcome {
  ok: boolean;
  result: ExecResult | null;
  /** Mensaje de error listo para mostrar (stderr, fallo de sudo, etc.). */
  error: string | null;
  /** La contraseña de sudo era incorrecta o falta: hay que volver a pedirla. */
  needSudo: boolean;
}

export interface AdminContextValue {
  sessionId: string;
  profileId: string;
  serverName: string;
  disabled: boolean;
  info: PrivilegeInfo | null;
  elev: ElevationState;
  /** Elevación efectiva (null = solo lectura). */
  elevation: Elevation | null;
  readOnly: boolean;
  env: AdminEnv | null;
  read: ReadResult | null;
  shadow: Map<string, ShadowEntry> | null;
  users: UserRow[];
  /** Usuario con el que está conectada la app. */
  me: string | null;
  refresh: () => void;
  /** Ejecuta un cambio como root, lo apunta en el historial y refresca. */
  runPlan: (plan: Plan, opts?: { refresh?: boolean }) => Promise<RunOutcome>;
  askSudo: () => void;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const v = useContext(AdminContext);
  if (!v) throw new Error("useAdmin fuera de AdminPanel");
  return v;
}

/** Motivo por el que no se puede bloquear/eliminar una cuenta (o null). */
export function protectedReason(name: string, me: string | null): string | null {
  if (name === "root") return "No se puede bloquear ni eliminar root desde aquí";
  if (me && name === me) return "Es el usuario con el que estás conectado";
  return null;
}
