// Ajustes → Terminal local e IA: qué contexto reciben Claude Code y Codex al abrirlos desde TerView,
// por qué vía trabajan (ssh directo, MCP o las dos), la carpeta de trabajo y si están instalados.
import { useEffect, useState } from "react";
import { Bot, Check, Eye, FolderOpen, Home } from "lucide-react";
import { localTerm, type AiToolInfo } from "../../api/localterm";
import type { LocalAiMode, LocalAiSettings } from "../../api/types";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { chooseFolder, launchAssistant, previewContext } from "../../features/localterm/launch";
import { openSettingsAt } from "./settingsNav";
import "../../features/localterm/LocalTerm.css";
import { SettingGroup, SettingRow as Row, Switch as Toggle } from "../ui/SettingsKit";

const MODES: { v: LocalAiMode; label: string; title: string }[] = [
  { v: "both", label: "Las dos", title: "El asistente elige la vía que mejor maneje." },
  { v: "direct", label: "Solo ssh", title: "ssh directo con los alias de ~/.ssh/config." },
  { v: "mcp", label: "Solo MCP", title: "Si el MCP está apagado, te preguntará al abrir." },
];

const MODE_HINT: Record<LocalAiMode, string> = {
  both: "Alias de ssh y, si está activo, el MCP de TerView.",
  direct: "Los servidores con contraseña no le servirán.",
  mcp: "Con tus permisos y aprobaciones.",
};

const INCLUDE: { key: keyof LocalAiSettings; label: string; hint: string }[] = [
  { key: "includeServers", label: "Lista de servidores", hint: "Nombre, alias, usuario, proyecto y acceso." },
  { key: "includeHosts", label: "Host y puerto", hint: "Sin esto, solo el alias." },
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
      <SettingGroup>
        <Row label="Cómo trabaja con los servidores" hint={MODE_HINT[local.mode]}>
          <div className="st-segmented" role="radiogroup" aria-label="Vía para los servidores">
            {MODES.map((o) => (
              <button
                key={o.v}
                role="radio"
                aria-checked={local.mode === o.v}
                className={local.mode === o.v ? "active" : ""}
                title={o.title}
                onClick={() => set({ mode: o.v })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Row>
        {local.mode !== "direct" && (
          <Row label="MCP de TerView" hint="Se configura en Asistentes de IA (MCP).">
            <button className="btn btn-sm" onClick={() => openSettingsAt("assistants")}>
              Abrir
            </button>
          </Row>
        )}
      </SettingGroup>

      <SettingGroup title="Qué contexto recibe">
        {INCLUDE.map((i) => (
          <Row key={i.key} label={i.label} hint={i.hint || undefined}>
            <Toggle checked={!!local[i.key]} onChange={(v) => set({ [i.key]: v } as Partial<LocalAiSettings>)} label={i.label} />
          </Row>
        ))}
        <Row label="Ver el contexto" hint="Lo que recibiría ahora un asistente.">
          <button className="btn btn-sm" onClick={() => void showPreview()}>
            <Eye size={13} /> Ver
          </button>
        </Row>
        {preview !== null && (
          <div className="st-block">
            <pre className="lt-cmd lt-preview">{preview || "(vacío)"}</pre>
          </div>
        )}
      </SettingGroup>

      <SettingGroup title="Carpeta de trabajo">
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
      </SettingGroup>

      <SettingGroup title="Asistentes en este equipo">
        {tools === null && <div className="st-block muted">Buscando…</div>}
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
      </SettingGroup>
    </>
  );
}
