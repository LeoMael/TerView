// Panel "Ejecutar en varios servidores": preparar (servidores + comando) y ver resultados.
import { useCallback, useEffect, useRef } from "react";
import { SquareTerminal, X } from "lucide-react";
import { closeMultiRun, multiRunBusy, useMultiRun } from "../../features/multirun/store";
import { summarize } from "../../features/multirun/results";
import { confirmDialog } from "../ui/dialogs";
import { SetupView } from "./SetupView";
import { ResultsView } from "./ResultsView";
import "./MultiRun.css";

/** ¿Hay otro diálogo o menú encima (contraseña, confirmación…)? Entonces Escape es suyo. */
function somethingAbove(): boolean {
  return !!document.querySelector(".modal-backdrop, .context-menu");
}

export function MultiRunPanel() {
  const view = useMultiRun((s) => s.view);
  const hasRun = useMultiRun((s) => s.run !== null);
  const panelRef = useRef<HTMLDivElement>(null);

  const requestClose = useCallback(async () => {
    if (multiRunBusy()) {
      const run = useMultiRun.getState().run;
      const s = run ? summarize(run.targets) : null;
      const pending = s ? s.total - s.done - s.counts.attention : 0;
      const ok = await confirmDialog({
        title: "¿Cancelar la ejecución?",
        message:
          pending === 1
            ? "Queda 1 servidor en marcha. Se detendrá su comando en el servidor y se cerrarán las conexiones abiertas para ejecutarlo."
            : `Quedan ${pending} servidores en marcha. Se detendrán sus comandos en los servidores y se cerrarán las conexiones abiertas para ejecutarlos.`,
        confirmText: "Cancelar y cerrar",
        cancelText: "Seguir",
        danger: true,
      });
      if (!ok) return;
    }
    closeMultiRun();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || somethingAbove()) return;
      // Escape dentro de la biblioteca o un campo con su propio manejo: lo gestiona él.
      if ((e.target as HTMLElement | null)?.closest?.("[data-mr-own-escape]")) return;
      e.preventDefault();
      void requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div className="mr-backdrop" onMouseDown={(e) => e.target === e.currentTarget && void requestClose()}>
      <div
        ref={panelRef}
        className="mr-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Ejecutar en varios servidores"
        tabIndex={-1}
      >
        <div className="mr-header">
          <SquareTerminal size={17} className="mr-header-icon" />
          <h2>Ejecutar en varios servidores</h2>
          {hasRun && (
            <div className="mr-steps" role="tablist" aria-label="Pasos">
              <span className={view === "setup" ? "active" : ""}>1. Preparar</span>
              <span className={view === "results" ? "active" : ""}>2. Resultados</span>
            </div>
          )}
          <button className="icon-btn mr-close" onClick={() => void requestClose()} aria-label="Cerrar" title="Cerrar (Esc)">
            <X size={16} />
          </button>
        </div>
        {view === "setup" ? <SetupView onCancel={() => void requestClose()} /> : <ResultsView />}
      </div>
    </div>
  );
}
