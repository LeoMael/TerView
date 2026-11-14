// Sub-pestaña «Auditoría» de Administración: «Auditar servidor» revisa todo de una vez (sin instalar nada),
// da una nota general y por categoría, lo compara con la auditoría anterior y ofrece el arreglo de cada
// problema (se muestra el comando y se ejecuta solo tras confirmar, como el resto de Administración).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileDown,
  Info,
  KeyRound,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { errorMessage, isApiError } from "../../api/core";
import { audit, type AuditMeta, type AuditReport, type Check, type CheckStatus } from "../../api/audit";
import { localfs } from "../../api/localfs";
import { newExecId } from "../../api/snippets";
import { ai } from "../../api/vulnscan";
import {
  CATEGORIES,
  STATUS_TEXT,
  buildAuditAiMessages,
  compare,
  runAudit,
  statusOrder,
  toHtml,
  toMarkdown,
  useAuditRun,
  type Comparison,
} from "../../features/audit";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { confirmDialog } from "../ui/dialogs";
import { AdmModal } from "./AdmModal";
import { useAdmin } from "./context";
import { MiniMarkdown } from "./MiniMarkdown";
import { PlanModal } from "./PlanReview";
import { CommandActions } from "./vulnUi";
import "./Audit.css";

const ICON: Record<CheckStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle, info: Info, skip: CircleDashed };

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });
}

function gradeClass(g: string | null): string {
  return g ? `au-grade-${g.toLowerCase()}` : "au-grade-none";
}

export function AuditTab({ onOpenVulns }: { onOpenVulns: () => void }) {
  const { sessionId, profileId, serverName, elevation, elev, disabled, askSudo } = useAdmin();
  const step = useAuditRun((s) => s.running[sessionId]);
  const [metas, setMetas] = useState<AuditMeta[]>([]);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [prev, setPrev] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState<Check | null>(null);
  const [fixed, setFixed] = useState<Set<string>>(new Set());
  const [aiOpen, setAiOpen] = useState(false);
  const gen = useRef(0);

  /** Muestra la auditoría `id` (o la última) y la anterior a ella para comparar. */
  const show = useCallback(
    async (id?: string) => {
      const g = ++gen.current;
      try {
        const list = await audit.historyList(profileId);
        if (g !== gen.current) return;
        setMetas(list);
        const i = id ? list.findIndex((m) => m.id === id) : 0;
        if (i < 0 || !list[i]) {
          setReport(null);
          setPrev(null);
          return;
        }
        const [cur, before] = await Promise.all([
          audit.historyGet(profileId, list[i].id),
          list[i + 1] ? audit.historyGet(profileId, list[i + 1].id).catch(() => null) : Promise.resolve(null),
        ]);
        if (g !== gen.current) return;
        setReport(cur);
        setPrev(before);
        setFixed(new Set());
      } catch (e) {
        if (g === gen.current) setError(errorMessage(e));
      } finally {
        if (g === gen.current) setLoading(false);
      }
    },
    [profileId],
  );

  useEffect(() => {
    void show();
  }, [show]);

  const start = async () => {
    setError(null);
    try {
      const r = await runAudit({ sessionId, profileId, elevation });
      await show(r.id);
      toast.success("Auditoría terminada", r.score !== null ? `Nota ${r.score}/100 (${r.grade})` : r.summary);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const cmp = useMemo(() => (report ? compare(report, prev) : null), [report, prev]);

  const exportAs = async (format: "md" | "html") => {
    if (!report) return;
    let path: string | null;
    try {
      path = await saveFileDialog({
        title: "Exportar auditoría",
        defaultPath: `auditoria-${report.createdAt.slice(0, 10)}.${format}`,
        filters: [{ name: format === "md" ? "Markdown" : "HTML", extensions: [format] }],
      });
    } catch (e) {
      toast.error("No se pudo abrir el diálogo para guardar", e);
      return;
    }
    if (!path) return;
    if (!path.toLowerCase().endsWith(`.${format}`)) path += `.${format}`;
    try {
      await localfs.writeText(path, format === "md" ? toMarkdown(report, serverName, cmp) : toHtml(report, serverName, cmp));
      toast.success("Auditoría exportada", path);
    } catch (e) {
      toast.error("No se pudo exportar", e);
    }
  };

  const remove = async () => {
    if (!report) return;
    const yes = await confirmDialog({ title: "Borrar auditoría", message: `¿Borrar la auditoría del ${when(report.createdAt)}?`, confirmText: "Borrar", danger: true });
    if (!yes) return;
    try {
      await audit.historyDelete(profileId, report.id);
      await show();
    } catch (e) {
      toast.error("No se pudo borrar", e);
    }
  };

  const running = step !== undefined;

  return (
    <div className="adm-pane au-root">
      <div className="adm-toolbar">
        <button className="btn btn-sm btn-primary" onClick={() => void start()} disabled={disabled || running} title="Revisa todo sin instalar nada en el servidor">
          {running ? <span className="spinner adm-spinner-btn" /> : <ShieldCheck size={13} />}
          {running ? step : "Auditar servidor"}
        </button>
        {!elevation && elev.canAskSudo && !running && (
          <button className="btn btn-sm" onClick={askSudo} title="Con sudo se comprueba todo">
            <KeyRound size={13} /> Con sudo…
          </button>
        )}
        {metas.length > 0 && (
          <select
            className="input au-history"
            value={report?.id ?? ""}
            onChange={(e) => void show(e.target.value)}
            aria-label="Auditorías anteriores"
            disabled={running}
          >
            {metas.map((m) => (
              <option key={m.id} value={m.id}>
                {when(m.createdAt)} · {m.score ?? "—"} {m.grade ?? ""}
                {m.elevated ? "" : " · sin sudo"}
              </option>
            ))}
          </select>
        )}
        <span className="au-spacer" />
        {report && (
          <>
            <button className="btn btn-sm" onClick={() => setAiOpen(true)} title="Explicación en lenguaje simple (antes ves qué se envía)">
              <Sparkles size={13} /> Explicar con IA
            </button>
            <button className="btn btn-sm" onClick={() => void exportAs("md")} title="Exportar a Markdown">
              <FileDown size={13} /> Markdown
            </button>
            <button className="btn btn-sm" onClick={() => void exportAs("html")} title="Exportar a HTML">
              <FileDown size={13} /> HTML
            </button>
            <button className="icon-btn" onClick={() => void remove()} title="Borrar esta auditoría" aria-label="Borrar esta auditoría">
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="adm-banner adm-banner-warn" role="alert">
          <AlertTriangle size={14} />
          <span className="adm-banner-text">{error}</span>
        </div>
      )}

      <div className="au-scroll">
        {loading ? (
          <div className="empty-state">
            <span className="spinner" />
          </div>
        ) : !report ? (
          <div className="empty-state">
            <ShieldCheck size={22} />
            <div>Revisa SSH, usuarios, red, actualizaciones, certificados, contenedores y permisos de una vez.</div>
            <div className="faint">Solo lee: no instala ni cambia nada.</div>
          </div>
        ) : (
          <Report report={report} cmp={cmp} fixed={fixed} onFix={setFixing} onOpenVulns={onOpenVulns} canFix={!!elevation && !disabled} />
        )}
      </div>

      {fixing && fixing.fix && (
        <PlanModal
          title={`Arreglar: ${fixing.title}`}
          plan={{ action: `Auditoría: ${fixing.title}`, steps: fixing.fix.command.split("\n"), danger: fixing.fix.danger, timeoutSecs: 900 }}
          confirmWord={fixing.fix.danger ? "ARREGLAR" : undefined}
          runLabel="Arreglar"
          onCancel={() => setFixing(null)}
          onDone={() => {
            setFixed((s) => new Set(s).add(fixing.id));
            setFixing(null);
          }}
        >
          {fixing.fix.note && (
            <div className={fixing.fix.danger ? "adm-banner adm-banner-warn" : "faint"}>
              {fixing.fix.danger && <AlertTriangle size={14} />} {fixing.fix.note}
            </div>
          )}
        </PlanModal>
      )}
      {aiOpen && report && <AuditAiDialog report={report} profileId={profileId} onDone={setReport} onClose={() => setAiOpen(false)} />}
    </div>
  );
}

function Report({
  report,
  cmp,
  fixed,
  onFix,
  onOpenVulns,
  canFix,
}: {
  report: AuditReport;
  cmp: Comparison | null;
  fixed: Set<string>;
  onFix: (c: Check) => void;
  onOpenVulns: () => void;
  canFix: boolean;
}) {
  const { sessionId } = useAdmin();
  return (
    <>
      <div className="au-summary">
        <div className={`au-grade ${gradeClass(report.grade)}`} aria-label={`Nota ${report.grade ?? "sin nota"}`}>
          {report.grade ?? "—"}
        </div>
        <div className="au-summary-text">
          <div className="au-score">
            {report.score ?? "—"}
            <span className="faint">/100</span>
            {cmp && cmp.scoreDelta !== null && cmp.scoreDelta !== 0 && (
              <span className={cmp.scoreDelta > 0 ? "au-delta au-better" : "au-delta au-worse"}>
                {cmp.scoreDelta > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                {Math.abs(cmp.scoreDelta)}
              </span>
            )}
          </div>
          <div>{report.summary}</div>
          <div className="faint">
            {when(report.createdAt)}
            {report.os ? ` · ${report.os}` : ""}
            {report.elevated ? " · con sudo" : " · sin sudo"}
            {cmp && ` · frente al ${when(cmp.previousAt)}: ${cmp.better} mejoran, ${cmp.worse} empeoran`}
          </div>
        </div>
      </div>

      <div className="au-cats">
        {report.categories.map((c) => (
          <a key={c.id} className="au-cat" href={`#au-${c.id}`} onClick={(e) => {
            e.preventDefault();
            document.getElementById(`au-${sessionId}-${c.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
          }}>
            <span className="au-cat-name">{c.label}</span>
            <span className={`au-cat-grade ${gradeClass(c.grade)}`}>{c.score === null ? "—" : `${c.score} ${c.grade}`}</span>
            <span className="au-bar">
              <span className={gradeClass(c.grade)} style={{ width: `${c.score ?? 0}%` }} />
            </span>
            <span className="faint au-cat-sum">{c.summary}</span>
          </a>
        ))}
      </div>

      {report.ai && (
        <div className="vs-ai-answer au-ai">
          <div className="vs-ai-mark">
            <Bot size={13} /> Texto generado por IA ({report.ai.model}): revísalo.
          </div>
          <MiniMarkdown text={report.ai.text} codeActions={(code) => <CommandActions sessionId={sessionId} text={code} />} />
        </div>
      )}

      {CATEGORIES.map((cat) => {
        const list = report.checks.filter((c) => c.category === cat.id).sort((a, b) => statusOrder(a.status) - statusOrder(b.status));
        if (!list.length) return null;
        return (
          <section key={cat.id} className="au-section" id={`au-${sessionId}-${cat.id}`}>
            <div className="section-label">{cat.label}</div>
            {list.map((c) => (
              <CheckRow
                key={c.id}
                check={c}
                change={cmp?.changes.get(c.id) ?? null}
                fixed={fixed.has(c.id)}
                canFix={canFix}
                onFix={() => onFix(c)}
                onOpenVulns={c.id === "updates.vulns" ? onOpenVulns : undefined}
              />
            ))}
          </section>
        );
      })}
    </>
  );
}

function CheckRow({
  check,
  change,
  fixed,
  canFix,
  onFix,
  onOpenVulns,
}: {
  check: Check;
  change: "better" | "worse" | "new" | null;
  fixed: boolean;
  canFix: boolean;
  onFix: () => void;
  onOpenVulns?: () => void;
}) {
  const { sessionId } = useAdmin();
  const problem = check.status === "bad" || check.status === "warn";
  const [open, setOpen] = useState(check.status === "bad");
  const Icon = ICON[check.status];
  const expandable = check.items.length > 0 || (problem && !!check.fix);
  return (
    <div className={`au-check au-${check.status}`}>
      <div className="au-check-head">
        <button className="au-toggle" onClick={() => setOpen(!open)} disabled={!expandable} aria-expanded={open} aria-label={open ? "Ocultar detalle" : "Ver detalle"}>
          {expandable ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="au-toggle-sp" />}
        </button>
        <Icon size={14} className="au-icon" aria-label={STATUS_TEXT[check.status]} />
        <span className="au-title">{check.title}</span>
        <span className="au-detail">{check.detail}</span>
        {change && <span className={`au-chip au-chip-${change}`}>{change === "better" ? "mejoró" : change === "worse" ? "empeoró" : "nuevo"}</span>}
        {fixed && <span className="au-chip au-chip-better">arreglado: vuelve a auditar</span>}
        {onOpenVulns && check.status === "skip" && (
          <button className="btn btn-sm" onClick={onOpenVulns}>
            Analizar
          </button>
        )}
        {problem && check.fix && !check.fix.manual && !fixed && (
          <button className={check.fix.danger ? "btn btn-sm btn-danger" : "btn btn-sm"} onClick={onFix} disabled={!canFix} title={canFix ? "Muestra el comando antes de ejecutarlo" : "Necesitas root o sudo"}>
            <Wrench size={12} /> Arreglar
          </button>
        )}
      </div>
      {open && expandable && (
        <div className="au-body">
          {check.items.length > 0 && (
            <ul className="au-items">
              {check.items.slice(0, 100).map((i) => (
                <li key={i} className="mono">
                  {i}
                </li>
              ))}
              {check.items.length > 100 && <li className="faint">… y {check.items.length - 100} más</li>}
            </ul>
          )}
          {problem && check.fix && (
            <div className="au-fix">
              <div className="faint">
                {check.fix.manual ? "Para revisar a mano" : "Arreglo"}
                {check.fix.note ? ` · ${check.fix.note}` : ""}
              </div>
              <pre className="adm-cmd adm-cmd-sm">{check.fix.command}</pre>
              {check.fix.manual && (
                <div className="au-fix-actions">
                  <CommandActions sessionId={sessionId} text={check.fix.command} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** «Explicar con IA»: enseña el texto EXACTO antes de enviarlo (sin usuarios, IP, rutas ni comandos). */
function AuditAiDialog({
  report,
  profileId,
  onDone,
  onClose,
}: {
  report: AuditReport;
  profileId: string;
  onDone: (r: AuditReport) => void;
  onClose: () => void;
}) {
  const settings = useSettings((s) => s.settings.ai);
  const [includeOk, setIncludeOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef<string | null>(null);
  const messages = useMemo(() => buildAuditAiMessages(report, includeOk), [report, includeOk]);
  const preview = messages.map((m) => `── ${m.role === "system" ? "Instrucciones (system)" : "Mensaje (user)"} ──\n${m.content}`).join("\n\n");

  const send = async () => {
    const id = newExecId();
    reqId.current = id;
    setBusy(true);
    setError(null);
    try {
      const r = await ai.chat(messages, id);
      const saved = await audit.setAi(profileId, report.id, { model: r.model, createdAt: new Date().toISOString(), text: r.text });
      onDone(saved);
      onClose();
    } catch (e) {
      if (!isApiError(e, "Canceled")) setError(errorMessage(e));
    } finally {
      reqId.current = null;
      setBusy(false);
    }
  };
  const cancel = () => {
    if (reqId.current) void ai.cancel(reqId.current);
  };

  return (
    <AdmModal title="Explicar con IA: esto es lo que se enviará" onClose={busy ? cancel : onClose} width={760}>
      <div className="modal-body vs-ai-body">
        <p className="faint">
          A <span className="mono">{settings.baseUrl || "(sin URL)"}</span> con <span className="mono">{settings.model || "(sin modelo)"}</span>. Solo notas
          y títulos: sin nombre del servidor, IP, usuarios, rutas ni comandos.
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={includeOk} disabled={busy} onChange={(e) => setIncludeOk(e.target.checked)} />
          Incluir también lo que está bien
        </label>
        <pre className="mono vs-ai-preview" tabIndex={0} aria-label="Texto exacto que se enviará">
          {preview}
        </pre>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="modal-footer">
        {busy ? (
          <button className="btn" onClick={cancel}>
            <Square size={13} /> Cancelar
          </button>
        ) : (
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
        )}
        <button className="btn btn-primary" onClick={() => void send()} disabled={busy}>
          {busy ? <span className="spinner adm-spinner-btn" /> : <Send size={13} />}
          {busy ? "Esperando a la IA…" : report.ai ? "Enviar de nuevo" : "Enviar"}
        </button>
      </div>
    </AdmModal>
  );
}
