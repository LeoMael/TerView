// Ajustes de la app. Los cambios se aplican al momento (useSettings().update guarda con retardo).
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  FileCode2,
  FileOutput,
  FolderTree,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plug,
  Plus,
  RotateCcw,
  Server,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { useUi } from "../../stores/ui";
import { DEFAULT_MONO_FONT, DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import type { Settings } from "../../api/types";
import { confirmDialog } from "../ui/dialogs";
import { profiles } from "../../api/profiles";
import { toast } from "../../stores/toasts";
import { getTerminalGpu, setTerminalGpu } from "../Terminal/gpuPref";
import "./SettingsDialog.css";
import { SSH_CONFIG_LABEL } from "../../lib/platform";

type SectionId = "appearance" | "terminal" | "connection" | "transfers" | "explorer" | "editor" | "servers";

const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Apariencia", icon: <Palette size={15} /> },
  { id: "terminal", label: "Terminal", icon: <TerminalSquare size={15} /> },
  { id: "connection", label: "Conexión", icon: <Plug size={15} /> },
  { id: "transfers", label: "Transferencias", icon: <ArrowLeftRight size={15} /> },
  { id: "explorer", label: "Explorador", icon: <FolderTree size={15} /> },
  { id: "editor", label: "Editor", icon: <FileCode2 size={15} /> },
  { id: "servers", label: "Servidores", icon: <Server size={15} /> },
];

const FONT_PRESETS = [
  DEFAULT_MONO_FONT,
  "'Fira Code', monospace",
  "'Cascadia Code', 'Cascadia Mono', monospace",
  "'Source Code Pro', monospace",
  "'Ubuntu Mono', monospace",
  "'DejaVu Sans Mono', monospace",
  "Menlo, Monaco, monospace",
  "Consolas, 'Courier New', monospace",
  "monospace",
];

const MB = 1024 * 1024;

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const close = useUi((s) => s.closeSettings);
  const [section, setSection] = useState<SectionId>("appearance");
  if (!open) return null;
  return (
    <Modal
      open
      title="Ajustes"
      onClose={close}
      width={720}
      footer={
        <>
          <button className="btn st-reset" onClick={() => void resetAll()}>
            <RotateCcw size={14} /> Restablecer
          </button>
          <span className="st-footer-hint">Los cambios se guardan solos.</span>
          <button className="btn btn-primary" onClick={close} autoFocus>
            Listo
          </button>
        </>
      }
    >
      <div className="st-root">
        <nav className="st-nav" aria-label="Secciones">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={section === s.id ? "st-nav-item active" : "st-nav-item"}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
        <div className="st-content">
          {section === "appearance" && <Appearance />}
          {section === "terminal" && <TerminalSection />}
          {section === "connection" && <ConnectionSection />}
          {section === "transfers" && <Transfers />}
          {section === "explorer" && <Explorer />}
          {section === "editor" && <EditorSection />}
          {section === "servers" && <ServersSection />}
        </div>
      </div>
    </Modal>
  );
}

async function resetAll() {
  const ok = await confirmDialog({
    title: "Restablecer ajustes",
    message: "Se volverán a los valores de fábrica (el tamaño de los paneles no cambia).",
    confirmText: "Restablecer",
  });
  if (!ok) return;
  const { layout: _layout, ...defaults } = DEFAULT_SETTINGS;
  void _layout;
  useSettings.getState().update(defaults);
}

function useSetting<K extends keyof Settings>(key: K): [Settings[K], (v: Settings[K]) => void] {
  const value = useSettings((s) => s.settings[key]);
  const update = useSettings((s) => s.update);
  return [value, (v) => update({ [key]: v } as Partial<Settings>)];
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

/** Número con − / + y escritura libre; confirma al salir o con Enter. */
function NumberStepper({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = () => {
    const n = Number(text.replace(",", "."));
    if (Number.isFinite(n)) onChange(clamp(Math.round(n / step) * step));
    else setText(String(value));
  };
  return (
    <div className="st-stepper">
      <button className="icon-btn" onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label="Menos">
        <Minus size={14} />
      </button>
      <input
        className="input st-num"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onChange(clamp(value + step));
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onChange(clamp(value - step));
          }
        }}
      />
      {suffix && <span className="st-suffix">{suffix}</span>}
      <button className="icon-btn" onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label="Más">
        <Plus size={14} />
      </button>
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

function FontFamilyInput({ value, onChange, fallback }: { value: string; onChange: (v: string) => void; fallback: string }) {
  return (
    <>
      <input
        className="input st-wide mono"
        value={value}
        list="st-font-presets"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => !e.target.value.trim() && onChange(fallback)}
      />
      <datalist id="st-font-presets">
        {FONT_PRESETS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { v: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="st-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          role="radio"
          aria-checked={value === o.v}
          className={value === o.v ? "active" : ""}
          onClick={() => onChange(o.v)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Appearance() {
  const [theme, setTheme] = useSetting("theme");
  const opts: { v: Settings["theme"]; label: string; icon: ReactNode }[] = [
    { v: "dark", label: "Oscuro", icon: <Moon size={15} /> },
    { v: "light", label: "Claro", icon: <Sun size={15} /> },
    { v: "system", label: "Sistema", icon: <Monitor size={15} /> },
  ];
  return (
    <>
      <h3 className="st-title">Apariencia</h3>
      <Row label="Tema" hint="«Sistema» sigue el modo claro u oscuro de tu equipo.">
        <Segmented value={theme} options={opts} onChange={setTheme} label="Tema" />
      </Row>
    </>
  );
}

function TerminalSection() {
  const [size, setSize] = useSetting("terminalFontSize");
  const [family, setFamily] = useSetting("terminalFontFamily");
  // Se guarda en este equipo (localStorage), no en los ajustes del motor.
  const [gpu, setGpu] = useState(getTerminalGpu);
  return (
    <>
      <h3 className="st-title">Terminal</h3>
      <Row label="Tamaño de letra">
        <NumberStepper value={size} min={8} max={32} suffix="px" onChange={setSize} />
      </Row>
      <Row label="Tipo de letra" hint="Lista de fuentes CSS; se usa la primera instalada.">
        <FontFamilyInput value={family} onChange={setFamily} fallback={DEFAULT_SETTINGS.terminalFontFamily} />
      </Row>
      <Row
        label="Aceleración por GPU en la terminal"
        hint="Dibuja la terminal con la tarjeta gráfica (WebGL): más fluida con mucha salida. Si ves fallos de dibujado, desactívala. Si no está disponible se usa el dibujado normal."
      >
        <Toggle
          checked={gpu}
          onChange={(v) => {
            setGpu(v);
            setTerminalGpu(v);
          }}
          label="Aceleración por GPU en la terminal"
        />
      </Row>
      <div className="st-preview" style={{ fontFamily: family, fontSize: size }}>
        <span className="st-prompt">deploy@web-prod</span>:<span className="st-path">~/app</span>$ ls -la
        <br />
        drwxr-xr-x 4 deploy deploy 4096 public  0O1lI|
      </div>
    </>
  );
}

const CONFLICT_HINTS: Record<Settings["transferConflict"], string> = {
  overwrite: "El archivo de destino se reemplaza siempre.",
  skip: "Si ya existe, no se transfiere (queda como «omitido»).",
  newer: "Solo se reemplaza si el origen es más reciente que el destino.",
};

function Transfers() {
  const [conc, setConc] = useSetting("transferConcurrency");
  const [conflict, setConflict] = useSetting("transferConflict");
  return (
    <>
      <h3 className="st-title">Transferencias</h3>
      <Row label="Transferencias simultáneas" hint="Cuántos archivos se suben o bajan a la vez. Más no siempre es más rápido.">
        <div className="st-range">
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={conc}
            onChange={(e) => setConc(Number(e.target.value))}
            aria-label="Transferencias simultáneas"
          />
          <span className="st-range-value">{conc}</span>
        </div>
      </Row>
      <Row label="Si el archivo ya existe" hint={CONFLICT_HINTS[conflict]}>
        <Segmented
          value={conflict}
          label="Si el archivo ya existe"
          onChange={setConflict}
          options={[
            { v: "overwrite", label: "Sobrescribir" },
            { v: "skip", label: "Omitir" },
            { v: "newer", label: "Solo si es más nuevo" },
          ]}
        />
      </Row>
    </>
  );
}

function Explorer() {
  const [hidden, setHidden] = useSetting("showHiddenFiles");
  const [confirmDel, setConfirmDel] = useSetting("confirmDelete");
  return (
    <>
      <h3 className="st-title">Explorador</h3>
      <Row label="Mostrar archivos ocultos" hint="Archivos y carpetas que empiezan por un punto (.env, .git…).">
        <Toggle checked={hidden} onChange={setHidden} label="Mostrar archivos ocultos" />
      </Row>
      <Row label="Confirmar antes de borrar" hint="Pregunta antes de borrar archivos del servidor.">
        <Toggle checked={confirmDel} onChange={setConfirmDel} label="Confirmar antes de borrar" />
      </Row>
    </>
  );
}

function EditorSection() {
  const [maxBytes, setMaxBytes] = useSetting("editorMaxBytes");
  const [size, setSize] = useSetting("editorFontSize");
  const [family, setFamily] = useSetting("editorFontFamily");
  const mb = Math.max(1, Math.round(maxBytes / MB));
  return (
    <>
      <h3 className="st-title">Editor</h3>
      <Row label="Tamaño de letra">
        <NumberStepper value={size} min={8} max={32} suffix="px" onChange={setSize} />
      </Row>
      <Row label="Tipo de letra" hint="Lista de fuentes CSS; se usa la primera instalada.">
        <FontFamilyInput value={family} onChange={setFamily} fallback={DEFAULT_SETTINGS.editorFontFamily} />
      </Row>
      <Row label="Tamaño máximo para abrir" hint="Los archivos más grandes no se abren en el editor (puedes descargarlos).">
        <NumberStepper value={mb} min={1} max={100} suffix="MB" onChange={(v) => setMaxBytes(v * MB)} />
      </Row>
      <div className="st-preview" style={{ fontFamily: family, fontSize: size }}>
        <span className="st-prompt">server</span> {"{"}
        <br />
        &nbsp;&nbsp;listen <span className="st-path">443</span> ssl; <span className="st-comment"># 0O1lI|</span>
        <br />
        {"}"}
      </div>
    </>
  );
}

const KEEPALIVE_OPTIONS = [5, 10, 20, 30, 60];

function ConnectionSection() {
  const [keepalive, setKeepalive] = useSetting("keepaliveSecs");
  const [auto, setAuto] = useSetting("autoReconnect");
  const [attempts, setAttempts] = useSetting("reconnectAttempts");
  const values = KEEPALIVE_OPTIONS.includes(keepalive) ? KEEPALIVE_OPTIONS : [...KEEPALIVE_OPTIONS, keepalive].sort((a, b) => a - b);
  return (
    <>
      <h3 className="st-title">Conexión</h3>
      <Row
        label="Detectar desconexión en"
        hint={`Intervalo de la señal de vida. Se da por perdida tras ~3 intervalos sin respuesta (≈ ${keepalive * 3} s). Aplica a conexiones nuevas.`}
      >
        <Segmented
          value={keepalive}
          label="Detectar desconexión en"
          onChange={setKeepalive}
          options={values.map((v) => ({ v, label: `${v} s` }))}
        />
      </Row>
      <Row label="Reconectar automáticamente" hint="Si se cae la conexión, se reintenta sola con la contraseña o frase guardada.">
        <Toggle checked={auto} onChange={setAuto} label="Reconectar automáticamente" />
      </Row>
      <Row label="Intentos" hint="Cuántas veces se reintenta (con espera creciente) antes de darla por perdida.">
        <div className={auto ? undefined : "st-disabled"}>
          <NumberStepper value={attempts} min={1} max={20} onChange={setAttempts} />
        </div>
      </Row>
    </>
  );
}

function ServersSection() {
  const [sync, setSync] = useSetting("sshConfigSync");
  const [busy, setBusy] = useState(false);

  const exportNow = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await profiles.exportSshConfig();
      toast.success(
        r.count === 1 ? `1 servidor exportado a ${r.path}` : `${r.count} servidores exportados a ${r.path}`,
        "Ya puedes usar «ssh <alias>» desde cualquier terminal.",
      );
      return true;
    } catch (e) {
      toast.error(`No se pudo exportar a ${SSH_CONFIG_LABEL}`, e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (v: boolean) => {
    if (!v) {
      setSync(false);
      return;
    }
    if (await exportNow()) setSync(true);
  };

  return (
    <>
      <h3 className="st-title">Servidores</h3>
      <Row
        label={`Mantener ${SSH_CONFIG_LABEL} sincronizado`}
        hint={`Tus servidores se escriben en un bloque marcado de ${SSH_CONFIG_LABEL} (el resto del archivo no se toca) y se actualizan al guardar o borrar. Así funcionan con «ssh», «scp», VS Code o Claude Code.`}
      >
        <Toggle checked={sync} onChange={(v) => void onToggle(v)} label={`Mantener ${SSH_CONFIG_LABEL} sincronizado`} />
      </Row>
      <Row label={`Exportar a ${SSH_CONFIG_LABEL}`} hint="Escribe ahora el bloque de TerView. Se guarda una copia de seguridad la primera vez.">
        <button className="btn" onClick={() => void exportNow()} disabled={busy}>
          {busy ? <span className="spinner" /> : <FileOutput size={14} />} Exportar ahora
        </button>
      </Row>
    </>
  );
}
