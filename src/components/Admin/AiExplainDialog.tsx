// «Explicar con IA»: primero se enseña el texto EXACTO que se enviará (con casillas para quitar partes);
// solo se envía al confirmar. La respuesta se marca como texto de IA y sus comandos solo se copian o se
// escriben en la terminal sin Enter. La tabla de hallazgos nunca la toca la IA.
import { useMemo, useRef, useState } from "react";
import { Bot, Send, Sparkles, Square } from "lucide-react";
import { errorMessage, isApiError } from "../../api/core";
import { newExecId } from "../../api/snippets";
import { ai, vulnscan, type Report } from "../../api/vulnscan";
import { buildAiMessages, buildAiPayload, DEFAULT_AI_OPTIONS, type AiPayloadOptions } from "../../features/vulnscan";
import { useSettings } from "../../stores/settings";
import { AdmModal } from "./AdmModal";
import { MiniMarkdown } from "./MiniMarkdown";
import { CommandActions } from "./vulnUi";

export function AiAnswer({ report, sessionId }: { report: Report; sessionId: string }) {
  if (!report.ai) return null;
  return (
    <div className="vs-ai-answer">
      <div className="vs-ai-mark">
        <Bot size={13} /> Texto generado por IA ({report.ai.model}): revísalo. La lista de vulnerabilidades no sale de aquí.
      </div>
      <MiniMarkdown text={report.ai.text} codeActions={(code) => <CommandActions sessionId={sessionId} text={code} />} />
    </div>
  );
}

export function AiExplainDialog({
  report,
  profileId,
  onDone,
  onClose,
}: {
  report: Report;
  profileId: string;
  onDone: (r: Report) => void;
  onClose: () => void;
}) {
  const settings = useSettings((s) => s.settings.ai);
  const [opts, setOpts] = useState<AiPayloadOptions>(DEFAULT_AI_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef<string | null>(null);
  const messages = useMemo(() => buildAiMessages(report, opts), [report, opts]);
  const payload = useMemo(() => buildAiPayload(report, opts), [report, opts]);
  const preview = messages.map((m) => `── ${m.role === "system" ? "Instrucciones (system)" : "Mensaje (user)"} ──\n${m.content}`).join("\n\n");
  const hasImages = report.targets.some((t) => t.kind === "image");
  const hasRuntimes = report.targets.some((t) => t.kind === "runtime");

  const send = async () => {
    const id = newExecId();
    reqId.current = id;
    setBusy(true);
    setError(null);
    try {
      const r = await ai.chat(messages, id);
      const saved = await vulnscan.setAi(profileId, report.id, { model: r.model, createdAt: new Date().toISOString(), text: r.text });
      onDone(saved);
      onClose();
    } catch (e) {
      if (!isApiError(e, "Canceled")) setError(errorMessage(e));
    } finally {
      reqId.current = null;
      setBusy(false);
    }
  };
  const cancel = () => {
    if (reqId.current) void ai.cancel(reqId.current);
  };
  const box = (k: keyof AiPayloadOptions, label: string, disabled = false) => (
    <label className="checkbox">
      <input type="checkbox" checked={opts[k]} disabled={disabled || busy} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <AdmModal title="Explicar con IA: esto es lo que se enviará" onClose={busy ? cancel : onClose} width={760}>
      <div className="modal-body vs-ai-body">
        <p className="faint">
          Se enviará a <span className="mono">{settings.baseUrl || "(sin URL)"}</span> con el modelo{" "}
          <span className="mono">{settings.model || "(sin modelo)"}</span>. El servidor se llama «servidor-1»: no van su
          nombre, IP, usuarios, rutas, nombres de contenedores ni contraseñas.
        </p>
        <div className="vs-ai-opts">
          {box("includeSystem", "Paquetes del sistema")}
          {box("includeRuntimes", "Programas sueltos", !hasRuntimes)}
          {box("includeImages", "Imágenes", !hasImages)}
          {box("hideImageNames", "Ocultar también los nombres de imagen", !hasImages || !opts.includeImages)}
          {box("includeUnimportant", "Incluir lo que la distro considera sin importancia")}
        </div>
        <div className="faint">
          {payload.included} de {payload.available} hallazgos (como mucho 60, los más graves primero).
        </div>
        <pre className="mono vs-ai-preview" tabIndex={0} aria-label="Texto exacto que se enviará">
          {preview}
        </pre>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="modal-footer">
        {busy ? (
          <button className="btn" onClick={cancel}>
            <Square size={13} /> Cancelar
          </button>
        ) : (
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
        )}
        <button className="btn btn-primary" onClick={() => void send()} disabled={busy || payload.included === 0}>
          {busy ? <span className="spinner adm-spinner-btn" /> : report.ai ? <Sparkles size={13} /> : <Send size={13} />}
          {busy ? "Esperando a la IA…" : report.ai ? "Enviar de nuevo" : "Enviar"}
        </button>
      </div>
    </AdmModal>
  );
}
