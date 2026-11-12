// Ajustes → Avanzado → Diagnóstico: tiempos de arranque, de cada comando del motor, FPS y datos del
// renderizador, para comparar antes/después de un cambio y adjuntar a un informe de error.
import { useEffect, useState } from "react";
import { ClipboardCopy, Eraser, Gauge, RotateCcw } from "lucide-react";
import { clearCallTimings, errorMessage } from "../../api/core";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { appDiagnostics, bootTimes, commandStats, fmtMs, rendererInfo, type AppDiagnostics } from "./diagnostics";
import { resetFpsStats, setFpsEnabled, useFps } from "./fps";
import { buildReport } from "./report";
import "./Diagnostics.css";

export function DiagnosticsPanel() {
  const [sys, setSys] = useState<AppDiagnostics | null>(null);
  const [sysError, setSysError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    appDiagnostics().then(setSys, (e) => setSysError(errorMessage(e)));
    // Refresca tiempos de comandos y arranque mientras el panel está abierto.
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const boot = bootTimes();
  const gpu = rendererInfo();
  const stats = commandStats();
  const total = stats.reduce((n, s) => n + s.count, 0);

  const copy = async () => {
    try {
      await clipboard.write(await buildReport());
      toast.success("Informe copiado", "Pégalo en un issue de GitHub. No incluye contraseñas, servidores ni rutas.");
    } catch (e) {
      toast.error("No se pudo copiar el informe", e);
    }
  };

  return (
    <div className="dg">
      <div className="dg-head">
        <p className="dg-intro">Mide la app para comparar antes y después de un cambio. Nada sale de tu equipo.</p>
        <button className="btn btn-primary" onClick={() => void copy()}>
          <ClipboardCopy size={14} /> Copiar informe
        </button>
      </div>

      <section className="dg-section">
        <h4 className="section-label">Arranque</h4>
        <div className="dg-tiles">
          <Tile label="Código inicial listo" value={fmtMs(boot.main)} hint="HTML y JavaScript inicial cargados" />
          <Tile label="Primer dibujado" value={fmtMs(boot.firstRender)} hint="La ventana muestra la interfaz" />
          <Tile label="App lista" value={fmtMs(boot.appReady)} hint="Ajustes y servidores cargados" />
        </div>
      </section>

      <section className="dg-section">
        <h4 className="section-label">Ventana y sistema</h4>
        {sysError && <p className="dg-error">No se pudo leer la información del sistema: {sysError}</p>}
        <dl className="dg-kv">
          <dt>Sistema</dt>
          <dd>{sys ? `${sys.osName ?? sys.os} (${sys.arch})${sys.kernel ? ` · núcleo ${sys.kernel}` : ""}` : "…"}</dd>
          <dt>Motor de la ventana</dt>
          <dd>{sys ? (sys.webviewVersion ?? "desconocido") : "…"}</dd>
          <dt>Compilación</dt>
          <dd>
            {sys === null ? "…" : sys.debugBuild ? (
              <span className="dg-warn">Desarrollo (sin optimizar, bastante más lenta)</span>
            ) : (
              "Optimizada (versión instalada)"
            )}
          </dd>
          <dt>Tarjeta gráfica</dt>
          <dd>
            {gpu.webgl === "no" ? (
              <span className="dg-warn">Sin WebGL (dibujado por software)</span>
            ) : (
              `${gpu.renderer ?? "desconocida"}${gpu.vendor ? ` · ${gpu.vendor}` : ""} · ${gpu.webgl === "webgl2" ? "WebGL 2" : "WebGL 1"}`
            )}
          </dd>
          {sys?.os === "linux" && (
            <>
              <dt>Arreglo de dibujado</dt>
              <dd>{dmabufLabel(sys)}</dd>
            </>
          )}
          <dt>Escala de pantalla</dt>
          <dd>{gpu.devicePixelRatio}×</dd>
          <dt>Agente</dt>
          <dd className="dg-mono dg-wrap">{gpu.userAgent}</dd>
          {sys && sys.env.some((e) => e.value !== null) && (
            <>
              <dt>Variables</dt>
              <dd className="dg-mono dg-wrap">
                {sys.env
                  .filter((e) => e.value !== null)
                  .map((e) => `${e.name}=${e.value}`)
                  .join("  ")}
              </dd>
            </>
          )}
        </dl>
      </section>

      <FpsSection />

      <section className="dg-section">
        <div className="dg-section-head">
          <h4 className="section-label">Comandos del motor</h4>
          <span className="dg-muted">{total ? `últimas ${total} llamadas` : ""}</span>
          <button className="btn dg-small" onClick={() => clearCallTimings()} disabled={!total}>
            <Eraser size={13} /> Vaciar
          </button>
        </div>
        {stats.length === 0 ? (
          <p className="dg-muted">Aún no hay llamadas registradas. Usa la app (conectar, abrir carpetas…) y vuelve aquí.</p>
        ) : (
          <div className="dg-table-wrap">
            <table className="dg-table">
              <thead>
                <tr>
                  <th>Comando</th>
                  <th>Llamadas</th>
                  <th>Errores</th>
                  <th>p50</th>
                  <th>p95</th>
                  <th>Máx</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.cmd}>
                    <td className="dg-mono">{s.cmd}</td>
                    <td>{s.count}</td>
                    <td className={s.errors ? "dg-bad" : undefined}>{s.errors}</td>
                    <td>{fmtMs(s.p50)}</td>
                    <td className={s.p95 > 500 ? "dg-warn" : undefined}>{fmtMs(s.p95)}</td>
                    <td>{fmtMs(s.max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="dg-note">Se guardan las últimas 500 llamadas, solo nombre, duración y si fallaron (nunca los argumentos).</p>
      </section>
    </div>
  );
}

function dmabufLabel(sys: AppDiagnostics): string {
  const get = (n: string) => sys.env.find((e) => e.name === n)?.value ?? null;
  const dmabuf = get("WEBKIT_DISABLE_DMABUF_RENDERER");
  const optOut = get("TERVIEW_WEBKIT_DEFAULTS") !== null;
  if (dmabuf !== null) {
    if (sys.nvidiaDriver && !optOut) return "Aplicado (WEBKIT_DISABLE_DMABUF_RENDERER): driver NVIDIA detectado";
    return `Aplicado (WEBKIT_DISABLE_DMABUF_RENDERER=${dmabuf}), definido en el entorno`;
  }
  if (optOut) return "Desactivado a mano (TERVIEW_WEBKIT_DEFAULTS)";
  return sys.nvidiaDriver ? "No aplicado" : "No hace falta (sin driver NVIDIA)";
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="dg-tile" title={hint}>
      <span className="dg-tile-value">{value}</span>
      <span className="dg-tile-label">{label}</span>
    </div>
  );
}

function FpsSection() {
  const { enabled, fps, min, worstFrame, jank } = useFps();
  return (
    <section className="dg-section">
      <div className="dg-section-head">
        <h4 className="section-label">Fluidez (FPS)</h4>
        <span className="dg-muted">{enabled ? "midiendo" : ""}</span>
        {enabled && (
          <button className="btn dg-small" onClick={resetFpsStats}>
            <RotateCcw size={13} /> Reiniciar
          </button>
        )}
        <button className={enabled ? "btn dg-small" : "btn btn-primary dg-small"} onClick={() => setFpsEnabled(!enabled)}>
          <Gauge size={13} /> {enabled ? "Apagar" : "Medir FPS"}
        </button>
      </div>
      {enabled ? (
        <div className="dg-tiles">
          <Tile label="FPS ahora" value={String(fps)} hint="Fotogramas por segundo del último medio segundo" />
          <Tile label="Peor FPS" value={min === null ? "—" : String(min)} hint="Desde que se activó o se reinició" />
          <Tile label="Fotograma más largo" value={`${Math.round(worstFrame)} ms`} hint="En el último medio segundo" />
          <Tile label="Tirones" value={String(jank)} hint="Fotogramas de más de 50 ms" />
        </div>
      ) : (
        <p className="dg-muted">
          Activa el medidor, cierra los Ajustes y mueve divisores, cambia de pestaña o haz scroll: el indicador queda abajo a la
          izquierda. Lo ideal es 60 (o la frecuencia de tu pantalla).
        </p>
      )}
    </section>
  );
}
