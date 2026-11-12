// Piezas comunes de la ventana de GitHub.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Lock, Search } from "lucide-react";
import type { GhRepo } from "../../api/github";
import { errorMessage } from "../../api/core";
import { useTabs } from "../../stores/tabs";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { connectedTabs } from "../../features/github/session";
import { useGitHub } from "../../features/github/store";

export function openLink(url: string) {
  openUrl(url).catch((e) => toast.error("No se pudo abrir el enlace", e));
}

export function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="gh-link"
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openLink(href);
      }}
    >
      {children}
      <ExternalLink size={11} aria-hidden />
    </a>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="gh-head">
      <h3>{title}</h3>
      <div className="gh-head-actions">{children}</div>
    </div>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="gh-card">
      {(title || actions) && (
        <div className="gh-card-head">
          {title && <span className="section-label">{title}</span>}
          {actions && <div className="gh-head-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function NeedAccount({ what }: { what: string }) {
  const setSection = useGitHub((s) => s.setSection);
  return (
    <div className="gh-empty">
      <p>Conecta tu cuenta de GitHub para {what}.</p>
      <button className="btn btn-primary btn-sm" onClick={() => setSection("account")}>
        Conectar cuenta
      </button>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="gh-error">{errorMessage(error)}</div>;
}

export function Output({ text, ok }: { text: string; ok?: boolean | null }) {
  return (
    <pre className={`gh-output ${ok === false ? "gh-output-bad" : ok === true ? "gh-output-ok" : ""}`}>
      {text || "(sin salida)"}
    </pre>
  );
}

/** Selector de una conexión abierta. value = sessionId. */
export function SessionPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (sessionId: string | null) => void;
}) {
  const tabs = useTabs((s) => s.tabs);
  const list = useMemo(() => connectedTabs(tabs), [tabs]);
  useEffect(() => {
    if (value && !list.some((t) => t.sessionId === value)) onChange(null);
    else if (!value && list.length === 1) onChange(list[0].sessionId);
  }, [list, value, onChange]);
  if (list.length === 0) {
    return <div className="gh-hint">No hay ningún servidor conectado. Abre una conexión primero.</div>;
  }
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Elige un servidor conectado…</option>
      {list.map((t) => (
        <option key={t.sessionId} value={t.sessionId}>
          {t.title}
        </option>
      ))}
    </select>
  );
}

/** Selector de un servidor guardado. value = ServerProfile.id. */
export function ServerSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const servers = useProfiles((s) => s.servers);
  const load = useProfiles((s) => s.load);
  const loaded = useProfiles((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Elige un servidor…</option>
      {servers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} ({s.username}@{s.host})
        </option>
      ))}
    </select>
  );
}

/** Buscador de repos de la cuenta. */
export function RepoPicker({ value, onPick }: { value: GhRepo | null; onPick: (r: GhRepo) => void }) {
  const repos = useGitHub((s) => s.repos);
  const loadRepos = useGitHub((s) => s.loadRepos);
  const [q, setQ] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const reload = (force: boolean) => {
    setLoading(true);
    setError(null);
    loadRepos(force)
      .catch(setError)
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (!repos) reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = repos ?? [];
    return (t ? list.filter((r) => r.fullName.toLowerCase().includes(t) || r.description?.toLowerCase().includes(t)) : list).slice(0, 200);
  }, [repos, q]);

  return (
    <div className="gh-repo-picker">
      <div className="gh-search">
        <Search size={14} aria-hidden />
        <input
          className="input"
          placeholder={repos ? `Buscar entre ${repos.length} repositorios…` : "Buscar repositorio…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Buscar repositorio"
        />
        <button className="btn btn-sm" onClick={() => reload(true)} disabled={loading}>
          {loading ? <span className="spinner" /> : "Recargar"}
        </button>
      </div>
      <ErrorBox error={error} />
      <div className="gh-list" role="listbox" aria-label="Repositorios">
        {repos && shown.length === 0 && <div className="gh-hint">Ningún repositorio coincide.</div>}
        {shown.map((r) => (
          <button
            key={r.fullName}
            role="option"
            aria-selected={value?.fullName === r.fullName}
            className={`gh-row ${value?.fullName === r.fullName ? "gh-row-active" : ""}`}
            onClick={() => onPick(r)}
          >
            <span className="gh-row-main">
              {r.private && <Lock size={12} aria-label="Privado" />}
              <span className="gh-row-title">{r.fullName}</span>
              {r.archived && <span className="gh-tag">archivado</span>}
              {r.fork && <span className="gh-tag">fork</span>}
            </span>
            <span className="gh-row-sub">{r.description ?? ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
}
