// Aviso discreto de versión nueva (arriba a la derecha): ver novedades, actualizar y reiniciar, o más tarde.
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatBytes } from "../../lib/format";
import { toast } from "../../stores/toasts";
import { useTabs } from "../../stores/tabs";
import { confirmDialog } from "../../components/ui/dialogs";
import { openSettingsAt } from "../../components/Settings/settingsNav";
import { canSelfUpdate, installUpdate, needsAdmin, RELEASES_URL, useUpdater } from "./updater";
import "./UpdateNotice.css";

export function UpdateNotice() {
  const open = useUpdater((s) => s.noticeOpen);
  const status = useUpdater((s) => s.status);
  const info = useUpdater((s) => s.info);
  const bundle = useUpdater((s) => s.bundle);
  const progress = useUpdater((s) => s.progress);
  const error = useUpdater((s) => s.error);
  const close = () => useUpdater.getState().setNoticeOpen(false);

  if (!open || !info) return null;
  const busy = status === "downloading" || status === "installing" || status === "ready";
  const pct = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className="upn" role="status" aria-live="polite">
      <div className="upn-head">
        <Download size={15} className="upn-icon" />
        <div className="upn-title">
          <strong>Hay una versión nueva: {info.version}</strong>
          <small>Tienes la {info.currentVersion}</small>
        </div>
        {!busy && (
          <button className="icon-btn" onClick={close} aria-label="Cerrar aviso">
            <X size={14} />
          </button>
        )}
      </div>

      {busy ? (
        <div className="upn-progress">
          <div className="progress">
            <div style={{ width: `${pct ?? (status === "downloading" ? 30 : 100)}%` }} />
          </div>
          <small>
            {status === "downloading" &&
              (pct !== null
                ? `Descargando… ${pct} % (${formatBytes(progress.done)} de ${formatBytes(progress.total ?? 0)})`
                : `Descargando… ${formatBytes(progress.done)}`)}
            {status === "installing" && (needsAdmin(bundle) ? "Instalando… (puede pedir tu contraseña de administrador)" : "Instalando…")}
            {status === "ready" && "Reiniciando…"}
          </small>
        </div>
      ) : (
        <>
          {status === "error" && error && <p className="upn-error">{error}</p>}
          {!canSelfUpdate(bundle) && (
            <p className="upn-hint">Esta instalación no se actualiza sola: descarga el instalador nuevo desde GitHub.</p>
          )}
          <div className="upn-actions">
            <button
              className="btn"
              onClick={() => {
                close();
                openSettingsAt("about");
              }}
            >
              Ver novedades
            </button>
            {canSelfUpdate(bundle) ? (
              <button className="btn btn-primary" onClick={() => void startInstall()}>
                <RefreshCw size={14} /> Actualizar y reiniciar
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void openUrl(RELEASES_URL)}>
                <ExternalLink size={14} /> Ir a descargas
              </button>
            )}
            <button className="btn upn-later" onClick={close}>
              Más tarde
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Pide confirmación si hay conexiones abiertas (se cerrarán al reiniciar) y actualiza. */
export async function startInstall() {
  const open = useTabs.getState().tabs.filter((t) => t.status !== "closed").length;
  if (open > 0) {
    const ok = await confirmDialog({
      title: "Actualizar y reiniciar",
      message:
        open === 1
          ? "Hay 1 conexión abierta. Se cerrará al reiniciar TerView."
          : `Hay ${open} conexiones abiertas. Se cerrarán al reiniciar TerView.`,
      confirmText: "Actualizar y reiniciar",
    });
    if (!ok) return;
  }
  try {
    await installUpdate();
  } catch (e) {
    toast.error("No se pudo actualizar", e);
  }
}
