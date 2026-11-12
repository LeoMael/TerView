// Datos del panel de diagnóstico: sistema (motor), renderizador, arranque y tiempos de comandos.
import { call, getCallTimings, type CallTiming } from "../../api/core";
import { BOOT_MARKS, bootTime } from "./bootMarks";

export interface AppDiagnostics {
  os: string;
  arch: string;
  osName: string | null;
  kernel: string | null;
  webviewVersion: string | null;
  debugBuild: boolean;
  nvidiaDriver: boolean;
  env: { name: string; value: string | null }[];
}

let cached: Promise<AppDiagnostics> | null = null;

/** Sistema, arquitectura, versión del motor de la ventana y variables de dibujado. */
export function appDiagnostics(): Promise<AppDiagnostics> {
  cached ??= call<AppDiagnostics>("app_diagnostics").catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

export interface RendererInfo {
  webgl: "webgl2" | "webgl" | "no";
  vendor: string | null;
  renderer: string | null;
  userAgent: string;
  devicePixelRatio: number;
}

let renderer: RendererInfo | null = null;

/** Tarjeta gráfica que usa la ventana (si WebKit/WebView2 la expone) y agente de usuario. */
export function rendererInfo(): RendererInfo {
  if (renderer) return renderer;
  let webgl: RendererInfo["webgl"] = "no";
  let vendor: string | null = null;
  let rend: string | null = null;
  try {
    const canvas = document.createElement("canvas");
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = canvas.getContext("webgl2");
    if (gl) webgl = "webgl2";
    else {
      gl = canvas.getContext("webgl");
      if (gl) webgl = "webgl";
    }
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      vendor = String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? "") || null;
      rend = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "") || null;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // Sin WebGL.
  }
  renderer = {
    webgl,
    vendor,
    renderer: rend,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
  };
  return renderer;
}

export interface BootTimes {
  /** HTML y código inicial listos (main.tsx empieza). */
  main: number | null;
  /** Primer dibujado de la interfaz. */
  firstRender: number | null;
  /** Ajustes y servidores cargados. */
  appReady: number | null;
}

export function bootTimes(): BootTimes {
  return {
    main: bootTime(BOOT_MARKS.main),
    firstRender: bootTime(BOOT_MARKS.firstRender),
    appReady: bootTime(BOOT_MARKS.appReady),
  };
}

export interface CommandStats {
  cmd: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  /** Duración de la última llamada. */
  last: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Estadísticas por comando de las últimas llamadas (más lentas primero, por p95). */
export function commandStats(samples: CallTiming[] = getCallTimings()): CommandStats[] {
  const by = new Map<string, CallTiming[]>();
  for (const s of samples) {
    const list = by.get(s.cmd);
    if (list) list.push(s);
    else by.set(s.cmd, [s]);
  }
  const out: CommandStats[] = [];
  for (const [cmd, list] of by) {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    out.push({
      cmd,
      count: list.length,
      errors: list.filter((s) => !s.ok).length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      max: ms[ms.length - 1],
      last: list[list.length - 1].ms,
    });
  }
  return out.sort((a, b) => b.p95 - a.p95);
}

/** "12 ms", "1,4 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toLocaleString("es", { maximumFractionDigits: 2 })} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  return `${ms.toLocaleString("es", { maximumFractionDigits: 1 })} ms`;
}
