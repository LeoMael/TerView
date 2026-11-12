// Actualizaciones automáticas: busca en GitHub Releases (latest.json firmado), descarga, instala y reinicia.
//
// Formatos que se actualizan solos (tauri-plugin-updater 2.14):
//   AppImage            -> reemplaza el archivo .AppImage (sin permisos de administrador si es tuyo)
//   .deb / .rpm         -> instala el paquete con pkexec (pide la contraseña de administrador)
//   NSIS (-setup.exe)   -> ejecuta el instalador en modo pasivo; la app se cierra sola
//   MSI                 -> msiexec en modo pasivo; la app se cierra sola
//   macOS (.app)        -> reemplaza la app
// Desconocido (compilación de desarrollo o instalación a mano): solo se avisa y se enlaza a Releases.
import { create } from "zustand";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { errorMessage } from "../../api/core";

export const REPO_URL = "https://github.com/LeoMael/TerView";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues/new`;

export type BundleKind = "appimage" | "deb" | "rpm" | "nsis" | "msi" | "app" | "unknown";

export const BUNDLE_LABEL: Record<BundleKind, string> = {
  appimage: "AppImage",
  deb: "Paquete .deb",
  rpm: "Paquete .rpm",
  nsis: "Instalador de Windows (-setup.exe)",
  msi: "Instalador de Windows (.msi)",
  app: "App de macOS",
  unknown: "Desconocido (desarrollo o instalación manual)",
};

export type UpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date: string | null;
  /** Notas de la versión (Markdown) publicadas en latest.json. */
  notes: string;
}

interface UpdaterState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  /** Bytes descargados / totales (null si el servidor no dice el tamaño). */
  progress: { done: number; total: number | null };
  error: string | null;
  lastCheck: number | null;
  bundle: BundleKind | null;
  /** Aviso flotante visible. */
  noticeOpen: boolean;
  setNoticeOpen: (v: boolean) => void;
}

export const useUpdater = create<UpdaterState>((set) => ({
  status: "idle",
  info: null,
  progress: { done: 0, total: null },
  error: null,
  lastCheck: null,
  bundle: null,
  noticeOpen: false,
  setNoticeOpen: (noticeOpen) => set({ noticeOpen }),
}));

/** Objeto de la actualización encontrada (recurso del motor; no va en el estado de React). */
let pending: Update | null = null;

/** Formato con el que se instaló la app. */
export async function detectBundle(): Promise<BundleKind> {
  const known = useUpdater.getState().bundle;
  if (known) return known;
  let kind: BundleKind = "unknown";
  try {
    const { getBundleType } = await import("@tauri-apps/api/app");
    const t = (await getBundleType()) as string | null | undefined;
    if (t === "appimage" || t === "deb" || t === "rpm" || t === "nsis" || t === "msi" || t === "app") kind = t;
  } catch {
    // Compilación de desarrollo o motor sin la información.
  }
  useUpdater.setState({ bundle: kind });
  return kind;
}

/** Si este formato se puede actualizar desde la app. */
export function canSelfUpdate(kind: BundleKind | null): boolean {
  return kind !== null && kind !== "unknown";
}

/** Si la instalación pedirá la contraseña de administrador del sistema. */
export function needsAdmin(kind: BundleKind | null): boolean {
  return kind === "deb" || kind === "rpm";
}

let checking: Promise<UpdateInfo | null> | null = null;

/**
 * Busca una versión nueva. `silent`: sin errores visibles (búsqueda automática al arrancar).
 * Devuelve la información de la actualización o null si ya está al día.
 */
export function checkForUpdates({ silent = false }: { silent?: boolean } = {}): Promise<UpdateInfo | null> {
  const st = useUpdater.getState().status;
  if (st === "downloading" || st === "installing" || st === "ready") return Promise.resolve(useUpdater.getState().info);
  checking ??= (async () => {
    useUpdater.setState({ status: "checking", error: null });
    try {
      await detectBundle();
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 20_000 });
      if (pending && pending !== update) void pending.close().catch(() => undefined);
      pending = update;
      if (!update) {
        useUpdater.setState({ status: "upToDate", info: null, lastCheck: Date.now() });
        return null;
      }
      const info: UpdateInfo = {
        version: update.version,
        currentVersion: update.currentVersion,
        date: update.date ?? null,
        // El cuerpo del Release lleva primero las novedades y, tras una línea `---`, la tabla de instaladores.
        notes: (update.body ?? "").split(/^\s*---\s*$/m)[0].trim(),
      };
      useUpdater.setState({ status: "available", info, lastCheck: Date.now() });
      return info;
    } catch (e) {
      // Sin red, sin latest.json publicado todavía o firma inválida.
      useUpdater.setState({
        status: silent ? "idle" : "error",
        error: friendlyError(e),
        lastCheck: Date.now(),
      });
      if (!silent) throw new Error(friendlyError(e));
      return null;
    } finally {
      checking = null;
    }
  })();
  return checking;
}

function friendlyError(e: unknown): string {
  const msg = errorMessage(e);
  if (/404|not found/i.test(msg)) return "No se encontró información de versiones en GitHub Releases.";
  if (/signature/i.test(msg)) return "La firma de la actualización no es válida; no se instalará.";
  if (/timed? ?out|dns|connect|network|request/i.test(msg)) return "No hay conexión con GitHub. Inténtalo más tarde.";
  return msg;
}

/** Descarga e instala la versión encontrada y reinicia la app. */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update) throw new Error("No hay ninguna actualización pendiente.");
  useUpdater.setState({ status: "downloading", progress: { done: 0, total: null }, error: null, noticeOpen: true });
  let done = 0;
  let lastPaint = 0;
  try {
    await update.download((ev: DownloadEvent) => {
      if (ev.event === "Started") {
        useUpdater.setState({ progress: { done: 0, total: ev.data.contentLength ?? null } });
      } else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        const now = performance.now();
        // Como mucho ~10 repintados por segundo.
        if (now - lastPaint > 100) {
          lastPaint = now;
          useUpdater.setState((s) => ({ progress: { done, total: s.progress.total } }));
        }
      } else {
        useUpdater.setState((s) => ({ progress: { done, total: s.progress.total ?? done } }));
      }
    });
    useUpdater.setState({ status: "installing" });
    // Windows: lanza el instalador y la app se cierra sola (el instalador la vuelve a abrir).
    await update.install();
    useUpdater.setState({ status: "ready" });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    useUpdater.setState({ status: "error", error: friendlyError(e) });
    throw new Error(friendlyError(e));
  }
}

// --- Preferencia "Buscar actualizaciones automáticamente" (en este equipo, no en los ajustes del motor) ---

const AUTO_KEY = "terview.updater.autoCheck";

export function getAutoCheck(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoCheck(v: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, v ? "1" : "0");
  } catch {
    // Almacenamiento no disponible: se queda en el valor por defecto.
  }
}
