// Estado vacío: el servidor no tiene Podman ni Docker. Instrucciones según la distro.
import { Boxes, Copy, RefreshCw, TerminalSquare } from "lucide-react";
import { installHints } from "../../features/containers";
import type { PrivilegeInfo } from "../../features/privileges";
import { clipboard } from "../../lib/clipboard";
import { sendToTerminal, hasTerminal } from "../../stores/terminalBus";
import { toast } from "../../stores/toasts";

interface Props {
  info: PrivilegeInfo | null;
  dockerIsShim: boolean;
  busy: boolean;
  sessionId: string;
  onRetry: () => void;
}

export function NoEngine({ info, dockerIsShim, busy, sessionId, onRetry }: Props) {
  const { distro, hints } = installHints(info?.distroId ?? null, info?.distroLike ?? []);
  const asRoot = info?.level === "root";
  const fix = (cmd: string) => (asRoot ? cmd.replace(/\bsudo /g, "").replace(/\bdoas /g, "") : cmd);

  return (
    <div className="ct-noengine">
      <Boxes size={34} className="ct-noengine-icon" />
      <h3>Este servidor no tiene Podman ni Docker</h3>
      <p className="muted">
        {dockerIsShim
          ? "El comando «docker» existe, pero es el emulador de Podman y Podman no responde."
          : `Instala uno de los dos para administrar contenedores desde aquí. Instrucciones para ${distro}:`}
      </p>
      <div className="ct-hints">
        {hints.map((h) => {
          const cmd = fix(h.command);
          return (
            <div key={h.title} className="ct-hint">
              <div className="ct-hint-title">{h.title}</div>
              <pre className="ct-cmd">{cmd}</pre>
              {h.note && <div className="faint ct-hint-note">{h.note}</div>}
              <div className="ct-hint-actions">
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    clipboard.write(cmd).then(
                      () => toast.success("Comando copiado"),
                      (e) => toast.error("No se pudo copiar", e),
                    )
                  }
                >
                  <Copy size={13} /> Copiar
                </button>
                <button
                  className="btn btn-sm"
                  title="Lo escribe en la terminal sin ejecutarlo: revísalo y pulsa Enter"
                  onClick={() => {
                    if (!hasTerminal(sessionId)) toast.error("No hay ninguna terminal abierta", "Abre una terminal en esta conexión");
                    else if (sendToTerminal(sessionId, cmd, false)) toast.info("Escrito en la terminal", "Revisa el comando y pulsa Enter");
                  }}
                >
                  <TerminalSquare size={13} /> Escribir en la terminal
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button className="btn" onClick={onRetry} disabled={busy}>
        {busy ? <span className="spinner ct-spinner-sm" /> : <RefreshCw size={13} />} Volver a comprobar
      </button>
    </div>
  );
}
