// Ajustes → IA para explicar informes (opcional): un servicio compatible con OpenAI que solo EXPLICA los informes
// del escáner de vulnerabilidades. URL y modelo van en settings.json; el token, en la bóveda o el llavero.
import { useEffect, useState } from "react";
import { Check, KeyRound, PlugZap, Trash2 } from "lucide-react";
import { errorMessage } from "../../api/core";
import { settingsApi } from "../../api/profiles";
import { ai, type AiStatus } from "../../api/vulnscan";
import { useLock } from "../../features/lock/lockStore";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import "./AiSection.css";
import { SettingGroup, SettingRow as Row } from "../ui/SettingsKit";

/** Aviso si la URL no es https (salvo en este equipo). Lo mismo comprueba el motor. */
function urlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return "URL no válida";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(p.hostname);
  if (p.protocol === "http:" && !local) return "Usa https:// (http solo para localhost)";
  if (p.protocol !== "https:" && p.protocol !== "http:") return "Debe empezar por https://";
  return null;
}

export function AiSection() {
  const conf = useSettings((s) => s.settings.ai);
  const update = useSettings((s) => s.update);
  const locked = useLock((s) => !!s.status?.locked);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const set = (patch: Partial<typeof conf>) => update({ ai: { ...conf, ...patch } });

  const refresh = () =>
    ai.status().then(setStatus, (e) => {
      setStatus(null);
      toast.error("No se pudo leer el token de IA", e);
    });
  useEffect(() => {
    void refresh();
  }, [locked]);

  const saveToken = async (value: string | null) => {
    setBusy(true);
    try {
      await ai.setToken(value);
      setToken("");
      toast.success(value ? "Token guardado" : "Token borrado");
      await refresh();
    } catch (e) {
      toast.error("No se pudo guardar el token", e);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setModels(null);
    setTestError(null);
    try {
      // «Probar» usa los ajustes guardados: se guardan ya (sin esperar al guardado diferido).
      await settingsApi.save(useSettings.getState().settings);
      const list = await ai.test();
      setModels(list);
    } catch (e) {
      setTestError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const problem = urlProblem(conf.baseUrl);

  return (
    <SettingGroup hint="Antes de enviar verás el texto (sin nombre ni IP); nunca ejecuta nada.">
      <Row label="Activar" hint="Muestra «Explicar con IA» en Vulnerabilidades.">
        <button
          role="switch"
          aria-checked={conf.enabled}
          aria-label="Activar la IA para explicar informes"
          className={conf.enabled ? "st-switch on" : "st-switch"}
          onClick={() => set({ enabled: !conf.enabled })}
        >
          <span />
        </button>
      </Row>
      <Row label="URL base" hint="Compatible con OpenAI (o un Ollama local).">
        <input
          className="input"
          value={conf.baseUrl}
          placeholder="https://api.openai.com/v1"
          title="p. ej. https://api.openai.com/v1 o http://localhost:11434/v1 (Ollama)"
          spellCheck={false}
          onChange={(e) => set({ baseUrl: e.target.value })}
          aria-invalid={!!problem}
        />
      </Row>
      {problem && <div className="st-block field-error">{problem}</div>}
      <Row label="Modelo">
        <input className="input" value={conf.model} placeholder="gpt-4o-mini, llama3.1…" spellCheck={false} onChange={(e) => set({ model: e.target.value })} />
      </Row>
      <Row
        label="Token"
        hint={locked ? "SSHorus está bloqueado: desbloquéalo para cambiarlo." : "Se guarda cifrado. Ollama local no lo necesita."}
      >
        <div className="st-ai-token">
          {status?.hasToken && (
            <span className="st-ai-ok">
              <Check size={13} /> Hay uno guardado
            </span>
          )}
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={token}
            disabled={locked || busy}
            placeholder={status?.hasToken ? "Escribe otro para cambiarlo" : "Pega aquí el token"}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="btn btn-sm" disabled={locked || busy || !token.trim()} onClick={() => void saveToken(token)}>
            <KeyRound size={13} /> Guardar
          </button>
          {status?.hasToken && (
            <button className="btn btn-sm" disabled={locked || busy} onClick={() => void saveToken(null)} title="Borrar el token guardado">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </Row>
      <Row label="Probar">
        <button
          className="btn btn-sm"
          onClick={() => void test()}
          disabled={busy || locked || !conf.baseUrl.trim() || !!problem}
          title="Pide la lista de modelos (GET <URL base>/models)."
        >
          {busy ? <span className="spinner adm-spinner-btn" /> : <PlugZap size={13} />} Probar conexión
        </button>
      </Row>
      {testError && <div className="st-block field-error">{testError}</div>}
      {models && (
        <div className="st-block st-hint">
          Conexión correcta.{" "}
          {models.length
            ? models.includes(conf.model)
              ? `El modelo «${conf.model}» está disponible.`
              : `Modelos disponibles: ${models.slice(0, 30).join(", ")}${models.length > 30 ? "…" : ""}`
            : "El servicio no devolvió modelos."}
        </div>
      )}
    </SettingGroup>
  );
}
