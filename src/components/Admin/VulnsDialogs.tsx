// Diálogos de «Vulnerabilidades»: qué se envía a OSV, historial, exportar, usuarios y opciones.
import { useEffect, useState } from "react";
import { FileDown, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "../../api/core";
import { vulnscan, type Report, type ReportMeta, type UsersView, type VulnScanSettings } from "../../api/vulnscan";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { confirmDialog } from "../ui/dialogs";
import { AdmModal } from "./AdmModal";

/** «Ver qué se envía»: el JSON de las consultas a OSV del último análisis. */
export function OsvSampleDialog({ report, onClose }: { report: Report | null; onClose: () => void }) {
  const sample = report?.osvSample ?? [];
  const json = JSON.stringify(
    { queries: sample.map((q) => ({ package: { ecosystem: q.ecosystem, name: q.name }, version: q.version })) },
    null,
    2,
  );
  return (
    <AdmModal title="Qué se envía a OSV.dev" onClose={onClose} width={620}>
      <div className="modal-body">
        <p>
          La petición sale de <strong>tu PC</strong> (OSV ve tu IP, no la del servidor) y solo lleva ecosistema, nombre y
          versión de cada paquete. Nunca el nombre ni la IP del servidor, usuarios, rutas ni nombres de contenedores.
        </p>
        {sample.length ? (
          <>
            <div className="faint">
              {sample.length} consultas{sample.length >= 1000 ? " (se muestran las 1000 primeras)" : ""} del análisis mostrado:
            </div>
            <pre className="mono vs-ai-preview">{json}</pre>
          </>
        ) : (
          <div className="faint">Este análisis no envió nada a OSV (desactivado, sin internet o sin paquetes que consultar).</div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </AdmModal>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es");
}

/** Historial de análisis del servidor. */
export function HistoryDialog({
  profileId,
  currentId,
  onOpen,
  onDeleted,
  onClose,
}: {
  profileId: string;
  currentId: string | null;
  onOpen: (r: Report) => void;
  onDeleted: (id: string | null) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<ReportMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    vulnscan.historyList(profileId).then(setList, (e) => setError(errorMessage(e)));
  };
  useEffect(load, [profileId]);

  const open = async (id: string) => {
    try {
      onOpen(await vulnscan.historyGet(profileId, id));
      onClose();
    } catch (e) {
      toast.error("No se pudo abrir el análisis", e);
    }
  };
  const remove = async (id: string | null) => {
    const ok = await confirmDialog({
      title: id ? "Borrar este análisis" : "Borrar todo el historial",
      message: id ? "Se borra del historial de este servidor." : "Se borran todos los análisis guardados de este servidor.",
      confirmText: "Borrar",
      danger: true,
    });
    if (!ok) return;
    try {
      await vulnscan.historyDelete(profileId, id ?? undefined);
      onDeleted(id);
      load();
    } catch (e) {
      toast.error("No se pudo borrar", e);
    }
  };

  return (
    <AdmModal title="Historial de análisis" onClose={onClose} width={680}>
      <div className="modal-body">
        {error && <div className="field-error">{error}</div>}
        {!list && !error && <span className="spinner" />}
        {list && list.length === 0 && <div className="faint">Todavía no hay análisis guardados de este servidor.</div>}
        {list && list.length > 0 && (
          <ul className="vs-hist">
            {list.map((m) => (
              <li key={m.id} className={m.id === currentId ? "on" : undefined}>
                <div className="vs-hist-main">
                  <strong>{fmtDate(m.createdAt)}</strong>
                  <span className="faint">
                    {m.distro} · {m.elevated ? "con sudo" : "sin sudo"} · {m.sources.join(", ") || "sin fuentes"}
                    {m.hasAi ? " · con explicación de IA" : ""}
                  </span>
                  <span>
                    <span className="vs-sev vs-sev-critical">{m.summary.critical}</span>{" "}
                    <span className="vs-sev vs-sev-high">{m.summary.high}</span>{" "}
                    <span className="vs-sev vs-sev-medium">{m.summary.medium}</span>{" "}
                    <span className="vs-sev vs-sev-low">{m.summary.low}</span>{" "}
                    <span className="faint">· {m.summary.withFix} con arreglo</span>
                  </span>
                </div>
                <button className="btn btn-sm" onClick={() => void open(m.id)} disabled={m.id === currentId}>
                  <FolderOpen size={12} /> {m.id === currentId ? "Abierto" : "Abrir"}
                </button>
                <button className="icon-btn" onClick={() => void remove(m.id)} aria-label="Borrar este análisis" title="Borrar">
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="faint">Se guardan los 20 últimos de cada servidor, en tu carpeta de configuración.</p>
      </div>
      <div className="modal-footer">
        {list && list.length > 0 && (
          <button className="btn adm-btn-danger-soft" onClick={() => void remove(null)}>
            <Trash2 size={13} /> Borrar todo
          </button>
        )}
        <span className="adm-spacer" />
        <button className="btn" onClick={load}>
          <RefreshCw size={13} /> Recargar
        </button>
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </AdmModal>
  );
}

/** Exportar a JSON o Markdown con el diálogo «Guardar» del sistema. */
export function ExportDialog({
  report,
  profileId,
  serverName,
  onClose,
}: {
  report: Report;
  profileId: string;
  serverName: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [hide, setHide] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const ext = format === "json" ? "json" : "md";
    const date = report.createdAt.slice(0, 10);
    let path: string | null;
    try {
      path = await saveFileDialog({
        title: "Exportar análisis de vulnerabilidades",
        defaultPath: `vulnerabilidades-${date}.${ext}`,
        filters: [{ name: format === "json" ? "JSON" : "Markdown", extensions: [ext] }],
      });
    } catch (e) {
      toast.error("No se pudo abrir el diálogo para guardar", e);
      return;
    }
    if (!path) return;
    if (!path.toLowerCase().endsWith(`.${ext}`)) path += `.${ext}`;
    setBusy(true);
    try {
      await vulnscan.export(profileId, report.id, path, format, hide ? null : serverName);
      toast.success("Análisis exportado", path);
      onClose();
    } catch (e) {
      toast.error("No se pudo exportar", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AdmModal title="Exportar análisis" onClose={onClose} width={440}>
      <div className="modal-body">
        <label className="checkbox">
          <input type="radio" name="vs-fmt" checked={format === "markdown"} onChange={() => setFormat("markdown")} />
          Markdown (resumen y tabla por gravedad, para leer o compartir)
        </label>
        <label className="checkbox">
          <input type="radio" name="vs-fmt" checked={format === "json"} onChange={() => setFormat("json")} />
          JSON (todos los datos, el mismo formato del historial)
        </label>
        <label className="checkbox adm-mt">
          <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
          Quitar el nombre del servidor (sale «servidor-1»)
        </label>
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button className="btn btn-primary" onClick={() => void go()} disabled={busy}>
          <FileDown size={13} /> Guardar…
        </button>
      </div>
    </AdmModal>
  );
}

/** Con sudo: de qué usuarios se miran los contenedores (se recuerda por servidor). */
export function UsersDialog({
  profileId,
  users,
  loading,
  error,
  onReload,
  onClose,
}: {
  profileId: string;
  users: UsersView | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onClose: () => void;
}) {
  const vs = useSettings((s) => s.settings.vulnscan);
  const update = useSettings((s) => s.update);
  const chosen = vs.usersByServer[profileId] ?? [];
  const all = chosen.length === 0;
  const setChosen = (list: string[]) => {
    const next = { ...vs.usersByServer };
    if (list.length) next[profileId] = list;
    else delete next[profileId];
    update({ vulnscan: { ...vs, usersByServer: next } });
  };
  const names = users?.users.map((u) => u.name) ?? [];
  const toggle = (name: string) => {
    const base = all ? names : chosen;
    const next = base.includes(name) ? base.filter((n) => n !== name) : [...base, name];
    setChosen(next.length === names.length ? [] : next.length ? next : [name]);
  };
  return (
    <AdmModal title="Contenedores de qué usuarios" onClose={onClose} width={480}>
      <div className="modal-body">
        <p className="faint">
          Con sudo se miran siempre los contenedores de root y, además, los de estos usuarios (cuentas con almacén de
          Podman o Docker rootless). La elección se recuerda para este servidor.
        </p>
        {loading && <span className="spinner" />}
        {error && <div className="field-error">{error}</div>}
        {users && (
          <>
            <label className="checkbox">
              <input type="checkbox" checked={all} onChange={() => setChosen([])} />
              Todos
            </label>
            {users.users.length === 0 && <div className="faint">Ningún usuario tiene contenedores propios.</div>}
            {users.users.map((u) => (
              <label key={u.name} className="checkbox vs-indent">
                <input type="checkbox" checked={all || chosen.includes(u.name)} onChange={() => toggle(u.name)} />
                {u.name}
                <span className="faint">
                  {[u.podman && "Podman", u.docker && "Docker rootless"].filter(Boolean).join(", ")}
                  {!u.runtimeDir ? " · sin sesión abierta" : ""}
                </span>
              </label>
            ))}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onReload} disabled={loading}>
          <RefreshCw size={13} /> Volver a buscar
        </button>
        <button className="btn btn-primary" onClick={onClose}>
          Listo
        </button>
      </div>
    </AdmModal>
  );
}

/** Opciones del escáner (en `settings.json`). */
export function OptionsDialog({ onClose }: { onClose: () => void }) {
  const vs = useSettings((s) => s.settings.vulnscan);
  const update = useSettings((s) => s.update);
  const set = (patch: Partial<VulnScanSettings>) => update({ vulnscan: { ...vs, ...patch } });
  const box = (k: "useOsv" | "useDistroTool" | "useTrivy" | "scanImages", label: string, hint: string) => (
    <label className="checkbox vs-opt" title={hint}>
      <input type="checkbox" checked={vs[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      <span>
        {label}
        <small className="faint">{hint}</small>
      </span>
    </label>
  );
  return (
    <AdmModal title="Opciones del análisis" onClose={onClose} width={500}>
      <div className="modal-body">
        {box("useOsv", "Consultar OSV.dev", "Desde tu PC; solo nombres y versiones de paquetes. Desactivado = solo herramientas del servidor.")}
        {box("useDistroTool", "Herramienta de la distro", "dnf, debsecan, pro o zypper en el servidor (bajan sus datos de la distro).")}
        {box("useTrivy", "Trivy, si está instalado", "Se prefiere para las imágenes. TerView no lo instala.")}
        {box("scanImages", "Imágenes de contenedores", "Se lee su lista de paquetes sin arrancar sus servicios.")}
        <label className="field adm-mt">
          <span>Máximo de imágenes por usuario</span>
          <input
            className="input"
            type="number"
            min={1}
            max={500}
            value={vs.imageLimit}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) set({ imageLimit: Math.min(500, Math.max(1, n)) });
            }}
          />
        </label>
      </div>
      <div className="modal-footer">
        <button className="btn btn-primary" onClick={onClose}>
          Listo
        </button>
      </div>
    </AdmModal>
  );
}
