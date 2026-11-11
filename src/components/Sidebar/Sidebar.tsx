// Barra lateral: conexión rápida, proyectos (con marcadores) y servidores guardados.
// DUEÑO: agente Almacenamiento/Sidebar. El ancho lo controla el padre.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Folder,
  FolderPlus,
  Layers,
  Pencil,
  Plug,
  Plus,
  Search,
  Server,
  Settings as SettingsIcon,
  Trash2,
  Upload,
  X,
  Zap,
  Bookmark as BookmarkIcon,
  MinusCircle,
} from "lucide-react";
import type { Bookmark, Project, ServerProfile } from "../../api/types";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { toast } from "../../stores/toasts";
import { confirmDialog, promptDialog } from "../ui/dialogs";
import { Logo } from "../ui/Logo";
import { profiles as profilesApi } from "../../api/profiles";
import { connectToMany, connectToServer } from "../../features/connect";
import { SbContextMenu, type MenuItem } from "./SbContextMenu";
import { parseQuickConnect } from "./quickConnect";
import { preloadable } from "../../lib/lazy";
import "./Sidebar.css";
import { SSH_CONFIG_LABEL } from "../../lib/platform";

const ImportSshConfigDialog = preloadable(() => import("./ImportSshConfigDialog").then((m) => m.ImportSshConfigDialog));

const COLLAPSED_KEY = "terview.sidebar.collapsedProjects";

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeCollapsed(v: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(v));
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}

function connectedProfilesKey(tabs: readonly { status: string; profileId: string }[]): string {
  const ids: string[] = [];
  for (const t of tabs) if (t.status === "connected" && !ids.includes(t.profileId)) ids.push(t.profileId);
  return ids.sort().join("\n");
}

function userHost(s: ServerProfile) {
  return `${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`;
}

function matches(s: ServerProfile, q: string) {
  return (
    s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q) || s.username.toLowerCase().includes(q)
  );
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function Sidebar() {
  const servers = useProfiles((s) => s.servers);
  const projects = useProfiles((s) => s.projects);
  const loaded = useProfiles((s) => s.loaded);
  const load = useProfiles((s) => s.load);
  const connecting = useProfiles((s) => s.connecting);
  // Solo la lista de servidores conectados (texto): cambiar de pestaña o reconectar no redibuja la barra.
  const connectedKey = useTabs((s) => connectedProfilesKey(s.tabs));
  const openServerEditor = useUi((s) => s.openServerEditor);
  const openProjectEditor = useUi((s) => s.openProjectEditor);
  const openSettings = useUi((s) => s.openSettings);

  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState("");
  const [quickError, setQuickError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const connected = useMemo(() => new Set(connectedKey ? connectedKey.split("\n") : []), [connectedKey]);

  const serverById = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers]);

  const q = query.trim().toLowerCase();

  const visibleProjects = useMemo(() => {
    return projects
      .map((p) => {
        const projServers = p.serverIds.map((id) => serverById.get(id)).filter((s): s is ServerProfile => !!s);
        if (!q || p.name.toLowerCase().includes(q)) return { project: p, servers: projServers, bookmarks: p.bookmarks };
        const ss = projServers.filter((s) => matches(s, q));
        const bs = p.bookmarks.filter(
          (b) =>
            b.path.toLowerCase().includes(q) ||
            (b.label ?? "").toLowerCase().includes(q) ||
            (serverById.get(b.serverId) && matches(serverById.get(b.serverId)!, q)),
        );
        if (ss.length === 0 && bs.length === 0) return null;
        return { project: p, servers: ss, bookmarks: bs };
      })
      .filter((x): x is { project: Project; servers: ServerProfile[]; bookmarks: Bookmark[] } => x !== null);
  }, [projects, serverById, q]);

  const visibleServers = useMemo(() => (q ? servers.filter((s) => matches(s, q)) : servers), [servers, q]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // ───────── Acciones ─────────

  const connect = (s: ServerProfile, initialPath?: string | null) => {
    void connectToServer(s, initialPath ? { initialPath } : {});
  };

  const toggleProject = (id: string, force?: boolean) => {
    setCollapsed((c) => {
      const next = { ...c, [id]: force === undefined ? !c[id] : !force };
      if (!next[id]) delete next[id];
      writeCollapsed(next);
      return next;
    });
  };

  const deleteServer = async (s: ServerProfile) => {
    const ok = await confirmDialog({
      title: "Eliminar servidor",
      message: (
        <>
          Se eliminará <strong>{s.name}</strong> ({userHost(s)}), su contraseña guardada en el llavero y sus marcadores.
          Las conexiones abiertas no se cierran.
        </>
      ),
      confirmText: "Eliminar",
      danger: true,
    });
    if (ok) await useProfiles.getState().deleteServer(s.id);
  };

  const deleteProject = async (p: Project) => {
    const ok = await confirmDialog({
      title: "Eliminar proyecto",
      message: (
        <>
          Se eliminará el proyecto <strong>{p.name}</strong> y sus marcadores. Los servidores no se borran.
        </>
      ),
      confirmText: "Eliminar",
      danger: true,
    });
    if (ok) await useProfiles.getState().deleteProject(p.id);
  };

  const addBookmarkFor = async (projectId: string, s: ServerProfile) => {
    const path = await promptDialog({
      title: "Añadir marcador",
      message: `Carpeta de ${s.name} que se abrirá directamente.`,
      label: "Ruta remota",
      initial: s.defaultPath ?? "/",
      placeholder: "/var/www/app",
      confirmText: "Añadir",
      validate: (v) => (v.trim().startsWith("/") || v.trim().startsWith("~") ? null : "Escribe una ruta absoluta (/…)"),
    });
    if (!path) return;
    const ok = await useProfiles.getState().addBookmark(projectId, { serverId: s.id, path: path.trim(), label: null });
    if (ok) toast.success("Marcador añadido");
  };

  const serverMenu = (s: ServerProfile, projectId?: string): MenuItem[] => {
    const st = useProfiles.getState();
    const projectItems: MenuItem[] =
      st.projects.length === 0
        ? [{ label: "No hay proyectos", disabled: true }]
        : st.projects.map((p) => ({
            label: p.name,
            icon: <span className="sb-chip" style={{ background: p.color ?? undefined }} />,
            disabled: p.serverIds.includes(s.id),
            onClick: () => void st.addServerToProject(p.id, s.id),
          }));
    projectItems.push("separator", {
      label: "Nuevo proyecto…",
      icon: <FolderPlus size={14} />,
      onClick: () =>
        useUi.getState().openProjectEditor({ id: "", name: "", serverIds: [s.id], bookmarks: [], color: null }),
    });

    const items: MenuItem[] = [
      { label: "Conectar", icon: <Plug size={14} />, onClick: () => connect(s), disabled: !!connecting[s.id] },
      "separator",
      { label: "Editar…", icon: <Pencil size={14} />, onClick: () => openServerEditor(s) },
      { label: "Duplicar", icon: <Copy size={14} />, onClick: () => void st.duplicateServer(s.id) },
      { label: "Añadir a proyecto", icon: <Layers size={14} />, submenu: projectItems },
    ];
    if (projectId) {
      const p = st.projects.find((x) => x.id === projectId);
      items.push(
        { label: "Añadir marcador…", icon: <BookmarkIcon size={14} />, onClick: () => void addBookmarkFor(projectId, s) },
        {
          label: "Quitar del proyecto",
          icon: <MinusCircle size={14} />,
          onClick: () =>
            p &&
            void st.saveProject({
              ...p,
              serverIds: p.serverIds.filter((x) => x !== s.id),
              bookmarks: p.bookmarks.filter((b) => b.serverId !== s.id),
            }),
        },
      );
    }
    items.push("separator", {
      label: "Eliminar",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => void deleteServer(s),
    });
    return items;
  };

  const projectMenu = (p: Project): MenuItem[] => {
    const projServers = p.serverIds.map((id) => serverById.get(id)).filter((s): s is ServerProfile => !!s);
    return [
      { label: "Editar…", icon: <Pencil size={14} />, onClick: () => openProjectEditor(p) },
      {
        label: "Conectar a todos",
        icon: <Plug size={14} />,
        disabled: projServers.length === 0,
        onClick: () => void connectToMany(projServers),
      },
      "separator",
      { label: "Eliminar", icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteProject(p) },
    ];
  };

  const bookmarkMenu = (p: Project, b: Bookmark, s: ServerProfile | undefined): MenuItem[] => [
    { label: "Abrir", icon: <Folder size={14} />, disabled: !s, onClick: () => s && connect(s, b.path) },
    { label: "Editar proyecto…", icon: <Pencil size={14} />, onClick: () => openProjectEditor(p) },
    "separator",
    {
      label: "Quitar marcador",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => void useProfiles.getState().removeBookmark(p.id, b.serverId, b.path),
    },
  ];

  const openMenuAt = (e: MouseEvent, key: string, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(key);
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const openMenuForElement = (el: HTMLElement, key: string, items: MenuItem[]) => {
    const r = el.getBoundingClientRect();
    setSelected(key);
    setMenu({ x: r.left + 24, y: r.bottom, items });
  };

  const openNewMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: "Servidor", icon: <Server size={14} />, onClick: () => openServerEditor(null) },
        { label: "Proyecto", icon: <Layers size={14} />, onClick: () => openProjectEditor(null) },
        "separator",
        { label: `Importar de ${SSH_CONFIG_LABEL}…`, icon: <Download size={14} />, onClick: () => setImportOpen(true) },
        { label: `Exportar a ${SSH_CONFIG_LABEL}`, icon: <Upload size={14} />, onClick: () => void exportSshConfig() },
      ],
    });
  };

  const exportSshConfig = async () => {
    try {
      const r = await profilesApi.exportSshConfig();
      toast.success(
        r.count === 1 ? `1 servidor exportado a ${r.path}` : `${r.count} servidores exportados a ${r.path}`,
      );
    } catch (e) {
      toast.error(`No se pudo exportar a ${SSH_CONFIG_LABEL}`, e);
    }
  };

  const submitQuick = async () => {
    const t = parseQuickConnect(quick);
    if (typeof t === "string") {
      setQuickError(t);
      return;
    }
    const st = useProfiles.getState();
    let server =
      st.servers.find((s) => s.host === t.host && s.port === t.port && s.username === t.username) ?? null;
    if (!server) {
      server = await st.saveServer({
        id: "",
        name: t.host,
        host: t.host,
        port: t.port,
        username: t.username,
        auth: "password",
        keyPath: null,
        defaultPath: null,
        color: null,
      });
      if (!server) return;
    }
    setQuick("");
    setQuickError(null);
    setSelected(`s:${server.id}`);
    void connectToServer(server);
  };

  // Navegación con flechas entre filas.
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-sb-row]") ?? []);
    if (rows.length === 0) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : Math.min(rows.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = i < 0 ? 0 : Math.max(0, i - 1);
    else if (e.key === "End") next = rows.length - 1;
    rows[next].focus();
    rows[next].scrollIntoView({ block: "nearest" });
  };

  const rowKeys = (e: KeyboardEvent<HTMLElement>, onEnter: () => void, key: string, items: () => MenuItem[]) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMenuForElement(e.currentTarget, key, items());
    }
  };

  // ───────── Filas ─────────

  const renderServer = (s: ServerProfile, projectId?: string) => {
    const key = projectId ? `p:${projectId}:s:${s.id}` : `s:${s.id}`;
    const isConnecting = !!connecting[s.id];
    const isOn = connected.has(s.id);
    return (
      <div
        key={key}
        data-sb-row
        tabIndex={0}
        role="treeitem"
        aria-selected={selected === key}
        className={`sb-row${projectId ? " sb-indent" : ""}${selected === key ? " selected" : ""}`}
        title={`${s.name} — ${userHost(s)}`}
        onClick={() => setSelected(key)}
        onDoubleClick={() => connect(s)}
        onKeyDown={(e) => rowKeys(e, () => connect(s), key, () => serverMenu(s, projectId))}
        onContextMenu={(e) => openMenuAt(e, key, serverMenu(s, projectId))}
      >
        {s.color && <span className="sb-colorbar" style={{ background: s.color }} />}
        <span className="sb-lead">
          {isConnecting ? (
            <span className="spinner sb-spinner" aria-label="Conectando" />
          ) : (
            <span
              className={`status-dot${isOn ? " on" : ""}`}
              title={isOn ? "Conectado" : "Desconectado"}
            />
          )}
        </span>
        <span className="sb-name">{s.name}</span>
        <span className="sb-sub">{userHost(s)}</span>
      </div>
    );
  };

  const renderBookmark = (p: Project, b: Bookmark) => {
    const s = serverById.get(b.serverId);
    const key = `b:${p.id}:${b.serverId}:${b.path}`;
    const label = b.label || b.path;
    return (
      <div
        key={key}
        data-sb-row
        tabIndex={0}
        role="treeitem"
        aria-selected={selected === key}
        className={`sb-row sb-indent sb-bookmark${selected === key ? " selected" : ""}`}
        title={`${s?.name ?? "Servidor eliminado"}: ${b.path}`}
        onClick={() => {
          setSelected(key);
          if (s) connect(s, b.path);
        }}
        onKeyDown={(e) => rowKeys(e, () => s && connect(s, b.path), key, () => bookmarkMenu(p, b, s))}
        onContextMenu={(e) => openMenuAt(e, key, bookmarkMenu(p, b, s))}
      >
        <span className="sb-lead">
          {s && connecting[s.id] ? <span className="spinner sb-spinner" /> : <Folder size={14} className="sb-folder" />}
        </span>
        <span className="sb-name">{label}</span>
        <span className="sb-sub">{b.label ? b.path : s?.name}</span>
      </div>
    );
  };

  const renderProject = (entry: { project: Project; servers: ServerProfile[]; bookmarks: Bookmark[] }) => {
    const { project: p } = entry;
    const key = `p:${p.id}`;
    const open = q ? true : !collapsed[p.id];
    return (
      <div key={key} role="group">
        <div
          data-sb-row
          tabIndex={0}
          role="treeitem"
          aria-expanded={open}
          aria-selected={selected === key}
          className={`sb-row sb-project${selected === key ? " selected" : ""}`}
          onClick={() => {
            setSelected(key);
            toggleProject(p.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              toggleProject(p.id, true);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              toggleProject(p.id, false);
            } else rowKeys(e, () => toggleProject(p.id), key, () => projectMenu(p));
          }}
          onContextMenu={(e) => openMenuAt(e, key, projectMenu(p))}
        >
          <span className="sb-lead">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          <span className="sb-chip" style={{ background: p.color ?? undefined }} />
          <span className="sb-name sb-project-name">{p.name}</span>
          <span className="sb-count">{p.serverIds.length}</span>
        </div>
        {open && (
          <>
            {entry.servers.map((s) => renderServer(s, p.id))}
            {entry.bookmarks.map((b) => renderBookmark(p, b))}
            {entry.servers.length === 0 && entry.bookmarks.length === 0 && (
              <div className="sb-row sb-indent sb-placeholder">Sin servidores</div>
            )}
          </>
        )}
      </div>
    );
  };

  const isEmpty = loaded && servers.length === 0 && projects.length === 0;

  return (
    <aside className="sb" aria-label="Servidores">
      <div className="sb-header">
        <Logo size={20} withName className="sb-title" />
        <div className="sb-header-actions">
          <button
            className="sb-new-btn"
            title={`Nuevo servidor o proyecto, importar o exportar ${SSH_CONFIG_LABEL}`}
            aria-haspopup="menu"
            onClick={(e) => openNewMenu(e.currentTarget)}
          >
            <Plus size={14} /> Nuevo <ChevronDown size={12} />
          </button>
          <button className="icon-btn" title="Ajustes" aria-label="Ajustes" onClick={openSettings}>
            <SettingsIcon size={15} />
          </button>
        </div>
      </div>

      <div className="sb-inputs">
        <div className={`sb-input-wrap${quickError ? " invalid" : ""}`}>
          <Zap size={13} className="sb-input-icon" />
          <input
            className="sb-input mono"
            value={quick}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="usuario@host:puerto"
            aria-label="Conexión rápida"
            title="Conexión rápida: escribe usuario@host:puerto y pulsa Enter"
            onChange={(e) => {
              setQuick(e.target.value);
              setQuickError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitQuick();
              else if (e.key === "Escape") {
                setQuick("");
                setQuickError(null);
              }
            }}
          />
        </div>
        {quickError && <div className="sb-input-error">{quickError}</div>}
        <div className="sb-input-wrap">
          <Search size={13} className="sb-input-icon" />
          <input
            className="sb-input"
            value={query}
            placeholder="Buscar"
            aria-label="Buscar servidores"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
          {query && (
            <button className="sb-clear" aria-label="Limpiar búsqueda" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {isEmpty ? (
        <div className="empty-state sb-empty">
          <Server size={28} strokeWidth={1.5} />
          <div>Aún no tienes servidores guardados.</div>
          <button className="btn btn-primary btn-sm" onClick={() => openServerEditor(null)}>
            <Plus size={14} /> Añadir servidor
          </button>
          <button className="btn btn-sm" onClick={() => setImportOpen(true)}>
            <Download size={14} /> Importar de {SSH_CONFIG_LABEL}
          </button>
        </div>
      ) : (
        <div className="sb-list" ref={listRef} role="tree" onKeyDown={onListKeyDown}>
          {!loaded && (
            <div className="sb-loading">
              <span className="spinner sb-spinner" /> Cargando…
            </div>
          )}

          {projects.length > 0 && (!q || visibleProjects.length > 0) && (
            <section className="sb-section">
              <div className="sb-section-head">
                <span className="section-label">Proyectos</span>
                <button
                  className="icon-btn sb-section-btn"
                  title="Nuevo proyecto"
                  aria-label="Nuevo proyecto"
                  onClick={() => openProjectEditor(null)}
                >
                  <Plus size={13} />
                </button>
              </div>
              {visibleProjects.map(renderProject)}
            </section>
          )}

          {loaded && (!q || visibleServers.length > 0) && (
            <section className="sb-section">
              <div className="sb-section-head">
                <span className="section-label">Servidores</span>
                <button
                  className="icon-btn sb-section-btn"
                  title="Nuevo servidor"
                  aria-label="Nuevo servidor"
                  onClick={() => openServerEditor(null)}
                >
                  <Plus size={13} />
                </button>
              </div>
              {visibleServers.map((s) => renderServer(s))}
              {servers.length === 0 && <div className="sb-row sb-placeholder">Sin servidores</div>}
            </section>
          )}

          {q && visibleProjects.length === 0 && visibleServers.length === 0 && (
            <div className="sb-no-results">Sin resultados para «{query.trim()}»</div>
          )}
        </div>
      )}

      {importOpen && (
        <Suspense fallback={null}>
          <ImportSshConfigDialog onClose={() => setImportOpen(false)} />
        </Suspense>
      )}
      {menu && <SbContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </aside>
  );
}
