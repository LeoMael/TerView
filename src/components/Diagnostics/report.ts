// Informe de diagnóstico en texto plano (para pegar en un issue de GitHub). Sin argumentos de comandos,
// sin nombres de servidores ni rutas: solo versiones, sistema y tiempos.
import { getCallTimings } from "../../api/core";
import { appDiagnostics, bootTimes, commandStats, fmtMs, rendererInfo, type AppDiagnostics } from "./diagnostics";
import { useFps } from "./fps";

async function appVersions(): Promise<{ app: string; tauri: string; bundle: string }> {
  try {
    const m = await import("@tauri-apps/api/app");
    const [app, tauri, bundle] = await Promise.all([
      m.getVersion(),
      m.getTauriVersion(),
      m.getBundleType().then(
        (b) => (b as string | null) ?? "desconocido",
        () => "desconocido",
      ),
    ]);
    return { app, tauri, bundle };
  } catch {
    return { app: "?", tauri: "?", bundle: "?" };
  }
}

export async function buildReport(): Promise<string> {
  const [v, sys] = await Promise.all([appVersions(), appDiagnostics().catch(() => null as AppDiagnostics | null)]);
  const r = rendererInfo();
  const boot = bootTimes();
  const stats = commandStats(getCallTimings());
  const fps = useFps.getState();
  const L: string[] = [];

  L.push("## Diagnóstico de SSHorus", "");
  L.push(`- SSHorus: ${v.app} (formato: ${v.bundle})${sys?.debugBuild ? " — compilación de DESARROLLO" : ""}`);
  L.push(`- Tauri: ${v.tauri}`);
  if (sys) {
    L.push(`- Sistema: ${sys.osName ?? sys.os} (${sys.os} ${sys.arch})${sys.kernel ? `, núcleo ${sys.kernel}` : ""}`);
    L.push(`- Motor de la ventana: ${sys.webviewVersion ?? "desconocido"}`);
    if (sys.os === "linux") L.push(`- Driver NVIDIA: ${sys.nvidiaDriver ? "sí" : "no"}`);
  }
  L.push(`- WebGL: ${r.webgl}${r.renderer ? ` — ${r.vendor ?? "?"} / ${r.renderer}` : ""}`);
  L.push(`- Escala de pantalla: ${r.devicePixelRatio}`);
  L.push(`- Agente: ${r.userAgent}`);
  if (sys) {
    const set = sys.env.filter((e) => e.value !== null);
    L.push(`- Variables: ${set.length ? set.map((e) => `${e.name}=${e.value}`).join(", ") : "ninguna"}`);
  }

  L.push("", "### Arranque");
  L.push(`- Código inicial listo: ${fmtMs(boot.main)}`);
  L.push(`- Primer dibujado: ${fmtMs(boot.firstRender)}`);
  L.push(`- App lista: ${fmtMs(boot.appReady)}`);

  if (fps.enabled || fps.min !== null) {
    L.push("", "### FPS");
    L.push(`- Actual ${fps.fps} · mínimo ${fps.min ?? "—"} · fotograma más largo ${Math.round(fps.worstFrame)} ms · tirones ${fps.jank}`);
  }

  L.push("", `### Comandos del motor (últimas ${stats.reduce((n, s) => n + s.count, 0)} llamadas)`);
  if (!stats.length) L.push("- (sin llamadas registradas)");
  else {
    L.push("", "| Comando | Llamadas | Errores | p50 | p95 | Máx |", "|---|---:|---:|---:|---:|---:|");
    for (const s of stats.slice(0, 40)) {
      L.push(`| ${s.cmd} | ${s.count} | ${s.errors} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.max)} |`);
    }
  }
  return L.join("\n") + "\n";
}
