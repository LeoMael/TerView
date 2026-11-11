// Piezas comunes del panel y la paleta: campo de variable con sugerencias, vista previa y resultado.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Clock, Copy, RefreshCw, Scissors, X } from "lucide-react";
import { errorMessage } from "../../api/core";
import type { ExecResult } from "../../api/types";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import type { CatalogVar } from "./catalog";
import { getSuggestions, type CommandItem, type Suggestion } from "./state";
import { VAR_RE, parseVars, renderTemplate, varLabel } from "./template";

// ───────── Valores recordados por sesión (contenedor elegido, etc.) ─────────

const lastValues = new Map<string, Record<string, string>>();

export function initialValues(sessionId: string, item: CommandItem): Record<string, string> {
  const remembered = lastValues.get(sessionId) ?? {};
  const out: Record<string, string> = {};
  for (const v of parseVars(item.command)) {
    // Las variables con valor por defecto empiezan vacías (se ve el defecto como placeholder).
    if (v.default === undefined && remembered[v.name]) out[v.name] = remembered[v.name];
  }
  return out;
}

export function rememberValues(sessionId: string, values: Record<string, string>) {
  const prev = lastValues.get(sessionId) ?? {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(values)) if (v) next[k] = v;
  lastValues.set(sessionId, next);
}

// ───────── Etiquetas ─────────

export function CommandTags({ item }: { item: CommandItem }) {
  return (
    <span className="cmd-tags">
      {item.dangerous && <span className="cmd-tag cmd-tag-danger">peligroso</span>}
      {item.sudo && <span className="cmd-tag cmd-tag-sudo">sudo</span>}
      {item.readOnly && !item.dangerous && <span className="cmd-tag cmd-tag-read">lectura</span>}
    </span>
  );
}

// ───────── Plantilla resaltada ─────────

/** Muestra el comando con las variables pendientes resaltadas. */
export function HighlightedCommand({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(VAR_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(
      <span key={i++} className="cmd-var-ph">
        {m[0]}
      </span>,
    );
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function Preview({ item, values }: { item: CommandItem; values: Record<string, string> }) {
  const text = useMemo(() => renderTemplate(item.command, values), [item.command, values]);
  return (
    <pre className={`cmd-preview${item.dangerous ? " danger" : ""}`}>
      <span className="cmd-prompt">$ </span>
      <HighlightedCommand text={text} />
    </pre>
  );
}

// ───────── Campo de variable (combobox) ─────────

interface VarFieldProps {
  name: string;
  spec: CatalogVar | undefined;
  value: string;
  onChange: (v: string) => void;
  sessionId: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  /** Enter sin lista abierta. */
  onEnter?: (e: React.KeyboardEvent) => void;
  /** Muestra "sugeridos desde el servidor: …" bajo el campo. */
  showHint?: boolean;
}

export function VarField({
  name,
  spec,
  value,
  onChange,
  sessionId,
  disabled,
  autoFocus,
  compact,
  onEnter,
  showHint,
}: VarFieldProps) {
  const [server, setServer] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [filterOn, setFilterOn] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = (refresh = false) => {
    if (!spec?.suggest || !sessionId) return;
    setLoading(true);
    setLoadError(null);
    getSuggestions(sessionId, spec.suggest, refresh)
      .then((s) => setServer(s))
      .catch((e) => {
        setServer([]);
        setLoadError(errorMessage(e));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!disabled) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.suggest, sessionId, disabled]);

  const all = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const add = (s: Suggestion) => {
      if (!s.value || seen.has(s.value)) return;
      seen.add(s.value);
      out.push(s);
    };
    for (const o of spec?.options ?? []) add({ value: o });
    for (const s of server ?? []) add(s);
    return out;
  }, [spec?.options, server]);

  const shown = useMemo(() => {
    if (!filterOn || !value) return all;
    const q = value.toLowerCase();
    return all.filter((s) => s.value.toLowerCase().includes(q) || s.detail?.toLowerCase().includes(q));
  }, [all, value, filterOn]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (hi < 0) return;
    listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const pick = (s: Suggestion) => {
    onChange(s.value);
    setOpen(false);
    setHi(-1);
  };

  const hasList = all.length > 0 || !!spec?.suggest;
  const label = spec?.label ?? varLabel(name);

  return (
    <div className={`cmd-var${compact ? " compact" : ""}`}>
      <label className="cmd-var-label" htmlFor={`cmdvar-${name}`}>
        {label}
        {spec?.default !== undefined && <span className="faint"> · por defecto {spec.default || "vacío"}</span>}
      </label>
      <div className={`cmd-combo${open ? " open" : ""}`} ref={wrapRef}>
        <input
          id={`cmdvar-${name}`}
          className="input mono"
          value={value}
          placeholder={spec?.default ?? ""}
          disabled={disabled}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            onChange(e.target.value);
            setFilterOn(true);
            if (all.length) setOpen(true);
            setHi(-1);
          }}
          onFocus={() => setFilterOn(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && all.length) {
              e.preventDefault();
              e.stopPropagation();
              if (!open) {
                setOpen(true);
                setHi(0);
              } else setHi((h) => Math.min(shown.length - 1, h + 1));
            } else if (e.key === "ArrowUp" && open) {
              e.preventDefault();
              e.stopPropagation();
              setHi((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              if (open && hi >= 0 && shown[hi] && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                pick(shown[hi]);
              } else {
                setOpen(false);
                onEnter?.(e);
              }
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        {hasList && (
          <button
            type="button"
            className="cmd-combo-btn"
            tabIndex={-1}
            disabled={disabled}
            title="Ver opciones"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setFilterOn(false);
              setOpen((o) => !o);
            }}
          >
            {loading ? <span className="spinner cmd-spinner-xs" /> : <ChevronDown size={14} />}
          </button>
        )}
        {open && (
          <div className="cmd-combo-list" ref={listRef} role="listbox">
            {shown.length === 0 && (
              <div className="cmd-combo-empty">
                {loading ? "Consultando el servidor…" : loadError ? "No se pudieron obtener sugerencias" : "Sin opciones"}
              </div>
            )}
            {shown.map((s, i) => (
              <div
                key={s.value}
                role="option"
                aria-selected={s.value === value}
                className={`cmd-combo-item${i === hi ? " hi" : ""}${s.value === value ? " sel" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                onMouseEnter={() => setHi(i)}
              >
                <span className="mono">{s.value}</span>
                {s.detail && <span className="faint">{s.detail}</span>}
                {s.value === value && <Check size={13} />}
              </div>
            ))}
            {spec?.suggest && (
              <button
                type="button"
                className="cmd-combo-refresh"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => load(true)}
              >
                <RefreshCw size={12} /> Volver a consultar el servidor
              </button>
            )}
          </div>
        )}
      </div>
      {showHint && spec?.suggest && server && server.length > 0 && (
        <div className="cmd-var-hint" title={server.map((s) => s.value).join(" · ")}>
          sugeridos desde el servidor: {server.slice(0, 6).map((s) => s.value).join(" · ")}
          {server.length > 6 && ` · +${server.length - 6}`}
        </div>
      )}
      {showHint && spec?.suggest && server && server.length === 0 && !loading && (
        <div className="cmd-var-hint">{loadError ? "no se pudieron obtener sugerencias" : "el servidor no devolvió opciones"}</div>
      )}
    </div>
  );
}

// ───────── Resultado de "Ejecutar y ver resultado" ─────────

export interface RunState {
  running: boolean;
  command: string;
  result: ExecResult | null;
  error: string | null;
  startedAt: number;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function ResultView({
  state,
  onCancel,
  onClose,
  fill,
}: {
  state: RunState;
  onCancel: () => void;
  onClose?: () => void;
  fill?: boolean;
}) {
  const { running, result, error } = state;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Date.now() - state.startedAt), 200);
    return () => clearInterval(t);
  }, [running, state.startedAt]);

  const copy = async () => {
    if (!result) return;
    const text = result.stderr ? `${result.stdout}${result.stdout.endsWith("\n") || !result.stdout ? "" : "\n"}${result.stderr}` : result.stdout;
    try {
      await clipboard.write(text);
      toast.success("Salida copiada");
    } catch (e) {
      toast.error("No se pudo copiar", e);
    }
  };

  const ok = result && result.exitCode === 0 && !result.timedOut;
  return (
    <div className={`cmd-result${fill ? " fill" : ""}`}>
      <div className="cmd-result-head">
        <span className="section-label">Resultado</span>
        {running && (
          <span className="cmd-result-meta">
            <span className="spinner cmd-spinner-xs" /> Ejecutando… {formatMs(elapsed)}
          </span>
        )}
        {result && (
          <span className="cmd-result-meta">
            <span className={`cmd-exit ${ok ? "ok" : "bad"}`}>
              {result.exitCode === null ? "sin código" : `código ${result.exitCode}`}
            </span>
            <span>
              <Clock size={12} /> {formatMs(result.durationMs)}
            </span>
            {result.timedOut && (
              <span className="cmd-warn">
                <AlertTriangle size={12} /> tiempo agotado
              </span>
            )}
            {result.truncated && (
              <span className="cmd-warn">
                <Scissors size={12} /> salida recortada (2 MB)
              </span>
            )}
          </span>
        )}
        <span className="cmd-spacer" />
        {running && (
          <button className="btn btn-sm" onClick={onCancel}>
            Cancelar
          </button>
        )}
        {result && (
          <button className="icon-btn" title="Copiar salida" onClick={copy}>
            <Copy size={14} />
          </button>
        )}
        {onClose && !running && (
          <button className="icon-btn" title="Cerrar resultado" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="cmd-result-body">
        {error && <div className="cmd-result-error">{error}</div>}
        {result && !result.stdout && !result.stderr && <div className="faint">(sin salida)</div>}
        {result?.stdout && <pre className="cmd-out">{result.stdout}</pre>}
        {result?.stderr && <pre className="cmd-out cmd-err">{result.stderr}</pre>}
      </div>
    </div>
  );
}
