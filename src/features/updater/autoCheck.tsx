// Búsqueda automática al arrancar (sin bloquear) y montaje del aviso flotante.
// Se carga aparte desde main.tsx cuando la app ya está lista.
import { checkForUpdates, getAutoCheck, useUpdater } from "./updater";

/** Espera tras arrancar antes de consultar GitHub (no competir con la carga inicial). */
const START_DELAY_MS = 6000;

let started = false;

export function startUpdaterAutoCheck() {
  if (started) return;
  started = true;
  ensureNoticeMounted();
  if (!getAutoCheck()) return;
  setTimeout(() => {
    void checkForUpdates({ silent: true }).then((info) => {
      if (info) useUpdater.getState().setNoticeOpen(true);
    });
  }, START_DELAY_MS);
}

let mounted = false;

/** El aviso vive en su propia raíz de React (no depende de App). */
export function ensureNoticeMounted() {
  if (mounted) return;
  mounted = true;
  void Promise.all([import("react-dom/client"), import("./UpdateNotice")]).then(([{ createRoot }, { UpdateNotice }]) => {
    const host = document.createElement("div");
    host.id = "tv-update-notice-root";
    document.body.appendChild(host);
    createRoot(host).render(<UpdateNotice />);
  });
}
