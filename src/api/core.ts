import { invoke } from "@tauri-apps/api/core";
import type { ApiErrorKind, ApiErrorPayload, HostKeyInfo } from "./types";

/** Error normalizado de cualquier comando del motor. */
export class ApiError extends Error {
  kind: ApiErrorKind;
  hostKey: HostKeyInfo | null;
  constructor(p: ApiErrorPayload) {
    super(p.message);
    this.name = "ApiError";
    this.kind = p.kind;
    this.hostKey = p.hostKey;
  }
}

export function isApiError(e: unknown, kind?: ApiErrorKind): e is ApiError {
  return e instanceof ApiError && (kind === undefined || e.kind === kind);
}

/** Mensaje legible para cualquier error. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Error desconocido";
}

/** `invoke` con errores convertidos a `ApiError`. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === "object" && "kind" in e && "message" in e) {
      throw new ApiError(e as ApiErrorPayload);
    }
    throw new ApiError({ kind: "Unknown", message: errorMessage(e), hostKey: null });
  }
}
