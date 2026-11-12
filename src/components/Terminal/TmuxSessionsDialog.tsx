// «Sesiones en el servidor»: terminales persistentes (tmux) de TerView que siguen vivas en el servidor,
// por ejemplo tras cerrar la app. Se pueden reabrir en una terminal nueva o cerrar.
import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { confirmDialog } from "../ui/dialogs";
import { terminal } from "../../api/terminal";
import { errorMessage } from "../../api/core";
import type { TmuxList } from "../../api/types";
import { toast } from "../../stores/toasts";
import { clipboard } from "../../lib/clipboard";
import { ago, allOpenTmuxNames, installCommandFor, killTmuxSessions, leftoverSessions, manualAttachCommand } from "../../features/tmux";

interface Props {
  sessionId: string;
  /** Abrir la sesión en una terminal nueva de esta pestaña. */
  onOpen: (name: string) => void;
  onClose: () => void;
}

export function TmuxSessionsDialog({ sessionId, onOpen, onClose }: Props) {
  const [list, setList] = useState<TmuxList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await terminal.tmuxList(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openHere = allOpenTmuxNames();
  const sessions = list?.sessions ?? [];
  const loose = leftoverSessions(sessions, openHere);

  const kill = async (names: string[], what: string) => {
    const ok = await confirmDialog({
      title: names.length === 1 ? "Cerrar sesión" : "Cerrar sesiones",
      message: `Se terminará ${what} y todo lo que esté corriendo dentro. No se puede deshacer.`,
      confirmText: "Cerrar",
      danger: true,
    });
    if (!ok) return;
    setBusy(names.length === 1 ? names[0] : "*");
    const done = await killTmuxSessions(sessionId, names, 8000);
    setBusy(null);
    if (!done) toast.error("No se pudieron cerrar las sesiones", "El servidor no respondió a tiempo.");
    await load();
  };

  const copyAttach = (name: string) => {
    clipboard
      .write(manualAttachCommand(name))
      .then(() => toast.success("Comando copiado", manualAttachCommand(name)))
      .catch((e) => toast.error("No se pudo copiar", e));
  };

  return (
    <Modal
      open
      title="Terminales persistentes en el servidor"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} /> Actualizar
          </button>
          <div style={{ flex: 1 }} />
          {loose.length > 1 && (
            <button
              className="btn btn-danger"
              disabled={busy !== null}
              onClick={() => void kill(loose.map((s) => s.name), `${loose.length} sesiones que no están abiertas aquí`)}
            >
              Cerrar las {loose.length} sueltas
            </button>
          )}
          <button className="btn btn-primary" onClick={onClose}>
            Listo
          </button>
        </>
      }
    >
      <p className="term-tmux-intro">
        Cada terminal persistente vive en una sesión tmux del servidor y sigue corriendo aunque se corte la conexión o
        cierres TerView. Aquí ves las de este usuario: reábrelas o ciérralas para que no se acumulen.
      </p>
      {loading && !list && (
        <div className="term-tmux-empty">
          <span className="spinner" /> Buscando sesiones…
        </div>
      )}
      {error && <div className="term-tmux-empty term-tmux-error">No se pudo consultar el servidor: {error}</div>}
      {list && !list.installed && (
        <div className="term-tmux-empty">
          tmux no está instalado en este servidor. Para instalarlo ({installCommandFor(sessionId).distro}):
          <pre className="mono term-tmux-cmd">{installCommandFor(sessionId).command}</pre>
        </div>
      )}
      {list && list.installed && sessions.length === 0 && (
        <div className="term-tmux-empty">No hay terminales persistentes de TerView en este servidor.</div>
      )}
      {sessions.length > 0 && (
        <ul className="term-tmux-list" aria-busy={loading}>
          {sessions.map((s) => {
            const here = openHere.has(s.name);
            return (
              <li key={s.name} className="term-tmux-row">
                <div className="term-tmux-main">
                  <div className="term-tmux-name">
                    <span className="mono">{s.name}</span>
                    {here ? (
                      <span className="term-tmux-chip here">Abierta aquí</span>
                    ) : s.attached > 0 ? (
                      <span className="term-tmux-chip" title="Otra ventana o equipo la está mirando">
                        En uso
                      </span>
                    ) : (
                      <span className="term-tmux-chip loose">Suelta</span>
                    )}
                  </div>
                  <div className="term-tmux-meta">
                    <span className="mono">{s.command || "—"}</span>
                    <span className="term-tmux-path mono" title={s.path}>
                      {s.path}
                    </span>
                    <span title={s.activity ? new Date(s.activity * 1000).toLocaleString() : undefined}>
                      actividad {ago(s.activity)}
                    </span>
                  </div>
                </div>
                <button
                  className="icon-btn"
                  title={`Copiar comando para engancharse desde otra terminal (${manualAttachCommand(s.name)})`}
                  aria-label="Copiar comando para engancharse"
                  onClick={() => copyAttach(s.name)}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="btn btn-sm"
                  disabled={here}
                  title={here ? "Ya está abierta en una terminal de TerView" : "Abrir en una terminal nueva"}
                  onClick={() => {
                    onOpen(s.name);
                    onClose();
                  }}
                >
                  <ExternalLink size={13} /> Abrir
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  title="Terminar la sesión y lo que corre dentro"
                  onClick={() => void kill([s.name], `«${s.name}»`)}
                >
                  <Trash2 size={13} /> Cerrar
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
