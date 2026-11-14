// Ajustes de la app. Los cambios se aplican al momento (useSettings().update guarda con retardo).
// Navegación lateral agrupada con buscador, cabecera de sección y filas en tarjetas (ui/SettingsKit).
import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  BookOpen,
  Bot,
  Check,
  MessageSquareText,
  ArrowLeftRight,
  Columns2,
  FileCode2,
  FileOutput,
  FolderTree,
  Info,
  Keyboard,
  SlidersHorizontal,
  Monitor,
  PanelTop,
  Palette,
  Plug,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Laptop,
  TerminalSquare,
  X,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { NumberStepper, Segmented, SettingGroup, SettingRow as Row, Switch as Toggle } from "../ui/SettingsKit";
import { useUi } from "../../stores/ui";
import { DEFAULT_MONO_FONT, DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import type { Settings } from "../../api/types";
import { confirmDialog } from "../ui/dialogs";
import { profiles } from "../../api/profiles";
import { toast } from "../../stores/toasts";
import { getTerminalGpu, setTerminalGpu } from "../Terminal/gpuPref";
import { buildTermTheme } from "../Terminal/termTheme";
import { TMUX_MODE_HINTS, TMUX_MODE_LABELS } from "../../features/tmux/logic";
import { getEditorOpenMode, setEditorOpenMode, type EditorOpenMode } from "../Editor/openPref";
import "./SettingsDialog.css";
import { SSH_CONFIG_LABEL } from "../../lib/platform";
import { useSettingsNav, type SectionId } from "./settingsNav";
import { DiagnosticsPanel } from "../Diagnostics/DiagnosticsPanel";
import { AboutHeader, ChangelogView, UpdatesBox } from "../About/About";
import { getAutoCheck, setAutoCheck } from "../../features/updater/updater";
import { checkSshAliasesBeforeExport } from "../../features/sshAliases";
import { SecuritySection } from "./SecuritySection";
import { McpSection } from "./McpSection";
import { AiSection } from "./AiSection";
import { LocalAiSection } from "./LocalAiSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { useShortcutText } from "../../features/shortcuts/shortcuts";
import { useAppTheme } from "./theme";
import { ACCENTS, PALETTES, type AccentId, type PaletteInfo, type ThemeId } from "../../styles/themes";

// El manual (texto e imágenes) va en un trozo aparte: solo se carga al abrir su sección.
const ManualView = lazy(() => import("../About/Manual"));

interface SectionInfo {
  id: SectionId;
  label: string;
  icon: ReactNode;
  /** Frase bajo el título de la sección. */
  desc: string;
  /** Palabras extra para el buscador (nombres de los ajustes de la sección). */
  keys: string;
}

const NAV: { group: string; items: SectionInfo[] }[] = [
  {
    group: "General",
    items: [
      { id: "appearance", label: "Apariencia", icon: <Palette size={15} />, desc: "Tema de colores, acento y tamaño de la letra de la interfaz.", keys: "tema claro oscuro sistema color acento letra fuente tamaño medianoche arena fiordo alto contraste" },
      { id: "terminal", label: "Terminal", icon: <TerminalSquare size={15} />, desc: "Letra, aceleración gráfica y sesiones persistentes.", keys: "letra fuente tamaño gpu webgl tmux persistentes" },
      { id: "editor", label: "Editor", icon: <FileCode2 size={15} />, desc: "Cómo se abren los archivos y con qué letra.", keys: "letra fuente tamaño dividido ventana pestaña máximo mb" },
      { id: "explorer", label: "Explorador", icon: <FolderTree size={15} />, desc: "Lista de archivos del servidor.", keys: "ocultos borrar confirmar" },
      { id: "shortcuts", label: "Atajos de teclado", icon: <Keyboard size={15} />, desc: "Haz clic en un atajo para cambiarlo.", keys: "teclas teclado combinación ctrl paleta pestaña copiar pegar buscar" },
    ],
  },
  {
    group: "Conexiones",
    items: [
      { id: "connection", label: "Conexión", icon: <Plug size={15} />, desc: "Detección de cortes y reconexión automática.", keys: "keepalive señal de vida reconectar intentos desconexión" },
      { id: "transfers", label: "Transferencias", icon: <ArrowLeftRight size={15} />, desc: "Subidas y descargas de archivos.", keys: "simultáneas sobrescribir omitir existe conflicto" },
      { id: "servers", label: "Servidores", icon: <Server size={15} />, desc: "Integración con la configuración de ssh del equipo.", keys: "ssh config exportar sincronizar alias" },
      { id: "security", label: "Seguridad", icon: <ShieldCheck size={15} />, desc: "PIN de la bóveda de contraseñas y bloqueo.", keys: "pin bloqueo bóveda contraseña inactividad" },
    ],
  },
  {
    group: "Inteligencia artificial",
    items: [
      { id: "assistants", label: "Asistentes de IA (MCP)", icon: <Bot size={15} />, desc: "Claude, Codex y otros usan tus servidores con permiso, sin ver contraseñas ni llaves.", keys: "mcp claude codex token puerto permisos sudo" },
      { id: "localAi", label: "Terminal local e IA", icon: <Laptop size={15} />, desc: "Terminal de tu equipo y el contexto que reciben los asistentes (nunca contraseñas ni llaves).", keys: "local claude code codex contexto carpeta" },
      { id: "ai", label: "IA para explicar informes", icon: <MessageSquareText size={15} />, desc: "Modelo opcional que explica los informes del escáner.", keys: "openai ollama modelo url token escáner vulnerabilidades" },
    ],
  },
  {
    group: "Sistema",
    items: [
      { id: "advanced", label: "Avanzado", icon: <SlidersHorizontal size={15} />, desc: "Diagnóstico y datos para informar de fallos.", keys: "diagnóstico registro logs" },
      { id: "manual", label: "Manual de uso", icon: <BookOpen size={15} />, desc: "Cómo se usa SSHorus, paso a paso.", keys: "ayuda guía" },
      { id: "about", label: "Acerca de", icon: <Info size={15} />, desc: "Versión, actualizaciones y novedades.", keys: "versión actualizaciones novedades changelog" },
    ],
  },
];

const ALL_SECTIONS = NAV.flatMap((g) => g.items);

/** Minúsculas y sin tildes, para buscar sin importar cómo se escriba. */
const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

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
  if (!open) return null;
  return (
    <Modal
      open
      title="Ajustes"
      onClose={close}
      className="st-modal"
      // Ancha para que quepan las secciones largas (MCP, terminal local e IA); en pantallas pequeñas,
      // como mucho el 94 % de la ventana.
      width="min(1080px, 94vw)"
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
      <SettingsBody />
    </Modal>
  );
}

function SettingsBody() {
  const section = useSettingsNav((s) => s.section);
  const setSection = useSettingsNav((s) => s.setSection);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const q = fold(query.trim());
  const groups = useMemo(
    () =>
      q
        ? NAV.map((g) => ({ ...g, items: g.items.filter((s) => fold(`${s.label} ${s.desc} ${s.keys}`).includes(q)) })).filter(
            (g) => g.items.length > 0,
          )
        : NAV,
    [q],
  );
  const current = ALL_SECTIONS.find((s) => s.id === section) ?? ALL_SECTIONS[0];
  const go = (id: SectionId) => {
    setSection(id);
    contentRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div className="st-root">
      <nav className="st-nav" aria-label="Secciones de ajustes">
        <div className="st-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            className="st-search-input"
            placeholder="Buscar ajuste…"
            value={query}
            aria-label="Buscar ajuste"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && groups[0]) go(groups[0].items[0].id);
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="st-search-clear"
              aria-label="Borrar búsqueda"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div className="st-nav-list">
          {groups.map((g) => (
            <div className="st-nav-group" key={g.group}>
              <div className="st-nav-group-title">{g.group}</div>
              {g.items.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={section === s.id ? "st-nav-item active" : "st-nav-item"}
                  onClick={() => go(s.id)}
                  aria-current={section === s.id ? "page" : undefined}
                  title={s.label}
                >
                  {s.icon}
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="st-nav-empty">Sin resultados para «{query.trim()}».</div>}
        </div>
      </nav>
      <div className="st-main" ref={contentRef}>
        {section !== "manual" && section !== "about" && (
          <header className="st-head">
            <span className="st-head-icon" aria-hidden>
              {current.icon}
            </span>
            <div>
              <h3 className="st-head-title">{current.label}</h3>
              <p className="st-head-desc">{current.desc}</p>
            </div>
          </header>
        )}
        <div className={`st-body st-body-${section}`}>
          {section === "appearance" && <Appearance />}
          {section === "terminal" && <TerminalSection />}
          {section === "connection" && <ConnectionSection />}
          {section === "transfers" && <Transfers />}
          {section === "explorer" && <Explorer />}
          {section === "shortcuts" && <ShortcutsSection />}
          {section === "editor" && <EditorSection />}
          {section === "servers" && <ServersSection />}
          {section === "security" && <SecuritySection />}
          {section === "assistants" && <McpSection />}
          {section === "localAi" && <LocalAiSection />}
          {section === "ai" && <AiSection />}
          {section === "advanced" && <AdvancedSection />}
          {section === "manual" && (
            <Suspense
              fallback={
                <div className="st-manual-loading">
                  <span className="spinner" />
                </div>
              }
            >
              <ManualView />
            </Suspense>
          )}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

async function resetAll() {
  const ok = await confirmDialog({
    title: "Restablecer ajustes",
    message: "Se volverán a los valores de fábrica (el tamaño de los paneles no cambia).",
    confirmText: "Restablecer",
  });
  if (!ok) return;
  // «Ahora no» al PIN se respeta: restablecer no vuelve a mostrar la pantalla de crear PIN.
  const { layout: _layout, vaultPromptDismissed: _dismissed, ...defaults } = DEFAULT_SETTINGS;
  void _layout;
  void _dismissed;
  useSettings.getState().update(defaults);
}

function useSetting<K extends keyof Settings>(key: K): [Settings[K], (v: Settings[K]) => void] {
  const value = useSettings((s) => s.settings[key]);
  const update = useSettings((s) => s.update);
  return [value, (v) => update({ [key]: v } as Partial<Settings>)];
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

/** Miniatura de una apariencia: barra lateral, panel con acento y un trozo de terminal. */
function ThemeThumb({ p }: { p: PaletteInfo["preview"] }) {
  return (
    <span className="st-thumb" style={{ background: p.bg, borderColor: p.border }} aria-hidden>
      <span className="st-thumb-side" style={{ background: p.sunken, borderColor: p.border }}>
        <i style={{ background: p.accent }} />
        <i style={{ background: p.muted }} />
        <i style={{ background: p.muted }} />
      </span>
      <span className="st-thumb-main">
        <span className="st-thumb-bar" style={{ background: p.surface, borderColor: p.border }}>
          <i style={{ background: p.text }} />
          <b style={{ background: p.accent }} />
        </span>
        <span className="st-thumb-term" style={{ background: p.terminal, borderColor: p.border }}>
          <i style={{ background: p.termText }} />
          <i style={{ background: p.muted, width: "70%" }} />
          <i style={{ background: p.muted, width: "45%" }} />
        </span>
      </span>
    </span>
  );
}

function Appearance() {
  const [theme, setTheme] = useSetting("theme");
  const [accent, setAccent] = useSetting("accent");
  const [uiSize, setUiSize] = useSetting("uiFontSize");
  const mode = useAppTheme((s) => s.theme);
  const dark = PALETTES.find((p) => p.id === "dark")!;
  const light = PALETTES.find((p) => p.id === "light")!;
  const cards: { id: ThemeId; label: string; hint: string; thumb: ReactNode }[] = [
    {
      id: "system",
      label: "Sistema",
      hint: "Claro u Oscuro según el modo de tu equipo.",
      thumb: (
        <span className="st-thumb-split">
          <ThemeThumb p={light.preview} />
          <ThemeThumb p={dark.preview} />
        </span>
      ),
    },
    ...PALETTES.map((p) => ({ id: p.id, label: p.label, hint: p.hint, thumb: <ThemeThumb p={p.preview} /> })),
  ];
  return (
    <>
      <SettingGroup title="Tema">
        <div className="st-themes" role="radiogroup" aria-label="Tema">
          {cards.map((c) => (
            <button
              type="button"
              key={c.id}
              role="radio"
              aria-checked={theme === c.id}
              className={theme === c.id ? "st-theme active" : "st-theme"}
              onClick={() => setTheme(c.id)}
            >
              {c.thumb}
              <span className="st-theme-name">
                {c.id === "system" && <Monitor size={13} />}
                {c.label}
                {theme === c.id && <Check size={14} className="st-theme-check" />}
              </span>
              <span className="st-theme-hint">{c.hint}</span>
            </button>
          ))}
        </div>
      </SettingGroup>
      <SettingGroup title="Detalles">
        <Row label="Color de acento" hint="«Del tema» usa el de cada apariencia.">
          <div className="st-swatches" role="radiogroup" aria-label="Color de acento">
            <button
              type="button"
              role="radio"
              aria-checked={!accent}
              className={!accent ? "st-swatch st-swatch-auto active" : "st-swatch st-swatch-auto"}
              onClick={() => setAccent("")}
            >
              Del tema
            </button>
            {ACCENTS.map((a) => (
              <button
                type="button"
                key={a.id}
                role="radio"
                aria-checked={accent === a.id}
                aria-label={a.label}
                title={a.label}
                className={accent === a.id ? "st-swatch active" : "st-swatch"}
                style={{ background: mode === "dark" ? a.dark : a.light }}
                onClick={() => setAccent(a.id as AccentId)}
              >
                {accent === a.id && <Check size={13} />}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Tamaño de la letra de la interfaz" hint="La terminal y el editor tienen su propio tamaño.">
          <Segmented
            value={uiSize}
            label="Tamaño de la letra de la interfaz"
            onChange={setUiSize}
            options={[
              { v: 12, label: "Pequeña" },
              { v: 13, label: "Normal" },
              { v: 14, label: "Grande" },
              { v: 15, label: "Muy grande" },
            ]}
          />
        </Row>
      </SettingGroup>
    </>
  );
}

/** Colores de la terminal con la apariencia actual (para la vista previa). */
function useTermColors() {
  const palette = useAppTheme((s) => s.palette);
  const accent = useSettings((s) => s.settings.accent);
  // buildTermTheme lee las variables de <html>, ya actualizadas cuando cambian palette o accent.
  return useMemo(() => (void palette, void accent, buildTermTheme()), [palette, accent]);
}

function TerminalSection() {
  const [size, setSize] = useSetting("terminalFontSize");
  const [family, setFamily] = useSetting("terminalFontFamily");
  const [tmux, setTmux] = useSetting("terminalTmux");
  // Se guarda en este equipo (localStorage), no en los ajustes del motor.
  const [gpu, setGpu] = useState(getTerminalGpu);
  const tc = useTermColors();
  return (
    <>
      <SettingGroup title="Letra">
        <Row label="Tamaño de letra">
          <NumberStepper value={size} min={8} max={32} suffix="px" onChange={setSize} />
        </Row>
        <Row label="Tipo de letra" hint="Se usa la primera fuente instalada.">
          <FontFamilyInput value={family} onChange={setFamily} fallback={DEFAULT_SETTINGS.terminalFontFamily} />
        </Row>
        <div className="st-preview" style={{ fontFamily: family, fontSize: size, background: tc.background, color: tc.foreground }}>
          <span style={{ color: tc.green }}>deploy@web-prod</span>:<span style={{ color: tc.blue }}>~/app</span>$ ls -la
          <br />
          drwxr-xr-x 4 deploy deploy 4096 <span style={{ color: tc.blue }}>public</span>  0O1lI|
        </div>
      </SettingGroup>
      <SettingGroup title="Funcionamiento">
        <Row label="Aceleración por GPU en la terminal" hint="Desactívala si ves fallos de dibujado.">
          <Toggle
            checked={gpu}
            onChange={(v) => {
              setGpu(v);
              setTerminalGpu(v);
            }}
            label="Aceleración por GPU en la terminal"
          />
        </Row>
        <Row label="Terminales persistentes (tmux)" hint="Lo que corre sigue vivo si se corta la conexión.">
          <Segmented
            value={tmux}
            label="Terminales persistentes (tmux)"
            onChange={setTmux}
            options={(["auto", "always", "never"] as const).map((v) => ({
              v,
              label: TMUX_MODE_LABELS[v],
              title: `${TMUX_MODE_HINTS[v]} Cada servidor puede cambiarlo en su ficha.`,
            }))}
          />
        </Row>
      </SettingGroup>
    </>
  );
}

const CONFLICT_HINTS: Record<Settings["transferConflict"], string> = {
  overwrite: "Reemplaza siempre el de destino.",
  skip: "No transfiere los que ya existen.",
  newer: "Reemplaza solo si el origen es más reciente.",
  ask: "Pregunta archivo por archivo.",
};

function Transfers() {
  const [conc, setConc] = useSetting("transferConcurrency");
  const [conflict, setConflict] = useSetting("transferConflict");
  return (
    <>
      <SettingGroup>
        <Row label="Transferencias simultáneas" hint="Más no siempre es más rápido.">
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
              { v: "overwrite", label: "Sobrescribir", title: CONFLICT_HINTS.overwrite },
              { v: "skip", label: "Omitir", title: CONFLICT_HINTS.skip },
              { v: "newer", label: "Solo si es más nuevo", title: CONFLICT_HINTS.newer },
              { v: "ask", label: "Preguntar", title: CONFLICT_HINTS.ask },
            ]}
          />
        </Row>
      </SettingGroup>
    </>
  );
}

function Explorer() {
  const [hidden, setHidden] = useSetting("showHiddenFiles");
  const [confirmDel, setConfirmDel] = useSetting("confirmDelete");
  return (
    <>
      <SettingGroup>
        <Row label="Mostrar archivos ocultos" hint="Los que empiezan por un punto (.env, .git…).">
          <Toggle checked={hidden} onChange={setHidden} label="Mostrar archivos ocultos" />
        </Row>
        <Row label="Confirmar antes de borrar">
          <Toggle checked={confirmDel} onChange={setConfirmDel} label="Confirmar antes de borrar" />
        </Row>
      </SettingGroup>
    </>
  );
}

function EditorSection() {
  const [maxBytes, setMaxBytes] = useSetting("editorMaxBytes");
  const [size, setSize] = useSetting("editorFontSize");
  const [family, setFamily] = useSetting("editorFontFamily");
  const splitKeys = useShortcutText("session.split");
  const mb =Math.max(1, Math.round(maxBytes / MB));
  const [openMode, setOpenModeState] = useState<EditorOpenMode>(getEditorOpenMode);
  const setOpenMode = (m: EditorOpenMode) => {
    setEditorOpenMode(m);
    setOpenModeState(m);
  };
  return (
    <>
      <SettingGroup title="Archivos">
        <Row label="Al abrir un archivo" hint={splitKeys ? `${splitKeys} divide o quita la división.` : undefined}>
          <Segmented
            value={openMode}
            label="Al abrir un archivo"
            onChange={setOpenMode}
            options={[
              { v: "tab", label: "Pestaña", icon: <PanelTop size={14} /> },
              { v: "split", label: "Dividido", icon: <Columns2 size={14} /> },
              { v: "window", label: "En ventana aparte", icon: <AppWindow size={14} /> },
            ]}
          />
        </Row>
        <Row label="Tamaño máximo para abrir" hint="Los más grandes se pueden descargar.">
          <NumberStepper value={mb} min={1} max={100} suffix="MB" onChange={(v) => setMaxBytes(v * MB)} />
        </Row>
      </SettingGroup>
      <SettingGroup title="Letra">
        <Row label="Tamaño de letra">
          <NumberStepper value={size} min={8} max={32} suffix="px" onChange={setSize} />
        </Row>
        <Row label="Tipo de letra" hint="Se usa la primera fuente instalada.">
          <FontFamilyInput value={family} onChange={setFamily} fallback={DEFAULT_SETTINGS.editorFontFamily} />
        </Row>
        <div className="st-preview st-preview-editor" style={{ fontFamily: family, fontSize: size }}>
          <span className="st-kw">server</span> {"{"}
          <br />
          &nbsp;&nbsp;listen <span className="st-numlit">443</span> ssl; <span className="st-comment"># 0O1lI|</span>
          <br />
          {"}"}
        </div>
      </SettingGroup>
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
      <SettingGroup>
        <Row label="Detectar desconexión en" hint={`Se da por perdida tras ≈ ${keepalive * 3} s sin respuesta.`}>
          <Segmented
            value={keepalive}
            label="Detectar desconexión en"
            onChange={setKeepalive}
            options={values.map((v) => ({ v, label: `${v} s` }))}
          />
        </Row>
        <Row label="Reconectar automáticamente" hint="Con la contraseña o frase guardada.">
          <Toggle checked={auto} onChange={setAuto} label="Reconectar automáticamente" />
        </Row>
        <Row label="Intentos">
          <div className={auto ? undefined : "st-disabled"}>
            <NumberStepper value={attempts} min={1} max={20} onChange={setAttempts} />
          </div>
        </Row>
      </SettingGroup>
    </>
  );
}

function ServersSection() {
  const [sync, setSync] = useSetting("sshConfigSync");
  const [busy, setBusy] = useState(false);

  const exportNow = async (): Promise<boolean> => {
    if (!(await checkSshAliasesBeforeExport())) return false;
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
      <SettingGroup>
        <Row label={`Mantener ${SSH_CONFIG_LABEL} sincronizado`} hint="Para usar tus servidores con ssh, scp, VS Code o Claude Code.">
          <Toggle checked={sync} onChange={(v) => void onToggle(v)} label={`Mantener ${SSH_CONFIG_LABEL} sincronizado`} />
        </Row>
        <Row label={`Exportar a ${SSH_CONFIG_LABEL}`} hint="La primera vez guarda una copia de seguridad.">
          <button className="btn" onClick={() => void exportNow()} disabled={busy}>
            {busy ? <span className="spinner" /> : <FileOutput size={14} />} Exportar ahora
          </button>
        </Row>
      </SettingGroup>
    </>
  );
}

function AdvancedSection() {
  return (
    <>
      <h4 className="st-subtitle">Diagnóstico</h4>
      <DiagnosticsPanel />
    </>
  );
}

function AboutSection() {
  // Se guarda en este equipo (localStorage), no en los ajustes del motor.
  const [auto, setAuto] = useState(getAutoCheck);
  return (
    <>
      <AboutHeader />
      <h4 className="st-subtitle">Actualizaciones</h4>
      <UpdatesBox />
      <SettingGroup>
        <Row label="Buscar actualizaciones automáticamente" hint="Al iniciar; si hay una nueva verás un aviso.">
          <Toggle
            checked={auto}
            onChange={(v) => {
              setAuto(v);
              setAutoCheck(v);
            }}
            label="Buscar actualizaciones automáticamente"
          />
        </Row>
      </SettingGroup>
      <h4 className="st-subtitle">Novedades</h4>
      <ChangelogView />
    </>
  );
}
