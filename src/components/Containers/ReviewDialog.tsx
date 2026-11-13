// Revisión de una acción antes de ejecutarla: opciones, comando exacto, confirmación y resultado.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, KeyRound, Play } from "lucide-react";
import { displayCmds, runEngine, type Cmd, type EngineRun } from "../../features/containers";
import { wrapScript, type Elevation } from "../../features/privileges";
import { scriptFor } from "../../features/containers/run";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { AdmModal } from "../Admin/AdmModal";
import type { ReviewRequest } from "./context";

function elevationText(el: Elevation | null): string {
  switch (el?.kind) {
    case "root":
      return "Se ejecutará como root:";
    case "nopasswd":
      return `Se ejecutará con ${el.tool} (sin contraseña):`;
    case "password":
      return "Se ejecutará con sudo. Tu contraseña se envía por la entrada estándar, nunca en el comando:";
    default:
      return "Se ejecutará:";
  }
}

interface Props {
  req: ReviewRequest;
  sessionId: string;
  /** Ejecuta como el dueño de cada comando (lo da el panel). */
  exec: (cmds: Cmd[], timeoutSecs: number) => Promise<EngineRun>;
  /** Elevación de esos comandos (null = falta sudo). */
  elevationOf: (cmds: Cmd[]) => Elevation | null;
  /** Comando tal y como se muestra. */
  render: (c: Cmd) => string;
  /** Script completo enviado al servidor (sin secretos). */
  fullScript: (cmds: Cmd[]) => Promise<string>;
  /** Usuarios (que no son tú) con los que se ejecuta, o null. */
  who: (cmds: Cmd[]) => string | null;
  disabled: boolean;
  onAskSudo: () => void;
  onClose: () => void;
  onFinished: (req: ReviewRequest, r: EngineRun) => void;
}

export function ReviewDialog({ req, sessionId, exec, elevationOf, render, fullScript, who, disabled, onAskSudo, onClose, onFinished }: Props) {
  const [opts, setOpts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((req.options ?? []).map((o) => [o.key, o.initial ?? false])),
  );
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needSudo, setNeedSudo] = useState(false);

  // `elevationOverride`: comandos del sistema (systemctl, usermod), no del motor: siempre con esa elevación.
  const override = req.elevationOverride !== undefined;
  const cmds = useMemo(() => req.build(opts), [req, opts]);
  const el = override ? (req.elevationOverride ?? null) : elevationOf(cmds);
  const shown = override ? (el ? displayCmds(cmds, el) : cmds.map((c) => displayCmds([c], { kind: "none" })[0])) : cmds.map(render);
  const asUser = override ? null : who(cmds);
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (override) setFull(el && el.kind !== "none" ? wrapScript(scriptFor(cmds), el) : null);
    else if (el && (el.kind !== "none" || asUser))
      fullScript(cmds).then(
        (t) => alive && setFull(t),
        () => alive && setFull(null),
      );
    else setFull(null);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmds, el?.kind, override, asUser]);
  const blocked = !el || disabled || busy || cmds.length === 0 || (req.confirmWord !== undefined && typed !== req.confirmWord);

  const run = async () => {
    if (!el || blocked) return;
    setBusy(true);
    setError(null);
    setNeedSudo(false);
    const r = override ? await runEngine(sessionId, cmds, el, req.timeoutSecs ?? 120) : await exec(cmds, req.timeoutSecs ?? 120);
    setBusy(false);
    if (r.ok) {
      onFinished(req, r);
      onClose();
    } else {
      setError(r.error);
      setNeedSudo(r.needSudo);
    }
  };

  return (
    <AdmModal title={req.title} onClose={busy ? () => {} : onClose} width={600}>
      <div className="modal-body ct-review">
        {req.message && <div className="dialog-message">{req.message}</div>}
        {req.options && req.options.length > 0 && (
          <div className="ct-review-opts">
            {req.options.map((o) => (
              <label key={o.key} className="checkbox" title={o.hint}>
                <input
                  type="checkbox"
                  checked={!!opts[o.key]}
                  disabled={busy}
                  onChange={(e) => setOpts((s) => ({ ...s, [o.key]: e.target.checked }))}
                />
                <span>{o.label}</span>
                {o.hint && <span className="faint ct-review-hint">{o.hint}</span>}
              </label>
            ))}
          </div>
        )}
        {req.details && <div className="ct-review-details">{req.details(opts)}</div>}
        {asUser && (
          <div className="ct-review-label">
            Como el usuario <strong>{asUser}</strong> (con su carpeta personal y su sesión de Podman/Docker).
          </div>
        )}
        <div className="ct-review-label">
          {elevationText(el)}
          <button
            className="icon-btn"
            title="Copiar comando"
            aria-label="Copiar comando"
            onClick={() => {
              clipboard.write(shown.join("\n")).then(
                () => toast.success("Comando copiado"),
                (e) => toast.error("No se pudo copiar", e),
              );
            }}
          >
            <Copy size={13} />
          </button>
        </div>
        <pre className="ct-cmd" aria-label="Comando que se ejecutará">
          {shown.join("\n")}
        </pre>
        {full && (
          <details className="ct-details">
            <summary>Script completo enviado al servidor</summary>
            <pre className="ct-cmd ct-cmd-sm">{full}</pre>
          </details>
        )}
        {!el && <div className="ct-warn">Hace falta sudo para ejecutar esto.</div>}
        {req.confirmWord !== undefined && (
          <label className="field ct-confirm-word">
            <span>
              Para confirmar, escribe <strong className="mono">{req.confirmWord}</strong>
            </span>
            <input
              className="input mono"
              value={typed}
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void run()}
              autoComplete="off"
              spellCheck={false}
              aria-label={`Escribe ${req.confirmWord} para confirmar`}
            />
          </label>
        )}
        {error && (
          <div className="ct-error" role="alert">
            <AlertTriangle size={14} />
            <pre>{error}</pre>
          </div>
        )}
        {(needSudo || !el) && (
          <button className="btn btn-sm" onClick={onAskSudo}>
            <KeyRound size={13} /> Introducir contraseña de sudo
          </button>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onClose} disabled={busy}>
          {error ? "Cerrar" : "Cancelar"}
        </button>
        <button
          className={req.danger ? "btn btn-danger" : "btn btn-primary"}
          onClick={() => void run()}
          disabled={blocked}
          autoFocus={req.confirmWord === undefined}
        >
          {busy ? <span className="spinner ct-spinner-sm" /> : <Play size={13} />}
          {error ? "Reintentar" : (req.runLabel ?? "Ejecutar")}
        </button>
      </div>
    </AdmModal>
  );
}
