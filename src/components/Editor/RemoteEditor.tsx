// Editor de archivos remotos (Monaco local). Ctrl+S guarda directamente en el servidor.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { AlertTriangle, FileWarning, RotateCw, Save, Settings as SettingsIcon } from "lucide-react";
import { sftp } from "../../api/sftp";
import { errorMessage, isApiError } from "../../api/core";
import { useSettings } from "../../stores/settings";
import { useUi } from "../../stores/ui";
import { toast } from "../../stores/toasts";
import { confirmDialog } from "../ui/dialogs";
import { formatBytes, formatDate } from "../../lib/format";
import { useAppTheme } from "../Settings/theme";
import { applyMonacoTheme, monaco } from "./monacoSetup";
import { detectLanguage, languageLabel, LANGUAGE_CHOICES } from "./languages";
import "./RemoteEditor.css";
import { matchesShortcut, useShortcutText, withShortcut } from "../../features/shortcuts/shortcuts";

export interface RemoteEditorProps {
  sessionId: string;
  path: string;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** Sin conexión con el servidor: se puede seguir editando, pero no guardar ni recargar. */
  offline?: boolean;
  /** Abrir los ajustes (por defecto, el diálogo de la ventana principal). */
  onOpenSettings?: () => void;
  ref?: Ref<RemoteEditorHandle>;
}

/** Control del editor desde fuera (p. ej. «Guardar y abrir en otra ventana»). */
export interface RemoteEditorHandle {
  /** Guarda en el servidor. true si quedó guardado (o no había nada que guardar). */
  save: () => Promise<boolean>;
  isDirty: () => boolean;
  focus: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; title: string; message: string; tooLarge: boolean };

let modelSeq = 0;

export function RemoteEditor({ sessionId, path, active, onDirtyChange, offline = false, onOpenSettings, ref }: RemoteEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const savedVersion = useRef(0);
  const remoteModified = useRef<number | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 });
  const [language, setLanguage] = useState(() => detectLanguage(path));
  const [info, setInfo] = useState<{ size: number; modified: number | null }>({ size: 0, modified: null });

  const palette = useAppTheme((s) => s.palette);
  const accent = useSettings((s) => s.settings.accent);
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const fontFamily = useSettings((s) => s.settings.editorFontFamily);
  const maxBytes = useSettings((s) => s.settings.editorMaxBytes);

  const markDirty = useCallback((d: boolean) => {
    if (dirtyRef.current === d) return;
    dirtyRef.current = d;
    setDirty(d);
    onDirtyRef.current(d);
  }, []);

  // ── Carga del contenido ──
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const text = await sftp.readText(sessionId, path);
      const model = modelRef.current;
      if (!model) return;
      model.setValue(text.content);
      savedVersion.current = model.getAlternativeVersionId();
      remoteModified.current = text.modified;
      setInfo({ size: text.size, modified: text.modified });
      markDirty(false);
      setState({ kind: "ready" });
      editorRef.current?.setPosition({ lineNumber: 1, column: 1 });
      editorRef.current?.revealLine(1);
      if (active) requestAnimationFrame(() => editorRef.current?.focus());
    } catch (e) {
      if (isApiError(e, "FileTooLarge")) {
        setState({
          kind: "error",
          tooLarge: true,
          title: "Archivo demasiado grande",
          message: `${errorMessage(e)} El límite actual del editor es ${formatBytes(maxBytes)}; puedes subirlo en Ajustes → Editor, o descargar el archivo.`,
        });
      } else if (isApiError(e, "Invalid")) {
        setState({
          kind: "error",
          tooLarge: false,
          title: "No es un archivo de texto",
          message: `${errorMessage(e)} Descárgalo para abrirlo con un programa de tu equipo.`,
        });
      } else {
        setState({ kind: "error", tooLarge: false, title: "No se pudo abrir el archivo", message: errorMessage(e) });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, path, markDirty]);

  // ── Guardar ──
  const save = useCallback(async (): Promise<boolean> => {
    const model = modelRef.current;
    if (!model || savingRef.current || state.kind !== "ready") return false;
    if (offlineRef.current) {
      toast.error("No se puede guardar", "No hay conexión con el servidor. Tus cambios siguen aquí: guarda cuando vuelva.");
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      try {
        const st = await sftp.stat(sessionId, path);
        if (remoteModified.current !== null && st.modified !== null && st.modified !== remoteModified.current) {
          const ok = await confirmDialog({
            title: "El archivo cambió en el servidor",
            message: (
              <>
                El archivo cambió en el servidor ({formatDate(st.modified)}) desde que lo abriste. ¿Sobrescribir con tu
                versión?
              </>
            ),
            confirmText: "Sobrescribir",
            danger: true,
          });
          if (!ok) return false;
        }
      } catch (e) {
        if (isApiError(e, "NotFound")) {
          const ok = await confirmDialog({
            title: "El archivo ya no existe",
            message: "Alguien lo borró o movió en el servidor. ¿Crearlo de nuevo con tu versión?",
            confirmText: "Crear y guardar",
          });
          if (!ok) return false;
        } else {
          throw e;
        }
      }
      const versionAtSave = model.getAlternativeVersionId();
      const entry = await sftp.writeText(sessionId, path, model.getValue());
      savedVersion.current = versionAtSave;
      remoteModified.current = entry.modified;
      setInfo({ size: entry.size, modified: entry.modified });
      markDirty(model.getAlternativeVersionId() !== versionAtSave);
      return true;
    } catch (e) {
      toast.error("No se pudo guardar", e);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [sessionId, path, state.kind, markDirty]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useImperativeHandle(
    ref,
    () => ({
      save: () => (dirtyRef.current ? saveRef.current() : Promise.resolve(true)),
      isDirty: () => dirtyRef.current,
      focus: () => editorRef.current?.focus(),
    }),
    [],
  );

  const reload = useCallback(async () => {
    if (dirtyRef.current) {
      const ok = await confirmDialog({
        title: "Descartar cambios",
        message: "Tienes cambios sin guardar. ¿Recargar el archivo desde el servidor y perderlos?",
        confirmText: "Recargar",
        danger: true,
      });
      if (!ok) return;
    }
    await load();
  }, [load]);

  // ── Crear el editor (una vez) ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    applyMonacoTheme();
    const uri = monaco.Uri.from({ scheme: "sshorus", authority: `s${++modelSeq}`, path: path.startsWith("/") ? path : `/${path}` });
    const model = monaco.editor.createModel("", detectLanguage(path), uri);
    const s = useSettings.getState().settings;
    const editor = monaco.editor.create(host, {
      model,
      automaticLayout: true,
      fontSize: s.editorFontSize,
      fontFamily: s.editorFontFamily,
      fontLigatures: false,
      minimap: { enabled: true, renderCharacters: false, scale: 1, maxColumn: 80 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      renderLineHighlight: "all",
      tabSize: 4,
      detectIndentation: true,
      wordWrap: "off",
      contextmenu: true,
      mouseWheelZoom: true,
      padding: { top: 6, bottom: 6 },
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: true },
      bracketPairColorization: { enabled: true },
    });
    editorRef.current = editor;
    modelRef.current = model;

    const subs = [
      model.onDidChangeContent(() => markDirty(model.getAlternativeVersionId() !== savedVersion.current)),
      editor.onDidChangeCursorSelection((e) => {
        const sel = e.selection;
        setCursor({
          line: sel.positionLineNumber,
          col: sel.positionColumn,
          sel: sel.isEmpty() ? 0 : model.getValueLengthInRange(sel),
        });
      }),
    ];
    editor.addAction({
      id: "sshorus.save",
      label: "Guardar en el servidor",
      // Sin atajo de Monaco: lo maneja el listener de abajo con el atajo configurable.
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: () => {
        void saveRef.current();
      },
    });
    void load();
    return () => {
      subs.forEach((d) => d.dispose());
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Solo al montar: path/sessionId no cambian para una instancia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apariencia (y acento): el tema de Monaco sale de las variables de <html>, ya aplicadas.
  useEffect(() => {
    applyMonacoTheme();
  }, [palette, accent]);

  // Fuente
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, fontFamily });
  }, [fontSize, fontFamily]);

  // Lenguaje elegido a mano
  useEffect(() => {
    const m = modelRef.current;
    if (m) monaco.editor.setModelLanguage(m, language);
  }, [language]);

  // Foco y Guardar (Ctrl+S por defecto, configurable) cuando el editor es visible, también dentro de Monaco.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      editorRef.current?.layout();
      editorRef.current?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut("editor.save", e)) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".xterm")) return;
      // Fase de captura: antes de que Monaco lo tome para otra cosa.
      e.preventDefault();
      e.stopPropagation();
      void saveRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [active]);

  const saveKeys = useShortcutText("editor.save");
  const openMainSettings = useUi((s) => s.openSettings);
  const openSettings = onOpenSettings ?? openMainSettings;

  return (
    <div className="ed-root">
      <div className="ed-body">
        <div ref={hostRef} className="ed-host" style={{ visibility: state.kind === "ready" ? "visible" : "hidden" }} />
        {state.kind === "loading" && (
          <div className="ed-overlay">
            <div className="spinner" />
            <span>Abriendo {path}…</span>
          </div>
        )}
        {state.kind === "error" && (
          <div className="ed-overlay">
            <div className="ed-error">
              {state.tooLarge ? <FileWarning size={28} /> : <AlertTriangle size={28} />}
              <strong>{state.title}</strong>
              <p>{state.message}</p>
              <div className="ed-error-actions">
                <button className="btn btn-sm" onClick={() => void load()}>
                  <RotateCw size={14} /> Reintentar
                </button>
                {state.tooLarge && (
                  <button className="btn btn-sm" onClick={openSettings}>
                    <SettingsIcon size={14} /> Abrir ajustes
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="ed-status">
        <span className="ed-path mono" title={path}>
          {/* Marcas LTR: con direction:rtl (elipsis al principio) la "/" inicial no se mueve al final. */}
          {`\u200e${path}\u200e`}
        </span>
        {state.kind === "ready" && (
          <>
            <span className={dirty ? "ed-state ed-dirty" : "ed-state ed-clean"}>
              <span className="ed-state-dot" />
              {saving ? "Guardando…" : dirty ? "Sin guardar" : "Guardado"}
            </span>
            <span className="ed-sep" />
            <span className="ed-meta">
              Ln {cursor.line}, Col {cursor.col}
              {cursor.sel > 0 && ` (${cursor.sel} sel.)`}
            </span>
            <span className="ed-meta" title={info.modified ? `Modificado: ${formatDate(info.modified)}` : undefined}>
              {formatBytes(info.size)}
            </span>
            <select
              className="ed-lang"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              title="Lenguaje"
              aria-label="Lenguaje"
            >
              {!LANGUAGE_CHOICES.includes(language) && <option value={language}>{languageLabel(language)}</option>}
              {LANGUAGE_CHOICES.map((l) => (
                <option key={l} value={l}>
                  {languageLabel(l)}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          className="icon-btn ed-btn"
          onClick={() => void reload()}
          title={offline ? "Sin conexión con el servidor" : "Recargar desde el servidor"}
          disabled={saving || offline}
        >
          <RotateCw size={14} />
        </button>
        <button
          className="icon-btn ed-btn"
          onClick={() => void save()}
          title={offline ? "Sin conexión: no se puede guardar" : withShortcut("Guardar", saveKeys)}
          disabled={state.kind !== "ready" || saving || offline}
        >
          <Save size={14} />
        </button>
      </div>
    </div>
  );
}

export default RemoteEditor;
