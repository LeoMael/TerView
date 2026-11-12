// Visor de logs: últimas N líneas, búsqueda, refresco en vivo y «seguir en la terminal».
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Copy, RefreshCw, Search, TerminalSquare } from "lucide-react";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { AdmModal } from "../Admin/AdmModal";
import { useCt, type LogsTarget } from "./context";

const TAILS = [100, 500, 1000, 5000];
const LIVE_MS = 2000;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function LogsDialog({ target, onClose }: { target: LogsTarget; onClose: () => void }) {
  const ct = useCt();
  const [tail, setTail] = useState(500);
  const [timestamps, setTimestamps] = useState(false);
  const [live, setLive] = useState(false);
  const [search, setSearch] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    const r = await ct.run([target.build(tail, timestamps)], 60);
    inFlight.current = false;
    setLoading(false);
    if (r.result && (r.ok || r.result.stdout)) {
      setText(r.result.stdout);
      setTruncated(r.result.truncated);
      setError(r.ok ? null : r.error);
    } else {
      setError(r.error ?? "No se pudieron leer los logs");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ct.run, target, tail, timestamps]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => void load(), LIVE_MS);
    return () => window.clearInterval(t);
  }, [live, load]);

  // Mantiene el final a la vista si el usuario estaba abajo.
  useEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const lines = useMemo(() => (text ?? "").replace(/\n$/, "").split("\n"), [text]);
  const re = useMemo(() => (search ? new RegExp(escapeRe(search), "gi") : null), [search]);
  const matchCount = useMemo(() => (re ? lines.filter((l) => l.search(re) >= 0).length : 0), [lines, re]);
  const shown = onlyMatches && re ? lines.filter((l) => l.search(re) >= 0) : lines;

  const renderLine = (l: string, i: number) => {
    if (!re) return <Fragment key={i}>{l + "\n"}</Fragment>;
    const parts = l.split(new RegExp(`(${escapeRe(search)})`, "gi"));
    return (
      <Fragment key={i}>
        {parts.map((p, j) => (j % 2 === 1 ? <mark key={j}>{p}</mark> : p))}
        {"\n"}
      </Fragment>
    );
  };

  return (
    <AdmModal title={target.title} onClose={onClose} width={980}>
      <div className="modal-body ct-logs">
        <div className="ct-toolbar">
          <label className="ct-inline">
            Últimas
            <select className="select ct-select-sm" value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="Líneas">
              {TAILS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            líneas
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Fecha y hora
          </label>
          <label className="checkbox" title={`Vuelve a leer cada ${LIVE_MS / 1000} s`}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> En vivo
          </label>
          <div className="ct-search">
            <Search size={13} />
            <input className="input" placeholder="Buscar en los logs" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar en los logs" />
          </div>
          {search && (
            <>
              <span className="faint">{matchCount} líneas</span>
              <label className="checkbox">
                <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} /> Solo esas
              </label>
            </>
          )}
          <span className="ct-grow" />
          <button className="icon-btn" title="Actualizar" aria-label="Actualizar" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "ct-spin" : undefined} />
          </button>
          <button
            className="icon-btn"
            title="Copiar todo"
            aria-label="Copiar todo"
            onClick={() =>
              clipboard.write(shown.join("\n")).then(
                () => toast.success("Logs copiados"),
                (e) => toast.error("No se pudo copiar", e),
              )
            }
            disabled={!text}
          >
            <Copy size={14} />
          </button>
          <button
            className="btn btn-sm"
            title={ct.render(target.follow(100))}
            onClick={() => {
              if (ct.toTerminal(target.follow(100), true)) onClose();
            }}
          >
            <TerminalSquare size={13} /> Seguir en la terminal
          </button>
        </div>
        {error && (
          <div className="ct-error ct-error-inline" role="alert">
            <AlertTriangle size={14} />
            <pre>{error}</pre>
          </div>
        )}
        {truncated && <div className="ct-warn">La salida era muy grande y se ha recortado: pide menos líneas.</div>}
        <pre
          ref={preRef}
          className="ct-logview"
          tabIndex={0}
          aria-label="Logs"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
          }}
        >
          {text === null ? (loading ? "Leyendo…" : "") : text.trim() === "" ? <span className="faint">(sin líneas de log)</span> : shown.map(renderLine)}
        </pre>
        <div className="faint ct-cmdline mono">{ct.render(target.build(tail, timestamps))}</div>
      </div>
    </AdmModal>
  );
}
