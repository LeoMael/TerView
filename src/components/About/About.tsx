// Acerca de: logo, versiones, enlaces, actualizaciones y novedades (CHANGELOG.md incluido en la app).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bug, CircleCheck, Download, ExternalLink, FolderGit2, RefreshCw, Tag } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import changelogSource from "../../../CHANGELOG.md?raw";
import { Logo } from "../ui/Logo";
import { formatBytes } from "../../lib/format";
import { appDiagnostics, type AppDiagnostics } from "../Diagnostics/diagnostics";
import {
  BUNDLE_LABEL,
  canSelfUpdate,
  checkForUpdates,
  detectBundle,
  ISSUES_URL,
  needsAdmin,
  RELEASES_URL,
  REPO_URL,
  useUpdater,
} from "../../features/updater/updater";
import { startInstall } from "../../features/updater/UpdateNotice";
import { Markdown, splitChangelog } from "./markdown";
import "./About.css";

const OS_LABEL: Record<string, string> = { linux: "Linux", windows: "Windows", macos: "macOS" };

interface Versions {
  app: string;
  tauri: string;
}

function useVersions(): { v: Versions | null; sys: AppDiagnostics | null } {
  const [v, setV] = useState<Versions | null>(null);
  const [sys, setSys] = useState<AppDiagnostics | null>(null);
  useEffect(() => {
    let alive = true;
    void import("@tauri-apps/api/app")
      .then((m) => Promise.all([m.getVersion(), m.getTauriVersion()]))
      .then(([app, tauri]) => alive && setV({ app, tauri }))
      .catch(() => alive && setV({ app: "?", tauri: "?" }));
    appDiagnostics().then(
      (d) => alive && setSys(d),
      () => undefined,
    );
    void detectBundle();
    return () => {
      alive = false;
    };
  }, []);
  return { v, sys };
}

export function AboutHeader() {
  const { v, sys } = useVersions();
  const bundle = useUpdater((s) => s.bundle);
  const system = sys ? `${sys.osName ?? OS_LABEL[sys.os] ?? sys.os} · ${sys.arch}` : "…";
  return (
    <div className="ab-header">
      <Logo size={44} withName />
      <div className="ab-version">
        Versión <strong>{v?.app ?? "…"}</strong>
        {sys?.debugBuild && <span className="ab-badge">desarrollo</span>}
      </div>
      <p className="ab-tagline">Cliente SSH/SFTP de escritorio.</p>
      <dl className="ab-facts">
        <dt>Tauri</dt>
        <dd>{v?.tauri ?? "…"}</dd>
        <dt>Motor de la ventana</dt>
        <dd>{sys ? (sys.webviewVersion ?? "desconocido") : "…"}</dd>
        <dt>Sistema</dt>
        <dd>{system}</dd>
        <dt>Instalado como</dt>
        <dd>{bundle ? BUNDLE_LABEL[bundle] : "…"}</dd>
      </dl>
      <div className="ab-links">
        <button className="btn" onClick={() => void openUrl(REPO_URL)}>
          <FolderGit2 size={14} /> Repositorio
        </button>
        <button className="btn" onClick={() => void openUrl(RELEASES_URL)}>
          <Tag size={14} /> Versiones y descargas
        </button>
        <button className="btn" onClick={() => void openUrl(ISSUES_URL)} title="Adjunta el informe de Avanzado → Diagnóstico">
          <Bug size={14} /> Reportar un problema
        </button>
      </div>
    </div>
  );
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.round(m / 60)} h`;
}

/** Estado de actualizaciones y botón «Buscar actualizaciones». */
export function UpdatesBox() {
  const status = useUpdater((s) => s.status);
  const info = useUpdater((s) => s.info);
  const error = useUpdater((s) => s.error);
  const lastCheck = useUpdater((s) => s.lastCheck);
  const bundle = useUpdater((s) => s.bundle);
  const progress = useUpdater((s) => s.progress);

  const checkingNow = status === "checking";
  const busy = status === "downloading" || status === "installing" || status === "ready";
  const pct = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  let line: ReactNode;
  if (checkingNow) line = "Buscando…";
  else if (status === "upToDate") line = (
    <>
      <CircleCheck size={14} className="ab-ok" /> Tienes la última versión{lastCheck ? ` (comprobado ${ago(lastCheck)})` : ""}.
    </>
  );
  else if (status === "error") line = <span className="ab-error">{error}</span>;
  else if (info) line = (
    <>
      <Download size={14} className="ab-accent" /> Hay una versión nueva: <strong>{info.version}</strong>
    </>
  );
  else line = "Busca si hay una versión nueva publicada en GitHub.";

  return (
    <div className="ab-updates">
      <div className="ab-updates-row">
        <div className="ab-updates-status">{line}</div>
        <button className="btn" onClick={() => void checkForUpdates().catch(() => undefined)} disabled={checkingNow || busy}>
          {checkingNow ? <span className="spinner" /> : <RefreshCw size={14} />} Buscar actualizaciones
        </button>
      </div>

      {info && (
        <div className="ab-update-card">
          <div className="ab-update-title">
            <strong>TerView {info.version}</strong>
            {info.date && <span className="ab-muted">{new Date(info.date).toLocaleDateString("es")}</span>}
          </div>
          {info.notes.trim() ? (
            <Markdown source={info.notes} className="ab-md ab-md-notes" />
          ) : (
            <p className="ab-muted">Sin notas de la versión.</p>
          )}
          {busy ? (
            <div className="ab-progress">
              <div className="progress">
                <div style={{ width: `${pct ?? (status === "downloading" ? 30 : 100)}%` }} />
              </div>
              <span className="ab-muted">
                {status === "downloading" && (pct !== null ? `Descargando… ${pct} % de ${formatBytes(progress.total ?? 0)}` : "Descargando…")}
                {status === "installing" && (needsAdmin(bundle) ? "Instalando… (puede pedir tu contraseña de administrador)" : "Instalando…")}
                {status === "ready" && "Reiniciando…"}
              </span>
            </div>
          ) : canSelfUpdate(bundle) ? (
            <div className="ab-update-actions">
              <button className="btn btn-primary" onClick={() => void startInstall()}>
                <RefreshCw size={14} /> Actualizar y reiniciar
              </button>
              {needsAdmin(bundle) && <span className="ab-muted">Se pedirá tu contraseña de administrador para instalar el paquete.</span>}
            </div>
          ) : (
            <div className="ab-update-actions">
              <button className="btn btn-primary" onClick={() => void openUrl(`${RELEASES_URL}/latest`)}>
                <ExternalLink size={14} /> Ir a descargas
              </button>
              <span className="ab-muted">Esta instalación no se actualiza sola: descarga el instalador nuevo.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Historial de cambios incluido en la app (CHANGELOG.md). */
export function ChangelogView() {
  const releases = useMemo(() => splitChangelog(changelogSource).filter((r) => r.body.trim()), []);
  return (
    <div className="ab-changelog">
      {releases.map((r, i) => {
        const unreleased = /sin publicar|unreleased/i.test(r.version);
        return (
          <details key={r.version} className="ab-release" open={i === 0 || (i === 1 && /sin publicar/i.test(releases[0].version))}>
            <summary>
              <span className="ab-release-version">{unreleased ? "Próxima versión (en desarrollo)" : `Versión ${r.version}`}</span>
              {r.date && <span className="ab-muted">{r.date}</span>}
            </summary>
            <Markdown source={r.body} className="ab-md" />
          </details>
        );
      })}
    </div>
  );
}
