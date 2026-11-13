// Ajustes → Terminal local e IA: qué contexto reciben Claude Code y Codex al abrirlos desde TerView,
// por qué vía trabajan (ssh directo, MCP o las dos), la carpeta de trabajo y si están instalados.
import { useEffect, useState, type ReactNode } from "react";
import { Bot, Check, Eye, FolderOpen, Home } from "lucide-react";
import { localTerm, type AiToolInfo } from "../../api/localterm";
import type { LocalAiMode, LocalAiSettings } from "../../api/types";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { chooseFolder, launchAssistant, previewContext } from "../../features/localterm/launch";
import { openSettingsAt } from "./settingsNav";
import "../../features/localterm/LocalTerm.css";

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "st-switch on" : "st-switch"}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

const MODES: { v: LocalAiMode; label: string }[] = [
  { v: "both", label: "Las dos" },
  { v: "direct", label: "Solo ssh" },
  { v: "mcp", label: "Solo MCP" },
];

const MODE_HINT: Record<LocalAiMode, string> = {
  both: "El asistente recibe los alias de ssh y, si está activo, el MCP de TerView. Elige la vía que mejor maneje.",
  direct: "Solo ssh directo con los alias de ~/.ssh/config. Los servidores con contraseña no le servirán.",
  mcp: "Solo el MCP de TerView (con tus permisos y aprobaciones). Si el MCP está apagado, te preguntará al abrir.",
};

const INCLUDE: { key: keyof LocalAiSettings; label: string; hint: string }[] = [
  { key: "includeServers", label: "Lista de servidores", hint: "Nombre, alias de ssh, usuario, proyecto, método de acceso y acceso por MCP." },
  { key: "includeHosts", label: "Host y puerto", hint: "La dirección de cada servidor. Sin esto, solo el alias." },
  { key: "includeProjects", label: "Proyectos", hint: "Qué servidores van juntos." },
  { key: "includeActive", label: "Servidor que estabas mirando", hint: "La última pestaña de servidor y su carpeta." },
  { key: "includeDate", label: "Fecha de hoy", hint: "" },
];

export function LocalAiSection() {
  const local = useSettings((s) => s.settings.localAi);
  const update = useSettings((s) => s.update);
  const [tools, setTools] = useState<AiToolInfo[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const set = (patch: Partial<LocalAiSettings>) => update({ localAi: { ...useSettings.getState().settings.localAi, ...patch } });

  useEffect(() => {
    localTerm
      .detect()
      .then(setTools)
      .catch(() => setTools([]));
  }, []);

  const showPreview = async () => {
    try {
      setPreview(await previewContext());
    } catch (e) {
      toast.error("No se pudo preparar el contexto", e);
    }
  };

  return (
    <>
      <h3 className="st-title">Terminal local e IA</h3>
      <p className="mcp-intro">
        TerView abre terminales de <strong>este equipo</strong> (botón con el portátil en la barra de pestañas) y puede
        lanzar <strong>Claude Code</strong> o <strong>Codex</strong> sabiendo qué servidores tienes. Solo se les da
        contexto: nunca contraseñas, llaves, tokens ni el PIN, y TerView no lee ni copia su configuración ni su sesión.
        Cada uno inicia sesión a su manera la primera vez.
      </p>

      <Row label="Cómo trabaja con los servidores" hint={MODE_HINT[local.mode]}>
        <div className="st-segmented" role="radiogroup" aria-label="Vía para los servidores">
          {MODES.map((o) => (
            <button
              key={o.v}
              role="radio"
              aria-checked={local.mode === o.v}
              className={local.mode === o.v ? "active" : ""}
              onClick={() => set({ mode: o.v })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Row>
      {local.mode !== "direct" && (
        <Row label="MCP de TerView" hint="Se activa, y se elige a qué servidores puede entrar, en Asistentes de IA (MCP).">
          <button className="btn btn-sm" onClick={() => openSettingsAt("assistants")}>
            Abrir
          </button>
        </Row>
      )}

      <h4 className="st-subtitle">Qué contexto recibe</h4>
      {INCLUDE.map((i) => (
        <Row key={i.key} label={i.label} hint={i.hint || undefined}>
          <Toggle checked={!!local[i.key]} onChange={(v) => set({ [i.key]: v } as Partial<LocalAiSettings>)} label={i.label} />
        </Row>
      ))}
      <Row label="Ver el contexto" hint="Lo que recibiría ahora un asistente al abrirlo.">
        <button className="btn btn-sm" onClick={() => void showPreview()}>
          <Eye size={13} /> Ver
        </button>
      </Row>
      {preview !== null && <pre className="lt-cmd lt-preview">{preview || "(vacío)"}</pre>}

      <h4 className="st-subtitle">Carpeta de trabajo</h4>
      <Row label="Se abre en" hint="Las terminales locales y los asistentes empiezan aquí.">
        <span className="mono lt-menu-cwd" title={local.lastCwd ?? "Carpeta personal"}>
          {local.lastCwd ?? "Carpeta personal"}
        </span>
        <button className="btn btn-sm" onClick={() => void chooseFolder()}>
          <FolderOpen size={13} /> Cambiar…
        </button>
        {local.lastCwd && (
          <button className="btn btn-sm" title="Usar la carpeta personal" onClick={() => set({ lastCwd: null })}>
            <Home size={13} />
          </button>
        )}
      </Row>

      <h4 className="st-subtitle">Asistentes en este equipo</h4>
      {tools === null && <p className="muted">Buscando…</p>}
      {tools?.map((t) => (
        <Row
          key={t.tool}
          label={t.label}
          hint={t.installed ? (t.path ?? undefined) : `No instalado. Se instala con: ${t.installCommand}`}
        >
          {t.installed ? (
            <span className="lt-badge">
              <Check size={11} /> Instalado
            </span>
          ) : (
            <button className="btn btn-sm" onClick={() => void launchAssistant(t.tool)}>
              <Bot size={13} /> Instalar…
            </button>
          )}
        </Row>
      ))}
    </>
  );
}
