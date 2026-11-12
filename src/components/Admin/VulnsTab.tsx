// Sub-pestaña «Vulnerabilidades»: qué software tiene el servidor y qué vulnerabilidades conocidas le
// afectan. La lista sale de OSV.dev, de la herramienta de la distro o de Trivy; nunca de una IA.
// Sin sudo se analiza el sistema y lo del usuario conectado; con sudo, también los contenedores de root
// y de los usuarios elegidos. Todo es de solo lectura.
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Eye,
  FileDown,
  History,
  KeyRound,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  Square,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { errorMessage } from "../../api/core";
import { ai, vulnscan, type Finding, type Report, type Severity } from "../../api/vulnscan";
import {
  cancelScan,
  loadStoreUsers,
  startScan,
  useVulnNav,
  useVulnScan,
  type Phase,
} from "../../features/vulnscan";
import { useLock } from "../../features/lock/lockStore";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { useAdmin } from "./context";
import { VirtualTable, type Column } from "./VirtualTable";
import { VulnSummary, diffReports, type ScanDiff } from "./VulnSummary";
import { VulnDetail } from "./VulnDetail";
import { AiAnswer, AiExplainDialog } from "./AiExplainDialog";
import { ExportDialog, HistoryDialog, OptionsDialog, OsvSampleDialog, UsersDialog } from "./VulnsDialogs";
import { originLabel, SEV_LABEL, SEV_ORDER, SevTag, SOURCE_LABEL, sudoToolOf } from "./vulnUi";
import "./Vulns.css";

const KERNEL_KEY = "__kernel__";

type Row = { kind: "f"; f: Finding; child: boolean } | { kind: "kernel"; items: Finding[]; worst: Severity; open: boolean };

function rowKey(r: Row): string {
  return r.kind === "kernel" ? KERNEL_KEY : r.f.key;
}

function PhaseIcon({ p }: { p: Phase }) {
  switch (p.status) {
    case "ok":
      return <Check size={13} className="vs-ph-ok" />;
    case "running":
      return <Loader2 size={13} className="adm-spin" />;
    case "warn":
      return <TriangleAlert size={13} className="vs-ph-warn" />;
    case "error":
      return <TriangleAlert size={13} className="vs-ph-error" />;
    case "skipped":
      return <CircleSlash size={13} className="faint" />;
    default:
      return <span className="vs-ph-dot" />;
  }
}

function matches(f: Finding, q: string): boolean {
  if (!q) return true;
  const hay = [f.id, f.package, f.installed, f.fixed ?? "", f.summary ?? "", ...f.aliases, ...f.advisories, ...f.binaries].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function VulnsTab() {
  const { sessionId, profileId, serverName, disabled, elevation, elev, info, askSudo } = useAdmin();
  const run = useVulnScan((s) => s.runs[sessionId]);
  const report = useVulnScan((s) => s.reports[sessionId]);
  const setReport = useVulnScan((s) => s.setReport);
  const clearReport = useVulnScan((s) => s.clearReport);
  const users = useVulnScan((s) => s.users[sessionId] ?? null);
  const vs = useSettings((s) => s.settings.vulnscan);
  const aiSettings = useSettings((s) => s.settings.ai);
  const locked = useLock((s) => !!s.status?.locked);
  const running = !!run?.running;

  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [origin, setOrigin] = useState("all");
  const [onlyFix, setOnlyFix] = useState(false);
  const [showUnimportant, setShowUnimportant] = useState(false);
  const [query, setQuery] = useState("");
  const [kernelOpen, setKernelOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "osv" | "history" | "export" | "users" | "options" | "ai">(null);
  const [diff, setDiff] = useState<ScanDiff | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{ id: string; label: string } | null>(null);

  // Último informe guardado al abrir (si aún no hay ninguno en memoria).
  useEffect(() => {
    if (report !== undefined) return;
    let alive = true;
    vulnscan.latest(profileId).then(
      (r) => alive && setReport(sessionId, r),
      () => alive && setReport(sessionId, null),
    );
    return () => {
      alive = false;
    };
  }, [report, profileId, sessionId, setReport]);

  // Diferencia con el análisis anterior del historial.
  useEffect(() => {
    setDiff(null);
    if (!report) return;
    let alive = true;
    (async () => {
      const list = await vulnscan.historyList(profileId);
      const i = list.findIndex((m) => m.id === report.id);
      const prev = i >= 0 ? list[i + 1] : undefined;
      if (!prev) return;
      const old = await vulnscan.historyGet(profileId, prev.id);
      if (alive) setDiff(diffReports(report, old));
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [report, profileId]);

  // Atajo «Ver vulnerabilidades» desde Contenedores → Imágenes.
  const nav = useVulnNav((s) => s.request);
  const navDone = useVulnNav((s) => s.done);
  useEffect(() => {
    if (!nav || nav.sessionId !== sessionId) return;
    setPendingImage({ id: nav.imageId, label: nav.label });
    navDone(nav.seq);
  }, [nav, sessionId, navDone]);
  useEffect(() => {
    if (!pendingImage || report === undefined) return;
    const t = report?.targets.find((x) => x.kind === "image" && x.image?.id.startsWith(pendingImage.id));
    if (t) {
      setOrigin(t.key);
      setSeverity("all");
      setQuery("");
    } else {
      toast.info(
        `«${pendingImage.label}» no está en el último análisis`,
        report ? "Pulsa «Analizar» para incluirla (o revisa el límite de imágenes en las opciones)." : "Pulsa «Analizar».",
      );
    }
    setPendingImage(null);
  }, [pendingImage, report]);

  const all = useMemo(() => report?.findings ?? [], [report]);
  const unimportantCount = useMemo(() => all.filter((f) => f.unimportant).length, [all]);
  const filtered = useMemo(
    () =>
      all.filter(
        (f) =>
          (showUnimportant || !f.unimportant) &&
          (severity === "all" || f.severity === severity) &&
          (origin === "all" || f.target === origin) &&
          (!onlyFix || f.hasFix) &&
          matches(f, query.trim()),
      ),
    [all, showUnimportant, severity, origin, onlyFix, query],
  );
  const rows = useMemo<Row[]>(() => {
    const kernel = filtered.filter((f) => f.kernel && f.target === "system");
    const rest = filtered.filter((f) => !(f.kernel && f.target === "system"));
    const out: Row[] = [];
    if (kernel.length) {
      const worst = SEV_ORDER.find((s) => kernel.some((k) => k.severity === s)) ?? "unknown";
      out.push({ kind: "kernel", items: kernel, worst, open: kernelOpen });
      if (kernelOpen) for (const f of kernel) out.push({ kind: "f", f, child: true });
    }
    for (const f of rest) out.push({ kind: "f", f, child: false });
    return out;
  }, [filtered, kernelOpen]);

  const selRow = rows.find((r) => rowKey(r) === selected) ?? null;
  const tool = sudoToolOf(info, elevation);

  const analyze = useCallback(async () => {
    const r = await startScan({ sessionId, profileId, elevation, settings: useSettings.getState().settings.vulnscan });
    if (r) {
      setSelected(null);
      toast.success("Análisis terminado", `${r.summary.total} vulnerabilidades (${r.summary.withFix} con arreglo)`);
    } else {
      const st = useVulnScan.getState().runs[sessionId];
      if (st?.error) toast.error("El análisis no pudo terminar", st.error);
    }
  }, [sessionId, profileId, elevation]);

  const loadUsers = useCallback(async () => {
    if (!elevation) return;
    setUsersLoading(true);
    setUsersError(null);
    try {
      await loadStoreUsers(sessionId, elevation);
    } catch (e) {
      setUsersError(errorMessage(e));
    } finally {
      setUsersLoading(false);
    }
  }, [sessionId, elevation]);

  const openUsers = () => {
    setDialog("users");
    if (!users) void loadUsers();
  };

  const chosen = vs.usersByServer[profileId] ?? [];
  const [aiLocked, setAiLocked] = useState(false);
  useEffect(() => {
    if (!aiSettings.enabled) return;
    ai.status().then(
      (s) => setAiLocked(s.locked),
      () => {},
    );
  }, [aiSettings.enabled, locked]);

  const columns: Column<Row>[] = [
    {
      key: "sev",
      label: "Gravedad",
      width: "110px",
      render: (r) =>
        r.kind === "kernel" ? (
          <span className="adm-cell-flex">
            <button
              className="icon-btn adm-row-btn vs-expander"
              aria-expanded={r.open}
              aria-label={r.open ? "Plegar las del kernel" : "Ver las del kernel una por una"}
              onClick={(e) => {
                e.stopPropagation();
                toggleKernel();
              }}
              tabIndex={-1}
            >
              {r.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <SevTag s={r.worst} />
          </span>
        ) : (
          <span className={r.child ? "vs-child" : undefined}>
            <SevTag s={r.f.severity} />
          </span>
        ),
    },
    {
      key: "id",
      label: "CVE / aviso",
      width: "minmax(150px, 1fr)",
      render: (r) =>
        r.kind === "kernel" ? (
          <strong>Kernel: {r.items.length} vulnerabilidades</strong>
        ) : (
          <span className="adm-cell-flex">
            <span className="mono adm-ellipsis">{r.f.id}</span>
            {r.f.unimportant && <span className="adm-tag vs-tag-muted" title="La distro lo considera sin importancia">sin importancia</span>}
          </span>
        ),
      title: (r) => (r.kind === "kernel" ? "Actualiza el kernel y reinicia" : [r.f.id, ...r.f.advisories, r.f.summary ?? ""].filter(Boolean).join("\n")),
    },
    {
      key: "pkg",
      label: "Paquete",
      width: "minmax(120px, 1fr)",
      render: (r) =>
        r.kind === "kernel" ? (
          <span className="faint">actualiza el kernel y reinicia</span>
        ) : (
          <span className="mono adm-ellipsis">{r.f.package}</span>
        ),
      title: (r) => (r.kind === "kernel" ? "" : r.f.binaries.join(", ") || r.f.package),
    },
    {
      key: "ver",
      label: "Instalada → arreglada",
      width: "minmax(170px, 1.3fr)",
      render: (r) => {
        if (r.kind === "kernel") return <span className="faint">{r.items.filter((x) => x.hasFix).length} con arreglo</span>;
        const f = r.f;
        return (
          <span className="mono adm-ellipsis">
            {f.installed || "?"} →{" "}
            {f.fixed ? (
              <span className="vs-fixed">{f.fixed}</span>
            ) : f.hasFix ? (
              <span className="vs-fixed">sí</span>
            ) : (
              <span className="faint">sin arreglo</span>
            )}
          </span>
        );
      },
      title: (r) => (r.kind === "kernel" ? "" : `${r.f.installed} → ${r.f.fixed ?? (r.f.hasFix ? "hay arreglo" : "sin arreglo")}`),
    },
    {
      key: "origin",
      label: "Origen",
      width: "minmax(110px, 1fr)",
      render: (r) => <span className="adm-ellipsis">{r.kind === "kernel" ? "Sistema" : originLabel(report!, r.f.target)}</span>,
      title: (r) => (r.kind === "kernel" ? "Sistema" : originLabel(report!, r.f.target)),
    },
    {
      key: "src",
      label: "Fuente",
      width: "100px",
      render: (r) =>
        r.kind === "kernel" ? (
          ""
        ) : (
          <span className="faint">{r.f.sources.map((s) => SOURCE_LABEL[s]).join(", ")}</span>
        ),
    },
  ];

  const toggleKernel = () => setKernelOpen((o) => !o);
  const statusSources = report?.sources ?? [];
  const aiBlock = !aiSettings.enabled
    ? null
    : locked || aiLocked
      ? "Desbloquea TerView para usar la IA"
      : !report
        ? "Primero analiza el servidor"
        : !aiSettings.baseUrl || !aiSettings.model
          ? "Falta la URL o el modelo (Ajustes → IA para explicar informes)"
          : null;

  return (
    <div className="adm-pane vs-root">
      {!elevation && !disabled && (
        <div className="adm-banner adm-banner-warn" role="status">
          <ShieldAlert size={14} />
          <span className="adm-banner-text">
            Sin sudo se analizan el sistema y tus contenedores; no se ven los contenedores de otros usuarios ni los de root.
          </span>
          {elev.canAskSudo && (
            <button className="btn btn-sm" onClick={askSudo}>
              <KeyRound size={13} /> Analizar con sudo
            </button>
          )}
        </div>
      )}
      <div className="adm-toolbar">
        {running ? (
          <button className="btn btn-sm" onClick={() => void cancelScan(sessionId)}>
            <Square size={13} /> Cancelar
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void analyze()}
            disabled={disabled}
            title={disabled ? "Sin conexión con el servidor" : "Analiza el servidor (solo lectura)"}
          >
            <Play size={13} /> Analizar
          </button>
        )}
        <span className="vs-sources" aria-label="Fuentes">
          {(statusSources.length
            ? statusSources
            : [
                { id: "osv" as const, label: "OSV.dev", used: vs.useOsv, note: vs.useOsv ? null : "desactivado" },
                { id: "distro" as const, label: "Distro", used: vs.useDistroTool, note: null },
                { id: "trivy" as const, label: "Trivy", used: false, note: "se sabrá al analizar" },
              ]
          ).map((s) => (
            <span
              key={s.id}
              className={`vs-src${s.used ? " on" : ""}`}
              title={`${s.label}${s.note ? `: ${s.note}` : s.used ? ": usado" : ""}`}
            >
              {s.used ? <Check size={11} /> : <CircleSlash size={11} />} {s.id === "osv" ? "OSV" : s.id === "trivy" ? s.label : "Distro"}
            </span>
          ))}
        </span>
        {elevation && (
          <button className="btn btn-sm" onClick={openUsers} disabled={running || disabled} title="De qué usuarios se miran los contenedores">
            <Users size={13} /> Usuarios: {chosen.length ? chosen.length : "Todos"}
          </button>
        )}
        <span className="adm-spacer" />
        {aiSettings.enabled && (
          <button className="btn btn-sm" onClick={() => setDialog("ai")} disabled={!!aiBlock || running} title={aiBlock ?? "Pide a la IA que explique este informe"}>
            <Bot size={13} /> Explicar con IA
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setDialog("export")} disabled={!report} title="Exportar a JSON o Markdown">
          <FileDown size={13} /> Exportar
        </button>
        <button className="icon-btn" onClick={() => setDialog("history")} title="Historial de análisis" aria-label="Historial de análisis">
          <History size={14} />
        </button>
        <button className="icon-btn" onClick={() => setDialog("options")} title="Opciones del análisis" aria-label="Opciones del análisis">
          <Settings2 size={14} />
        </button>
      </div>
      <div className="vs-privacy">
        A OSV.dev solo se envían nombres y versiones de paquetes. Nunca la IP ni el nombre del servidor.{" "}
        <button className="vs-link" onClick={() => setDialog("osv")}>
          <Eye size={11} /> ver qué se envía
        </button>
      </div>

      {run && (running || run.error || run.canceled) && (
        <div className="vs-phases" role="status" aria-live="polite">
          <ul>
            {run.phases.map((p) => (
              <li key={p.id} className={`vs-ph vs-ph-${p.status}`}>
                <PhaseIcon p={p} />
                <span>{p.label}</span>
                {p.detail && <span className="faint">· {p.detail}</span>}
              </li>
            ))}
          </ul>
          <div className="vs-ph-progress">
            {running ? run.progress : run.canceled ? "Análisis cancelado." : `No se pudo terminar: ${run.error}`}
          </div>
        </div>
      )}

      {report === undefined ? (
        <div className="empty-state">
          <span className="spinner" />
        </div>
      ) : !report ? (
        !running && (
          <div className="empty-state">
            <ShieldAlert size={22} />
            <div>Todavía no se ha analizado este servidor</div>
            <div className="faint adm-pre-wrap">
              «Analizar» lista el software instalado (paquetes, kernel, programas sueltos e imágenes de contenedores) y busca
              sus vulnerabilidades conocidas en OSV.dev y en la herramienta de seguridad de la distro. Es solo lectura.
            </div>
          </div>
        )
      ) : (
        <>
          <VulnSummary report={report} diff={diff} severity={severity} onSeverity={setSeverity} />
          {report.ai && (
            <details className="vs-ai-details">
              <summary>
                <Bot size={13} /> Explicación de la IA
              </summary>
              <AiAnswer report={report} sessionId={sessionId} />
            </details>
          )}
          {report.notes.length > 0 && (
            <details className="vs-notes">
              <summary>Avisos del análisis ({report.notes.length})</summary>
              <ul>
                {report.notes.map((n, i) => (
                  <li key={i} className={`vs-note-${n.level}`}>
                    {n.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="adm-toolbar">
            <div className="adm-search adm-search-wide">
              <Search size={13} />
              <input
                className="input"
                placeholder="CVE, paquete, versión o texto"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
                aria-label="Buscar vulnerabilidades"
              />
              {query && (
                <button className="icon-btn adm-search-clear" onClick={() => setQuery("")} aria-label="Limpiar búsqueda">
                  <X size={12} />
                </button>
              )}
            </div>
            <select className="input vs-select" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "all")} aria-label="Gravedad">
              <option value="all">Todas las gravedades</option>
              {SEV_ORDER.map((s) => (
                <option key={s} value={s}>
                  {SEV_LABEL[s]}
                </option>
              ))}
            </select>
            <select className="input vs-select" value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label="Origen">
              <option value="all">Todo (sistema, programas e imágenes)</option>
              {report.targets.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.kind === "system" ? "Sistema" : t.kind === "runtime" ? "Programas sueltos" : t.label}
                  {t.error ? " (con avisos)" : ""}
                </option>
              ))}
            </select>
            <label className="checkbox">
              <input type="checkbox" checked={onlyFix} onChange={(e) => setOnlyFix(e.target.checked)} />
              Solo con arreglo
            </label>
            {unimportantCount > 0 && (
              <label className="checkbox" title="Debian marca algunas como «unimportant»: no suelen afectar en la práctica">
                <input type="checkbox" checked={showUnimportant} onChange={(e) => setShowUnimportant(e.target.checked)} />
                Mostrar lo que la distro considera sin importancia ({unimportantCount})
              </label>
            )}
          </div>
          <div className="vs-main">
            <VirtualTable
              label="Vulnerabilidades"
              columns={columns}
              rows={rows}
              rowKey={rowKey}
              selected={selRow ? rowKey(selRow) : null}
              onSelect={setSelected}
              onActivate={(r) => (r.kind === "kernel" ? toggleKernel() : setSelected(r.f.key))}
              rowClass={(r) => (r.kind === "kernel" ? "vs-row-kernel" : r.f.unimportant ? "adm-row-muted" : "")}
              placeholder={
                <div className="adm-empty-text">
                  {all.length === 0 ? "No se encontraron vulnerabilidades conocidas." : "Ninguna coincide con los filtros."}
                  {all.length > 0 && (query || severity !== "all" || origin !== "all" || onlyFix) && (
                    <div>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setQuery("");
                          setSeverity("all");
                          setOrigin("all");
                          setOnlyFix(false);
                        }}
                      >
                        Quitar filtros
                      </button>
                    </div>
                  )}
                </div>
              }
            />
            {selRow && (
              <VulnDetail
                report={report}
                finding={selRow.kind === "f" ? selRow.f : null}
                kernel={selRow.kind === "kernel" ? selRow.items : null}
                sessionId={sessionId}
                tool={tool}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
          <div className="adm-statusbar">
            {filtered.length} de {all.length - (showUnimportant ? 0 : unimportantCount)}
            <span className="faint">·</span>
            <span>{new Date(report.createdAt).toLocaleString("es")}</span>
            <span className="faint">·</span>
            <span>{report.host.os.prettyName || report.host.os.id}</span>
            <span className="faint">·</span>
            <span>{report.elevated ? "con sudo" : "sin sudo"}</span>
            <span className="adm-spacer" />
            {report.host.inContainer && (
              <span className="faint" title="El kernel es el del anfitrión">
                <RotateCcw size={11} /> contenedor
              </span>
            )}
          </div>
        </>
      )}

      {dialog === "osv" && <OsvSampleDialog report={report ?? null} onClose={() => setDialog(null)} />}
      {dialog === "history" && (
        <HistoryDialog
          profileId={profileId}
          currentId={report?.id ?? null}
          onOpen={(r: Report) => {
            setReport(sessionId, r);
            setSelected(null);
          }}
          onDeleted={(id) => {
            if (!id || id === report?.id) clearReport(sessionId);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "export" && report && <ExportDialog report={report} profileId={profileId} serverName={serverName} onClose={() => setDialog(null)} />}
      {dialog === "users" && (
        <UsersDialog
          profileId={profileId}
          users={users}
          loading={usersLoading}
          error={usersError}
          onReload={() => void loadUsers()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "options" && <OptionsDialog onClose={() => setDialog(null)} />}
      {dialog === "ai" && report && (
        <AiExplainDialog
          report={report}
          profileId={profileId}
          onDone={(r) => setReport(sessionId, r)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
