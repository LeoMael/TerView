// Medidor de FPS (requestAnimationFrame) con un indicador flotante, para comparar la fluidez al mover
// paneles, hacer scroll, etc. Solo funciona mientras está activado: apagado no consume nada.
import { create } from "zustand";
import { Gauge, X } from "lucide-react";
import "./Diagnostics.css";

interface FpsState {
  enabled: boolean;
  /** FPS del último medio segundo. */
  fps: number;
  /** Peor FPS registrado desde que se activó (o desde el último reinicio). */
  min: number | null;
  /** Fotograma más largo (ms) en la ventana actual. */
  worstFrame: number;
  /** Fotogramas de más de 50 ms (tirones visibles) desde que se activó. */
  jank: number;
}

export const useFps = create<FpsState>(() => ({ enabled: false, fps: 0, min: null, worstFrame: 0, jank: 0 }));

let raf = 0;
let windowStart = 0;
let frames = 0;
let prev = 0;
let worst = 0;

function loop(now: number) {
  if (prev) {
    const dt = now - prev;
    if (dt > worst && dt < 1000) worst = dt;
    // > 1 s: la ventana estuvo oculta o minimizada; no es un tirón.
    if (dt > 50 && dt < 1000) useFps.setState((s) => ({ jank: s.jank + 1 }));
  }
  prev = now;
  frames++;
  const elapsed = now - windowStart;
  if (elapsed >= 500) {
    const fps = Math.round((frames * 1000) / elapsed);
    useFps.setState((s) => ({ fps, worstFrame: worst, min: s.min === null ? fps : Math.min(s.min, fps) }));
    frames = 0;
    worst = 0;
    windowStart = now;
  }
  raf = requestAnimationFrame(loop);
}

export function setFpsEnabled(on: boolean) {
  if (on === useFps.getState().enabled) return;
  if (on) {
    useFps.setState({ enabled: true, fps: 0, min: null, worstFrame: 0, jank: 0 });
    frames = 0;
    prev = 0;
    worst = 0;
    windowStart = performance.now();
    raf = requestAnimationFrame(loop);
    ensureOverlay();
  } else {
    cancelAnimationFrame(raf);
    useFps.setState({ enabled: false });
  }
}

export function resetFpsStats() {
  useFps.setState({ min: null, jank: 0 });
}

let overlayMounted = false;

function ensureOverlay() {
  if (overlayMounted) return;
  overlayMounted = true;
  void import("react-dom/client").then(({ createRoot }) => {
    const host = document.createElement("div");
    host.id = "tv-fps-root";
    document.body.appendChild(host);
    createRoot(host).render(<FpsOverlay />);
  });
}

/** Indicador flotante (abajo a la izquierda) visible aunque se cierren los Ajustes. */
function FpsOverlay() {
  const { enabled, fps, min, worstFrame, jank } = useFps();
  if (!enabled) return null;
  const tone = fps >= 50 ? "good" : fps >= 30 ? "warn" : "bad";
  return (
    <div className="dg-fps-overlay" role="status" aria-label="Medidor de FPS">
      <Gauge size={13} />
      <span className={`dg-fps-num ${tone}`}>{fps}</span>
      <span className="dg-fps-unit">FPS</span>
      <span className="dg-fps-extra" title="Peor FPS · fotograma más largo · tirones (> 50 ms)">
        mín {min ?? "—"} · {Math.round(worstFrame)} ms · {jank}
      </span>
      <button className="icon-btn" onClick={() => setFpsEnabled(false)} aria-label="Apagar medidor de FPS">
        <X size={12} />
      </button>
    </div>
  );
}
