// Una terminal (xterm.js + shell remota). Se mantiene montada aunque esté oculta.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ClipboardPaste, Copy, Eraser, Search, TextSelect, X } from "lucide-react";
import { useSettings } from "../../stores/settings";
import { TermController, type ConnState, type SearchResults, type TermStatus } from "./termController";

interface TerminalViewProps {
  sessionId: string;
  /** Es la terminal visible (pestaña de conexión activa y sub-pestaña elegida). */
  visible: boolean;
  disabled: boolean;
  /** Estado de la conexión de la pestaña. */
  connState: ConnState;
  /** Sube en cada reconexión exitosa: reabrir la shell si murió con la caída. */
  reconnectCount: number;
  onStatus: (s: TermStatus) => void;
  /** Entrega el controlador al montar (y null al desmontar). */
  onController?: (ctrl: TermController | null) => void;
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

export function TerminalView({
  sessionId,
  visible,
  disabled,
  connState,
  reconnectCount,
  onStatus,
  onController,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<TermController | null>(null);
  const onStatusRef = useRef(onStatus);
  const onControllerRef = useRef(onController);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** Contador que abre (o vuelve a enfocar) la barra de búsqueda. */
  const [searchSeq, setSearchSeq] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  /** El controlador como estado (para renderizar la búsqueda sin leer refs al renderizar). */
  const [ctrlState, setCtrlState] = useState<TermController | null>(null);
  const fontSize = useSettings((s) => s.settings.terminalFontSize);
  const fontFamily = useSettings((s) => s.settings.terminalFontFamily);
  const lastReconnect = useRef(reconnectCount);

  useLayoutEffect(() => {
    onStatusRef.current = onStatus;
    onControllerRef.current = onController;
  });

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchSeq((n) => n + 1);
  }, []);

  // Crear/destruir la terminal. Ajustes y estado se pasan después sin recrearla.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const s = useSettings.getState().settings;
    const ctrl = new TermController(host, {
      sessionId,
      fontSize: s.terminalFontSize,
      fontFamily: s.terminalFontFamily,
      disabled,
      connState,
      onStatus: (st) => onStatusRef.current(st),
      onSearchRequest: openSearch,
    });
    ctrlRef.current = ctrl;
    setCtrlState(ctrl);
    onControllerRef.current?.(ctrl);
    return () => {
      onControllerRef.current?.(null);
      setCtrlState(null);
      ctrl.dispose();
      ctrlRef.current = null;
    };
    // `disabled`/`connState` iniciales bastan: los cambios llegan por sus setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    ctrlRef.current?.setConnState(connState);
  }, [connState]);

  useEffect(() => {
    if (reconnectCount > lastReconnect.current) ctrlRef.current?.reconnected();
    lastReconnect.current = reconnectCount;
  }, [reconnectCount]);

  useEffect(() => {
    ctrlRef.current?.setFont(fontSize, fontFamily);
  }, [fontSize, fontFamily]);

  useEffect(() => {
    ctrlRef.current?.setDisabled(disabled);
  }, [disabled]);

  useEffect(() => {
    if (visible) ctrlRef.current?.show(!searchOpen);
    else setMenu(null);
    // Solo al cambiar la visibilidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    ctrlRef.current?.clearSearch();
    ctrlRef.current?.focus();
  }, []);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    setMenu({ x: e.clientX, y: e.clientY, hasSelection: ctrl.hasSelection() });
  };

  return (
    <div className={`term-view${visible ? " visible" : ""}`} onContextMenu={onContextMenu}>
      <div className="term-host" ref={hostRef} />
      {searchOpen && ctrlState && <TermSearch ctrl={ctrlState} focusSeq={searchSeq} onClose={closeSearch} />}
      {menu && (
        <TermMenu
          {...menu}
          onClose={() => {
            setMenu(null);
            ctrlRef.current?.focus();
          }}
          onCopy={() => ctrlRef.current?.copy()}
          onPaste={() => ctrlRef.current?.paste()}
          onSelectAll={() => ctrlRef.current?.selectAll()}
          onClear={() => ctrlRef.current?.clear()}
          onSearch={openSearch}
        />
      )}
    </div>
  );
}

// ───────── Barra de búsqueda ─────────

interface TermSearchProps {
  ctrl: TermController;
  /** Cambia cada vez que se pide abrir: vuelve a enfocar y seleccionar el texto. */
  focusSeq: number;
  onClose: () => void;
}

function TermSearch({ ctrl, focusSeq, onClose }: TermSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);

  useEffect(() => ctrl.onSearchResults(setResults), [ctrl]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusSeq]);

  // Búsqueda incremental al escribir o cambiar mayúsculas.
  useEffect(() => {
    if (!query) {
      ctrl.clearSearch();
      setResults(null);
      return;
    }
    ctrl.findNext(query, caseSensitive, true);
  }, [ctrl, query, caseSensitive]);

  const next = () => ctrl.findNext(query, caseSensitive);
  const prev = () => ctrl.findPrevious(query, caseSensitive);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    } else if (e.altKey && e.code === "KeyC") {
      e.preventDefault();
      setCaseSensitive((v) => !v);
    }
  };

  let counter = "";
  if (query && results) {
    if (results.count === 0) counter = "Sin resultados";
    else if (results.index >= 0) counter = `${results.index + 1} de ${results.count}`;
    else counter = `${results.count}`;
  }

  return (
    <div className="term-search" role="search" onKeyDown={onKey} onContextMenu={(e) => e.stopPropagation()}>
      <Search size={13} className="term-search-icon" aria-hidden />
      <input
        ref={inputRef}
        className="term-search-input"
        value={query}
        placeholder="Buscar"
        aria-label="Buscar en la terminal"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
      />
      <span className={`term-search-count${results?.count === 0 && query ? " none" : ""}`} aria-live="polite">
        {counter}
      </span>
      <button
        type="button"
        className={`term-search-btn term-search-case${caseSensitive ? " on" : ""}`}
        aria-pressed={caseSensitive}
        title="Distinguir mayúsculas (Alt+C)"
        aria-label="Distinguir mayúsculas"
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button
        type="button"
        className="term-search-btn"
        title="Anterior (Mayús+Enter)"
        aria-label="Coincidencia anterior"
        disabled={!query}
        onClick={prev}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="term-search-btn"
        title="Siguiente (Enter)"
        aria-label="Coincidencia siguiente"
        disabled={!query}
        onClick={next}
      >
        <ChevronDown size={14} />
      </button>
      <button type="button" className="term-search-btn" title="Cerrar (Esc)" aria-label="Cerrar búsqueda" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

// ───────── Menú contextual ─────────

interface TermMenuProps extends MenuState {
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSearch: () => void;
}

function TermMenu({ x, y, hasSelection, onClose, onCopy, onPaste, onSelectAll, onClear, onSearch }: TermMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Mantener el menú dentro de la ventana.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onBlur = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="context-menu term-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onMenuKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button role="menuitem" disabled={!hasSelection} onClick={run(onCopy)}>
        <Copy size={14} /> Copiar <kbd>Ctrl+Mayús+C</kbd>
      </button>
      <button role="menuitem" onClick={run(onPaste)}>
        <ClipboardPaste size={14} /> Pegar <kbd>Ctrl+Mayús+V</kbd>
      </button>
      <hr />
      <button role="menuitem" onClick={run(onSelectAll)}>
        <TextSelect size={14} /> Seleccionar todo
      </button>
      <button role="menuitem" onClick={run(onSearch)}>
        <Search size={14} /> Buscar… <kbd>Ctrl+Mayús+F</kbd>
      </button>
      <button role="menuitem" onClick={run(onClear)}>
        <Eraser size={14} /> Limpiar
      </button>
    </div>,
    document.body,
  );
}
