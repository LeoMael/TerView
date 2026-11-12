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

/** Una llamada al motor medida (para el panel de diagnóstico). Nunca guarda los argumentos. */
export interface CallTiming {
  cmd: string;
  /** Duración en ms. */
  ms: number;
  ok: boolean;
  /** Momento de inicio (`performance.now()`). */
  at: number;
}

const TIMINGS_MAX = 500;
const timings: CallTiming[] = [];
let timingsNext = 0;

function recordTiming(t: CallTiming) {
  if (timings.length < TIMINGS_MAX) timings.push(t);
  else timings[timingsNext] = t;
  timingsNext = (timingsNext + 1) % TIMINGS_MAX;
}

/** Últimas llamadas al motor (hasta 500), de la más antigua a la más reciente. */
export function getCallTimings(): CallTiming[] {
  return timings.length < TIMINGS_MAX ? timings.slice() : [...timings.slice(timingsNext), ...timings.slice(0, timingsNext)];
}

export function clearCallTimings() {
  timings.length = 0;
  timingsNext = 0;
}

/** `invoke` con errores convertidos a `ApiError`. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const at = performance.now();
  let ok = false;
  try {
    const r = await invoke<T>(cmd, args);
    ok = true;
    return r;
  } catch (e) {
    if (e && typeof e === "object" && "kind" in e && "message" in e) {
      throw new ApiError(e as ApiErrorPayload);
    }
    throw new ApiError({ kind: "Unknown", message: errorMessage(e), hostKey: null });
  } finally {
    recordTiming({ cmd, ms: performance.now() - at, ok, at });
  }
}
