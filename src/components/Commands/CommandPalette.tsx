// Paleta global (Ctrl+Shift+P) sobre la pestaña activa. App la monta una vez; ella misma escucha el atajo.
//   Enter = ejecutar en la terminal · Alt+Enter = insertar · Ctrl+Enter = ejecutar y ver resultado aquí.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, TerminalSquare } from "lucide-react";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { toast } from "../../stores/toasts";
import { CATEGORIES, type Distro } from "./catalog";
import { OPEN_PALETTE_EVENT as OPEN_EVENT, captureBlockedReason, toTerminal, type RunMode } from "./actions";
import { CommandTags, HighlightedCommand, Preview, ResultView, VarField, initialValues, rememberValues } from "./parts";
import { MY_CATEGORY, buildItems, getSessionInfo, searchItems, useSnippets, type CommandItem } from "./state";
import { missingVars, parseVars, renderTemplate, varLabel } from "./template";
import { useRun } from "./useRun";
import "./Commands.css";

const MAX_RESULTS = 80;
const CAT_ORDER = new Map<string, number>([MY_CATEGORY, ...CATEGORIES].map((c, i) => [c, i]));

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "P" || e.key === "p" || e.code === "KeyP")) {
        // Fase de captura: antes de que la terminal lo convierta en ^P.
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return <PaletteView onClose={() => setOpen(false)} />;
}

type Phase = { kind: "list" } | { kind: "vars"; item: CommandItem; mode: RunMode } | { kind: "result"; item: CommandItem };

function PaletteView({ onClose }: { onClose: () => void }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
  const mine = useSnippets((s) => s.list);
  const mineLoaded = useSnippets((s) => s.loaded);
  const loadMine = useSnippets((s) => s.load);
  const projects = useProfiles((s) => s.projects);

  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [distro, setDistro] = useState<Distro | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "list" });
  const [values, setValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<Element | null>(document.activeElement);

  const connected = !!tab && tab.status === "connected";
  const sessionId = connected ? tab.sessionId : null;
  const { state: run, start, cancel, clear } = useRun(sessionId);

  useEffect(() => {
    if (!mineLoaded) void loadMine();
  }, [mineLoaded, loadMine]);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void getSessionInfo(sessionId).then((i) => alive && setDistro(i.distro));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const close = () => {
    onClose();
    const el = restoreFocus.current;
    if (el instanceof HTMLElement) setTimeout(() => el.focus(), 0);
  };

  const items = useMemo(
    () => (tab ? buildItems(distro, mine, tab.profileId, projects) : []),
    [tab, distro, mine, projects],
  );
  const results = useMemo(() => {
    if (!query.trim()) {
      return [...items]
        .sort((a, b) => (CAT_ORDER.get(a.category) ?? 99) - (CAT_ORDER.get(b.category) ?? 99))
        .slice(0, MAX_RESULTS);
    }
    return searchItems(items, query).slice(0, MAX_RESULTS);
  }, [items, query]);

  useEffect(() => setHi(0), [query]);
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const backToList = () => {
    clear();
    setPhase({ kind: "list" });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const perform = async (item: CommandItem, mode: RunMode, vals: Record<string, string>) => {
    if (!sessionId) return;
    const missing = missingVars(item.command, vals);
    if (missing.length) {
      toast.info(`Completa: ${missing.map(varLabel).join(", ")}`);
      return;
    }
    const cmd = renderTemplate(item.command, vals, { fillMissing: true });
    rememberValues(sessionId, vals);
    if (mode === "capture") {
      const blocked = captureBlockedReason(item);
      if (blocked) {
        toast.info(blocked);
        return;
      }
      setPhase({ kind: "result", item });
      await start(item, cmd);
      return;
    }
    if (await toTerminal(sessionId, item, cmd, mode === "run")) close();
  };

  const choose = (item: CommandItem, mode: RunMode) => {
    if (!sessionId) return;
    if (parseVars(item.command).length > 0) {
      setValues(initialValues(sessionId, item));
      setPhase({ kind: "vars", item, mode });
      return;
    }
    void perform(item, mode, {});
  };

  const modeFromEvent = (e: React.KeyboardEvent): RunMode => (e.ctrlKey ? "capture" : e.altKey ? "insert" : "run");

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(results.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setHi((h) => Math.min(results.length - 1, h + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 8));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = results[hi];
      if (it) choose(it, modeFromEvent(e));
    }
  };

  return (
    <div
      className="cmd-pal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (phase.kind === "list") close();
          else if (!run?.running) backToList();
        }
      }}
    >
      <div className="cmd-pal" role="dialog" aria-label="Paleta de comandos">
        {!tab || !connected ? (
          <div className="cmd-pal-empty">
            <TerminalSquare size={22} />
            <div>
              {!tab
                ? "Abre una conexión para usar la paleta de comandos."
                : "La conexión de la pestaña activa no está disponible."}
            </div>
            <button className="btn btn-sm" autoFocus onClick={close}>
              Cerrar
            </button>
          </div>
        ) : phase.kind === "list" ? (
          <>
            <div className="cmd-pal-search">
              <Search size={15} />
              <input
                ref={inputRef}
                autoFocus
                placeholder={`Buscar comando en ${tab.title}…`}
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKey}
              />
            </div>
            <div className="cmd-pal-list" ref={listRef} role="listbox">
              {results.length === 0 && <div className="cmd-pal-none">Sin resultados para «{query}»</div>}
              {results.map((it, i) => (
                <div
                  key={it.id}
                  role="option"
                  aria-selected={i === hi}
                  className={`cmd-pal-item${i === hi ? " hi" : ""}${it.dangerous ? " danger" : ""}`}
                  onMouseMove={() => i !== hi && setHi(i)}
                  onClick={(e) => choose(it, e.ctrlKey ? "capture" : e.altKey ? "insert" : "run")}
                >
                  <div className="cmd-pal-item-top">
                    <span className="cmd-item-name">{it.name}</span>
                    <CommandTags item={it} />
                    <span className="cmd-spacer" />
                    <span className="cmd-pal-cat">{it.category === MY_CATEGORY ? "★ Mis comandos" : it.category}</span>
                  </div>
                  <div className="cmd-item-cmd mono">
                    <HighlightedCommand text={it.command.split("\n")[0]} />
                  </div>
                </div>
              ))}
            </div>
            <PaletteFooter />
          </>
        ) : phase.kind === "vars" ? (
          <div className="cmd-pal-form">
            <div className="cmd-pal-head">
              <button className="icon-btn" title="Volver (Esc)" onClick={backToList}>
                <ArrowLeft size={15} />
              </button>
              <span className="cmd-item-name">{phase.item.name}</span>
              <CommandTags item={phase.item} />
            </div>
            <div className="cmd-pal-vars">
              {parseVars(phase.item.command).map((v, i) => (
                <VarField
                  key={v.name}
                  name={v.name}
                  compact
                  spec={phase.item.vars?.[v.name] ?? { default: v.default }}
                  value={values[v.name] ?? ""}
                  onChange={(val) => setValues((s) => ({ ...s, [v.name]: val }))}
                  sessionId={sessionId}
                  autoFocus={i === 0}
                  onEnter={(e) => {
                    e.preventDefault();
                    const mode = e.ctrlKey || e.altKey ? modeFromEvent(e) : phase.mode;
                    void perform(phase.item, mode, values);
                  }}
                />
              ))}
            </div>
            <Preview item={phase.item} values={values} />
            <PaletteFooter vars />
          </div>
        ) : (
          <div className="cmd-pal-form">
            <div className="cmd-pal-head">
              <button className="icon-btn" title="Volver (Esc)" onClick={backToList} autoFocus>
                <ArrowLeft size={15} />
              </button>
              <span className="cmd-item-name">{phase.item.name}</span>
              <span className="cmd-spacer" />
            </div>
            {run && <pre className="cmd-preview small">$ {run.command}</pre>}
            {run && <ResultView state={run} onCancel={cancel} fill />}
          </div>
        )}
      </div>
    </div>
  );
}

function PaletteFooter({ vars }: { vars?: boolean }) {
  return (
    <div className="cmd-pal-foot">
      {!vars && (
        <span>
          <kbd>↑↓</kbd> elegir
        </span>
      )}
      <span>
        <kbd>Enter</kbd> ejecutar
      </span>
      <span>
        <kbd>Alt+Enter</kbd> insertar
      </span>
      <span>
        <kbd>Ctrl+Enter</kbd> ver resultado
      </span>
      <span>
        <kbd>Esc</kbd> {vars ? "volver" : "cerrar"}
      </span>
    </div>
  );
}
