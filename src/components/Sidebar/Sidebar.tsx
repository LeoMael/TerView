// Barra lateral: conexión rápida, proyectos (con marcadores) y servidores guardados.
// DUEÑO: agente Almacenamiento/Sidebar. El ancho lo controla el padre.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
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
  SquareTerminal,
  GitBranch,
  Trash2,
  Upload,
  X,
  Zap,
  Bookmark as BookmarkIcon,
  MinusCircle,
  Bot,
  Laptop,
} from "lucide-react";
import { launchAssistant, openLocalTerminal } from "../../features/localterm/launch";
import type { Bookmark, Project, ServerProfile } from "../../api/types";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { toast } from "../../stores/toasts";
import { confirmDialog, promptDialog } from "../ui/dialogs";
import { Logo } from "../ui/Logo";
import { profiles as profilesApi } from "../../api/profiles";
import { connectToMany, connectToServer, openOrFocusServer } from "../../features/connect";
import { SbContextMenu, type MenuItem } from "./SbContextMenu";
import { openMultiRun } from "../../features/multirun/store";
import { openGitHub } from "../GitHub";
import { parseQuickConnect } from "./quickConnect";
import { preloadable } from "../../lib/lazy";
import "./Sidebar.css";
import { SSH_CONFIG_LABEL, isMac, isModKey } from "../../lib/platform";
import { checkSshAliasesBeforeExport } from "../../features/sshAliases";
import { serversNotInProject } from "../../features/projectServers";

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

type TabState = "connected" | "reconnecting" | "closed";
const TAB_STATE_RANK: Record<TabState, number> = { closed: 1, reconnecting: 2, connected: 3 };

/** Estado de la mejor pestaña de cada servidor, como texto estable ("id:estado" por línea, ordenado):
 *  así cambiar de pestaña no redibuja la barra; solo abrir, cerrar o cambiar de estado. */
function tabStatesKey(tabs: readonly { status: TabState; profileId: string }[]): string {
  const best = new Map<string, TabState>();
  for (const t of tabs) {
    const cur = best.get(t.profileId);
    if (!cur || TAB_STATE_RANK[t.status] > TAB_STATE_RANK[cur]) best.set(t.profileId, t.status);
  }
  return Array.from(best, ([id, st]) => `${id}:${st}`)
    .sort()
    .join("\n");
}

function parseTabStates(key: string): Map<string, TabState> {
  const m = new Map<string, TabState>();
  for (const line of key ? key.split("\n") : []) {
    const i = line.lastIndexOf(":");
    m.set(line.slice(0, i), line.slice(i + 1) as TabState);
  }
  return m;
}

const MOD = isMac ? "⌘" : "Ctrl";
const OPEN_HINT = `Doble clic: abrir o ir a su pestaña · ${MOD}+doble clic: nueva conexión`;

const DOT_TITLE: Record<TabState, string> = {
  connected: "Conectado — doble clic para ir a su pestaña",
  reconnecting: "Reconectando — doble clic para ir a su pestaña",
  closed: "Pestaña desconectada — doble clic para ir a ella y reconectar",
};

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
  // Estado de las pestañas por servidor (texto): cambiar de pestaña no redibuja la barra.
  const tabStatesKeyValue = useTabs((s) => tabStatesKey(s.tabs));
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
  /** Fila que hay que mostrar (desplazar y enfocar) en cuanto aparezca, p. ej. un servidor recién añadido. */
  const [reveal, setReveal] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const tabStates = useMemo(() => parseTabStates(tabStatesKeyValue), [tabStatesKeyValue]);

  useEffect(() => {
    if (!reveal) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-sb-key]") ?? []).find(
      (el) => el.dataset.sbKey === reveal,
    );
    if (!row) return; // aún no está en la lista: se reintenta en el siguiente render
    row.scrollIntoView({ block: "nearest" });
    row.focus();
    setReveal(null);
  });

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

  /** Conexión NUEVA (marcadores, «Abrir otra conexión», Ctrl+doble clic, clic central). */
  const connect = (s: ServerProfile, initialPath?: string | null) => {
    void connectToServer(s, initialPath ? { initialPath } : {});
  };

  /** Va a la pestaña ya abierta del servidor (reconectándola si hace falta) o conecta si no hay. */
  const openOrFocus = (s: ServerProfile) => {
    void openOrFocusServer(s);
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

  /** Selecciona y muestra un servidor: dentro de su proyecto (que se despliega) o en «Servidores». */
  const revealServer = (s: ServerProfile, projectId: string) => {
    const key = projectId ? `p:${projectId}:s:${s.id}` : `s:${s.id}`;
    if (projectId) toggleProject(projectId, true);
    if (q && !matches(s, q)) setQuery("");
    setSelected(key);
    setReveal(key);
  };

  /** Editor de servidor nuevo que lo guarda ya dentro del proyecto (se puede cambiar en el selector). */
  const newServerInProject = (p: Project) => openServerEditor(null, { projectId: p.id, onSaved: revealServer });

  /** Submenú con los servidores guardados que aún no están en el proyecto. */
  const existingServerItems = (p: Project): MenuItem[] => {
    const all = useProfiles.getState().servers;
    const candidates = serversNotInProject(all, p);
    if (candidates.length === 0) {
      return [{ label: all.length === 0 ? "No hay servidores guardados" : "Ya están todos en el proyecto", disabled: true }];
    }
    return candidates.map((s) => ({
      label: s.name,
      icon: <Server size={14} />,
      onClick: () =>
        void useProfiles
          .getState()
          .addServerToProject(p.id, s.id)
          .then((ok) => ok && revealServer(s, p.id)),
    }));
  };

  /** Lo que se puede añadir a un proyecto (menú del botón + y parte del menú contextual). */
  const addToProjectItems = (p: Project): MenuItem[] => [
    { label: "Añadir servidor nuevo…", icon: <Plus size={14} />, onClick: () => newServerInProject(p) },
    { label: "Añadir servidor existente", icon: <Server size={14} />, submenu: existingServerItems(p) },
  ];

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

    const tabState = tabStates.get(s.id);
    const busy = !!connecting[s.id];
    const items: MenuItem[] = [
      {
        label: !tabState ? "Conectar" : tabState === "closed" ? "Ir a su pestaña y reconectar" : "Ir a su pestaña",
        icon: <Plug size={14} />,
        onClick: () => openOrFocus(s),
        disabled: busy,
      },
    ];
    if (tabState) {
      items.push({ label: "Abrir otra conexión", icon: <CopyPlus size={14} />, onClick: () => connect(s), disabled: busy });
    }
    items.push(
      {
        label: "Ejecutar en varios servidores…",
        icon: <SquareTerminal size={14} />,
        onClick: () => openMultiRun({ profileIds: [s.id] }),
      },
      "separator",
      { label: "Editar…", icon: <Pencil size={14} />, onClick: () => openServerEditor(s) },
      { label: "Duplicar", icon: <Copy size={14} />, onClick: () => void st.duplicateServer(s.id) },
      { label: "Añadir a proyecto", icon: <Layers size={14} />, submenu: projectItems },
    );
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
      ...addToProjectItems(p),
      "separator",
      {
        label: "Conectar a todos",
        icon: <Plug size={14} />,
        disabled: projServers.length === 0,
        onClick: () => void connectToMany(projServers),
      },
      {
        label: "Ejecutar comando en el proyecto…",
        icon: <SquareTerminal size={14} />,
        disabled: projServers.length === 0,
        onClick: () => openMultiRun({ projectId: p.id }),
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
        "separator",
        { label: "Terminal local (este equipo)", icon: <Laptop size={14} />, onClick: () => openLocalTerminal() },
        { label: "Claude Code", icon: <Bot size={14} />, onClick: () => void launchAssistant("claude") },
        { label: "Codex", icon: <Bot size={14} />, onClick: () => void launchAssistant("codex") },
      ],
    });
  };

  const exportSshConfig = async () => {
    if (!(await checkSshAliasesBeforeExport())) return;
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
    void openOrFocusServer(server);
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

  /** `onEnter` recibe true con Ctrl/⌘+Enter (en un servidor: abrir otra conexión). */
  const rowKeys = (
    e: KeyboardEvent<HTMLElement>,
    onEnter: (withMod: boolean) => void,
    key: string,
    items: () => MenuItem[],
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter(isModKey(e));
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMenuForElement(e.currentTarget, key, items());
    }
  };

  // ───────── Filas ─────────

  const renderServer = (s: ServerProfile, projectId?: string) => {
    const key = projectId ? `p:${projectId}:s:${s.id}` : `s:${s.id}`;
    const isConnecting = !!connecting[s.id];
    const tabState = tabStates.get(s.id);
    return (
      <div
        key={key}
        data-sb-row
        data-sb-key={key}
        tabIndex={0}
        role="treeitem"
        aria-selected={selected === key}
        className={`sb-row${projectId ? " sb-indent" : ""}${selected === key ? " selected" : ""}`}
        title={`${s.name} — ${userHost(s)}\n${OPEN_HINT}`}
        onClick={() => setSelected(key)}
        onDoubleClick={(e) => (isModKey(e) ? connect(s) : openOrFocus(s))}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          setSelected(key);
          connect(s);
        }}
        onKeyDown={(e) => rowKeys(e, (withMod) => (withMod ? connect(s) : openOrFocus(s)), key, () => serverMenu(s, projectId))}
        onContextMenu={(e) => openMenuAt(e, key, serverMenu(s, projectId))}
      >
        {s.color && <span className="sb-colorbar" style={{ background: s.color }} />}
        <span className="sb-lead">
          {isConnecting ? (
            <span className="spinner sb-spinner" aria-label="Conectando" />
          ) : (
            <span
              className={`status-dot${tabState === "connected" ? " on" : tabState ? ` sb-dot-${tabState}` : ""}`}
              title={tabState ? DOT_TITLE[tabState] : "Sin conexión abierta"}
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
          <button
            type="button"
            className="icon-btn sb-row-btn"
            title="Añadir un servidor a este proyecto"
            aria-label={`Añadir servidor a ${p.name}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              setSelected(key);
              openMenuForElement(e.currentTarget, key, addToProjectItems(p));
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Plus size={13} />
          </button>
          <span className="sb-count">{p.serverIds.length}</span>
        </div>
        {open && (
          <>
            {entry.servers.map((s) => renderServer(s, p.id))}
            {entry.bookmarks.map((b) => renderBookmark(p, b))}
            {entry.servers.length === 0 && entry.bookmarks.length === 0 && (
              <div className="sb-row sb-indent sb-placeholder">
                {q ? (
                  "Sin servidores"
                ) : (
                  <>
                    Sin servidores ·{" "}
                    <button
                      type="button"
                      className="sb-linkbtn"
                      onClick={(e) => openMenuForElement(e.currentTarget, key, addToProjectItems(p))}
                    >
                      Añadir
                    </button>
                  </>
                )}
              </div>
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
          <button
            className="icon-btn"
            title="Ejecutar un comando en varios servidores a la vez"
            aria-label="Ejecutar en varios servidores"
            disabled={loaded && servers.length === 0}
            onClick={() => openMultiRun()}
          >
            <SquareTerminal size={15} />
          </button>
          <button
            className="icon-btn"
            title="GitHub: llaves, repositorios, despliegues y sincronizar"
            aria-label="GitHub"
            onClick={() => openGitHub()}
          >
            <GitBranch size={15} />
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
