// Diálogo pequeño de «Novedades»: lo esencial de la versión recién instalada.
import { BookOpen, Sparkles } from "lucide-react";
import { Modal } from "../../components/ui/Modal";
import { openManual, openSettingsAt } from "../../components/Settings/settingsNav";
import { useShowSetup } from "../lock/LockGate";
import { useLock } from "../lock/lockStore";
import { dismissWhatsNew, useWhatsNew } from "./whatsNew";
import "./WhatsNew.css";

export function WhatsNewDialog() {
  const notes = useWhatsNew((s) => s.notes);
  const status = useLock((s) => s.status);
  const setup = useShowSetup(true, status);
  // Nunca encima del bloqueo con PIN ni de la pantalla de «crea tu PIN»: espera a que se quiten.
  if (!notes || !status || status.locked || setup) return null;

  const unreleased = /sin publicar|unreleased/i.test(notes.version);
  const title = unreleased ? "Novedades (versión en desarrollo)" : `Novedades de SSHorus ${notes.version}`;
  const thenOpen = (fn: () => void) => () => {
    dismissWhatsNew();
    fn();
  };

  return (
    <Modal
      open
      title={title}
      onClose={dismissWhatsNew}
      width="min(520px, 92vw)"
      footer={
        <>
          <button className="btn" onClick={thenOpen(openManual)}>
            <BookOpen size={14} /> Ver el manual
          </button>
          <button className="btn btn-primary" onClick={dismissWhatsNew} autoFocus>
            Entendido
          </button>
        </>
      }
    >
      <div className="wn-root">
        <p className="wn-intro">
          <Sparkles size={15} className="wn-intro-icon" />
          <span>
            {unreleased ? "Esto es lo nuevo de la próxima versión:" : "SSHorus se ha actualizado. Esto es lo nuevo:"}
          </span>
        </p>
        {notes.groups.map((g, i) => (
          <section key={i} className="wn-group">
            {g.label && <div className="section-label">{g.label}</div>}
            <ul className="wn-list">
              {g.items.map((it, j) => (
                <li key={j}>
                  <span className="wn-item-title">{it.title}</span>
                  {it.summary && <span className="wn-item-summary">{it.summary}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="wn-more">
          {notes.hidden > 0 && `Y ${notes.hidden} ${notes.hidden === 1 ? "cambio" : "cambios"} más. `}
          <button className="wn-link" onClick={thenOpen(() => openSettingsAt("about"))}>
            Ver todos los detalles
          </button>
        </p>
      </div>
    </Modal>
  );
}
