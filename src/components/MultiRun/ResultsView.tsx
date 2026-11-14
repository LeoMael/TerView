// Paso 2: progreso y resultados (tabla expandible, lado a lado y comparación de salidas).
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Columns3,
  Copy,
  GitCompareArrows,
  Hourglass,
  KeyRound,
  Pencil,
  RotateCcw,
  Rows3,
  Square,
} from "lucide-react";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import {
  STATUS_LABEL,
  firstLine,
  formatDuration,
  formatGroups,
  formatReport,
  formatTable,
  groupIdentical,
  summarize,
  targetDuration,
} from "../../features/multirun/results";
import { multiRunActions, repeatMultiRun, showSetup, useMultiRun } from "../../features/multirun/store";
import { isFinal, isProblem, type PrivilegeHint, type TargetState, type TargetStatus } from "../../features/multirun/types";

type ViewMode = "table" | "side" | "compare";

const VIEW_KEY = "sshorus.multirun.view";

function readView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "side" || v === "compare" ? v : "table";
  } catch {
    return "table";
  }
}

const PRIV_LABEL: Record<PrivilegeHint, { text: string; tone: "ok" | "warn" | "muted" }> = {
  root: { text: "root", tone: "ok" },
  "sudo-nopasswd": { text: "sudo sin contraseña", tone: "ok" },
  sudo: { text: "sudo pide contraseña", tone: "warn" },
  "maybe-sudo": { text: "sudo: quizá pide contraseña", tone: "warn" },
  user: { text: "sin sudo", tone: "warn" },
  unknown: { text: "acceso desconocido", tone: "muted" },
};

async function copy(text: string, what: string) {
  try {
    await clipboard.write(text);
    toast.success(`${what} copiado`);
  } catch (e) {
    toast.error("No se pudo copiar", e);
  }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function StatusIcon({ status, size = 14 }: { status: TargetStatus; size?: number }) {
  switch (status) {
    case "queued":
      return <Clock size={size} className="mr-st-icon queued" />;
    case "connecting":
    case "running":
      return <span className={`spinner mr-spin ${status}`} style={{ width: size - 2, height: size - 2 }} />;
    case "attention":
      return <KeyRound size={size} className="mr-st-icon attention" />;
    case "ok":
      return <CircleCheck size={size} className="mr-st-icon ok" />;
    case "error":
      return <CircleX size={size} className="mr-st-icon error" />;
    case "timeout":
      return <Hourglass size={size} className="mr-st-icon timeout" />;
    case "canceled":
      return <Ban size={size} className="mr-st-icon canceled" />;
  }
}

function statusText(t: TargetState, now: number): string {
  if (t.status === "running" && t.execStartedAt) return `Ejecutando · ${formatDuration(now - t.execStartedAt)}`;
  if (t.status === "connecting" && t.connectStartedAt) return `Conectando · ${formatDuration(now - t.connectStartedAt)}`;
  return STATUS_LABEL[t.status];
}

function PrivBadge({ t }: { t: TargetState }) {
  if (!t.privilege) return null;
  const p = PRIV_LABEL[t.privilege];
  return <span className={`mr-tag ${p.tone === "warn" ? "warn" : p.tone === "ok" ? "ok" : ""}`}>{p.text}</span>;
}

function RowActions({ t }: { t: TargetState }) {
  return (
    <span className="mr-row-actions">
      {t.status === "attention" && (
        <button className="btn btn-sm mr-resolve" onClick={() => void multiRunActions.resolve(t.profileId)}>
          <KeyRound size={13} /> Resolver
        </button>
      )}
      {!isFinal(t.status) && t.status !== "attention" && (
        <button
          className="icon-btn"
          title="Cancelar este servidor"
          aria-label={`Cancelar ${t.name}`}
          onClick={() => multiRunActions.cancel(t.profileId)}
        >
          <Square size={13} />
        </button>
      )}
      {(isFinal(t.status) || t.status === "attention") && t.status !== "ok" && (
        <button
          className="icon-btn"
          title="Reintentar este servidor"
          aria-label={`Reintentar ${t.name}`}
          onClick={() => multiRunActions.retry(t.profileId)}
        >
          <RotateCcw size={13} />
        </button>
      )}
      {t.result && (
        <button
          className="icon-btn"
          title="Copiar la salida"
          aria-label={`Copiar la salida de ${t.name}`}
          onClick={() => void copy(outputText(t), "Salida")}
        >
          <Copy size={13} />
        </button>
      )}
    </span>
  );
}

function outputText(t: TargetState): string {
  if (!t.result) return t.detail ?? "";
  const out = t.result.stdout.replace(/\n+$/, "");
  const err = t.result.stderr.replace(/\n+$/, "");
  return [out, err ? (out ? `\n${err}` : err) : ""].join("") + "\n";
}

function Output({ t, compact }: { t: TargetState; compact?: boolean }) {
  if (!t.result) {
    return (
      <div className={`mr-out-empty${t.status === "error" || t.status === "attention" ? " problem" : ""}`}>
        {t.detail ?? (isFinal(t.status) ? "Sin salida" : "Esperando resultado…")}
      </div>
    );
  }
  const out = t.result.stdout.replace(/\n+$/, "");
  const err = t.result.stderr.replace(/\n+$/, "");
  return (
    <div className={`mr-out${compact ? " compact" : ""}`}>
      {t.detail && <div className="mr-out-note">{t.detail}</div>}
      {out && <pre className="mono mr-pre">{out}</pre>}
      {err && (
        <>
          <div className="mr-out-label">stderr</div>
          <pre className="mono mr-pre stderr">{err}</pre>
        </>
      )}
      {!out && !err && <div className="mr-out-empty">(sin salida)</div>}
      {t.result.truncated && <div className="mr-out-note">La salida es muy larga y se recortó.</div>}
    </div>
  );
}

// ───────── Vistas ─────────

function TableView({ targets, now }: { targets: TargetState[]; now: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const allOpen = targets.length > 0 && targets.every((t) => open[t.profileId]);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  return (
    <div className="mr-table-wrap">
      <table className="mr-table">
        <thead>
          <tr>
            <th className="mr-c-exp">
              <button
                className="icon-btn"
                aria-label={allOpen ? "Contraer todo" : "Expandir todo"}
                title={allOpen ? "Contraer todo" : "Expandir todo"}
                onClick={() =>
                  setOpen(allOpen ? {} : Object.fromEntries(targets.map((t) => [t.profileId, true])))
                }
              >
                {allOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            </th>
            <th className="mr-c-server">Servidor</th>
            <th className="mr-c-status">Estado</th>
            <th className="mr-c-code">Código</th>
            <th className="mr-c-dur">Duración</th>
            <th>Primera línea</th>
            <th className="mr-c-act" aria-label="Acciones" />
          </tr>
        </thead>
        <tbody>
          {targets.map((t) => {
            const isOpen = !!open[t.profileId];
            const d = targetDuration(t, now);
            return (
              <Fragment key={t.profileId}>
                <tr
                  className={`mr-tr st-${t.status}${isOpen ? " open" : ""}`}
                  onClick={() => toggle(t.profileId)}
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(t.profileId);
                    }
                  }}
                >
                  <td className="mr-c-exp">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  <td className="mr-c-server">
                    <div className="mr-srv">
                      <span className="mr-srv-name">{t.name}</span>
                      {t.reused && <span className="mr-tag" title="Se usó la conexión de una pestaña abierta">pestaña</span>}
                      <PrivBadge t={t} />
                    </div>
                    <div className="mr-srv-sub mono">{t.address}</div>
                  </td>
                  <td className="mr-c-status">
                    <span className={`mr-status st-${t.status}`}>
                      <StatusIcon status={t.status} /> {statusText(t, now)}
                    </span>
                  </td>
                  <td className="mr-c-code mono">
                    {t.result?.exitCode !== undefined && t.result?.exitCode !== null ? t.result.exitCode : "—"}
                  </td>
                  <td className="mr-c-dur mono">{t.result || isFinal(t.status) ? formatDuration(d) : "—"}</td>
                  <td className="mr-c-first">
                    <span className={`mono mr-first${!t.result ? " detail" : ""}`}>{firstLine(t)}</span>
                  </td>
                  <td className="mr-c-act" onClick={(e) => e.stopPropagation()}>
                    <RowActions t={t} />
                  </td>
                </tr>
                {isOpen && (
                  <tr className="mr-tr-detail">
                    <td />
                    <td colSpan={6}>
                      <Output t={t} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SideView({ targets, now }: { targets: TargetState[]; now: number }) {
  return (
    <div className="mr-side">
      {targets.map((t) => (
        <div key={t.profileId} className={`mr-card st-${t.status}`}>
          <div className="mr-card-head">
            <StatusIcon status={t.status} />
            <div className="mr-card-title">
              <span className="mr-srv-name">{t.name}</span>
              <span className="mr-srv-sub mono">{t.address}</span>
            </div>
            <RowActions t={t} />
          </div>
          <div className="mr-card-meta">
            <span>{statusText(t, now)}</span>
            {t.result?.exitCode !== undefined && t.result?.exitCode !== null && (
              <span className="mono">código {t.result.exitCode}</span>
            )}
            {t.result && <span className="mono">{formatDuration(t.result.durationMs)}</span>}
            {t.reused && <span className="mr-tag">pestaña</span>}
            <PrivBadge t={t} />
          </div>
          <div className="mr-card-body">
            <Output t={t} compact />
          </div>
        </div>
      ))}
    </div>
  );
}

function CompareView({ targets, command }: { targets: TargetState[]; command: string }) {
  const [ignoreStderr, setIgnoreStderr] = useState(false);
  const groups = useMemo(() => groupIdentical(targets, { ignoreStderr }), [targets, ignoreStderr]);
  const withResult = groups.filter((g) => !g.noResult);
  return (
    <div className="mr-compare">
      <div className="mr-compare-bar">
        <span className="muted">
          {withResult.length === 0
            ? "Aún no hay salidas para comparar."
            : withResult.length === 1
              ? `Todos los servidores con resultado (${withResult[0].targets.length}) dieron la misma salida.`
              : `${withResult.length} salidas distintas.`}
        </span>
        <span className="mr-grow" />
        <label className="checkbox">
          <input type="checkbox" checked={ignoreStderr} onChange={(e) => setIgnoreStderr(e.target.checked)} />
          Ignorar stderr
        </label>
        <button className="btn btn-sm" disabled={groups.length === 0} onClick={() => void copy(formatGroups(command, groups), "Comparación")}>
          <Copy size={13} /> Copiar comparación
        </button>
      </div>
      {groups.map((g, i) => (
        <div key={g.key} className={`mr-group-card st-${g.status}${g.noResult ? " noresult" : ""}`}>
          <div className="mr-group-card-head">
            <StatusIcon status={g.status} />
            <strong>
              {g.noResult
                ? STATUS_LABEL[g.status]
                : withResult.length === 1
                  ? "Salida idéntica"
                  : i === 0 && g.targets.length > 1
                    ? "Salida más común"
                    : g.targets.length === 1
                      ? "Salida diferente"
                      : `Variante ${i + 1}`}
            </strong>
            <span className="muted">
              {g.targets.length === 1 ? "1 servidor" : `${g.targets.length} servidores`}
              {!g.noResult && g.exitCode !== null ? ` · código ${g.exitCode}` : ""}
            </span>
          </div>
          <div className="mr-group-servers">
            {g.targets.map((t) => (
              <span key={t.profileId} className="mr-srv-chip" title={t.address}>
                {t.name}
              </span>
            ))}
          </div>
          {g.noResult ? (
            g.stderr && <div className="mr-out-empty">{g.stderr}</div>
          ) : (
            <div className="mr-out">
              {g.stdout && <pre className="mono mr-pre">{g.stdout}</pre>}
              {g.stderr && (
                <>
                  <div className="mr-out-label">stderr</div>
                  <pre className="mono mr-pre stderr">{g.stderr}</pre>
                </>
              )}
              {!g.stdout && !g.stderr && <div className="mr-out-empty">(sin salida)</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ───────── Contenedor ─────────

function Chip({ status, n, children }: { status: TargetStatus; n: number; children?: ReactNode }) {
  if (n === 0) return null;
  return (
    <span className={`mr-sum-chip st-${status}`}>
      <StatusIcon status={status} size={12} /> {n} {children ?? STATUS_LABEL[status].toLowerCase()}
    </span>
  );
}

export function ResultsView() {
  const run = useMultiRun((s) => s.run);
  const [view, setView] = useState<ViewMode>(readView);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const targets = useMemo(() => run?.targets ?? [], [run]);
  const sum = useMemo(() => summarize(targets), [targets]);
  const busy = sum.counts.queued + sum.counts.connecting + sum.counts.running > 0;
  const now = useNow(busy);

  const shown = useMemo(() => (onlyErrors ? targets.filter((t) => isProblem(t.status)) : targets), [targets, onlyErrors]);

  if (!run) return null;

  const changeView = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* sin almacenamiento */
    }
  };

  const failed = sum.counts.error + sum.counts.timeout + sum.counts.canceled;
  const pct = sum.total === 0 ? 0 : Math.round((sum.done / sum.total) * 100);
  const elapsed = (busy ? now : Math.max(...targets.map((t) => t.finishedAt ?? 0), run.startedAt)) - run.startedAt;

  return (
    <div className="mr-results">
      <div className="mr-res-head">
        <div className="mr-res-cmd">
          {run.spec.label && <span className="mr-res-label">{run.spec.label}</span>}
          <code className="mono" title={run.spec.command}>
            {run.spec.command}
          </code>
        </div>
        <div className="mr-res-progress">
          <span className="muted">
            {busy ? "En curso" : sum.counts.attention > 0 ? "Esperando atención" : "Terminado"} · {sum.done}/{sum.total} · {formatDuration(elapsed)}
          </span>
          <div className="progress mr-progress" aria-label={`${pct}% terminado`}>
            <div
              style={{ width: `${pct}%` }}
              className={sum.counts.error + sum.counts.timeout > 0 ? "has-errors" : busy ? "" : "done"}
            />
          </div>
        </div>
        <div className="mr-sum">
          <Chip status="ok" n={sum.counts.ok}>
            correcto{sum.counts.ok === 1 ? "" : "s"}
          </Chip>
          <Chip status="error" n={sum.counts.error}>
            con error
          </Chip>
          <Chip status="timeout" n={sum.counts.timeout}>
            sin tiempo
          </Chip>
          <Chip status="attention" n={sum.counts.attention}>
            requiere{sum.counts.attention === 1 ? "" : "n"} atención
          </Chip>
          <Chip status="running" n={sum.counts.running}>
            ejecutando
          </Chip>
          <Chip status="connecting" n={sum.counts.connecting}>
            conectando
          </Chip>
          <Chip status="queued" n={sum.counts.queued}>
            en cola
          </Chip>
          <Chip status="canceled" n={sum.counts.canceled}>
            cancelado{sum.counts.canceled === 1 ? "" : "s"}
          </Chip>
        </div>
      </div>

      {sum.counts.attention > 0 && (
        <div className="mr-banner warn mr-attn">
          <AlertTriangle size={16} />
          <div className="mr-grow">
            {sum.counts.attention === 1 ? "1 servidor necesita" : `${sum.counts.attention} servidores necesitan`} que
            hagas algo para conectar (contraseña no guardada, huella nueva o código 2FA).
          </div>
          <button className="btn btn-sm" onClick={() => void multiRunActions.resolveAll()}>
            <KeyRound size={13} /> {sum.counts.attention === 1 ? "Resolver" : "Resolver uno a uno"}
          </button>
        </div>
      )}

      <div className="mr-toolbar">
        <div className="mr-seg" role="radiogroup" aria-label="Vista">
          <button role="radio" aria-checked={view === "table"} className={view === "table" ? "on" : ""} onClick={() => changeView("table")}>
            <Rows3 size={13} /> Tabla
          </button>
          <button role="radio" aria-checked={view === "side"} className={view === "side" ? "on" : ""} onClick={() => changeView("side")}>
            <Columns3 size={13} /> Lado a lado
          </button>
          <button
            role="radio"
            aria-checked={view === "compare"}
            className={view === "compare" ? "on" : ""}
            onClick={() => changeView("compare")}
            title="Agrupa los servidores que dieron exactamente la misma salida"
          >
            <GitCompareArrows size={13} /> Comparar salidas
          </button>
        </div>
        {view !== "compare" && (
          <label className="checkbox mr-only-errors">
            <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
            Solo errores
          </label>
        )}
        <span className="mr-grow" />
        {busy && (
          <button className="btn btn-sm btn-danger" onClick={() => multiRunActions.cancelAll()}>
            <Square size={13} /> Cancelar todo
          </button>
        )}
        {!busy && failed > 0 && (
          <button className="btn btn-sm" onClick={() => multiRunActions.retryFailed()}>
            <RotateCcw size={13} /> Reintentar fallidos ({failed})
          </button>
        )}
        <button className="btn btn-sm" title="Informe completo en texto" onClick={() => void copy(formatReport(run.spec.command, shown), "Informe")}>
          <Copy size={13} /> Copiar todo
        </button>
        <button
          className="btn btn-sm"
          title="Resumen separado por tabuladores (se pega en una hoja de cálculo)"
          onClick={() => void copy(formatTable(shown), "Resumen")}
        >
          <Copy size={13} /> Copiar tabla
        </button>
      </div>

      <div className="mr-res-body">
        {shown.length === 0 && onlyErrors && view !== "compare" ? (
          <div className="mr-empty">Ningún servidor con errores.</div>
        ) : view === "table" ? (
          <TableView targets={shown} now={now} />
        ) : view === "side" ? (
          <SideView targets={shown} now={now} />
        ) : (
          <CompareView targets={targets} command={run.spec.command} />
        )}
      </div>

      <div className="mr-footer">
        <span className="mr-footer-msg faint">
          {busy
            ? "Las conexiones abiertas para esta ejecución se cierran al terminar cada servidor."
            : "Las pestañas que ya tenías abiertas no se tocan."}
        </span>
        <span className="mr-grow" />
        <button className="btn" disabled={busy} onClick={showSetup} title="Volver a elegir servidores o comando">
          <Pencil size={14} /> Editar
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={repeatMultiRun}>
          <RotateCcw size={14} /> Repetir
        </button>
      </div>
    </div>
  );
}
