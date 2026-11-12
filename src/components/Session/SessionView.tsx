// Contenido de una pestaña de conexión: área de trabajo arriba y terminales abajo.
// El área de trabajo funciona como las pestañas de un navegador: una sola fila con las vistas fijas
// (Archivos, Comandos, Administración) y los archivos abiertos; se ve solo la elegida, a todo el área.
// Bajo pedido se divide en dos (vista fija | editores), y la pestaña de un archivo se puede arrastrar para
// reordenarla o, soltándola fuera de la ventana, abrirla en una ventana aparte.
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Group, Panel, Separator, usePanelRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import {
  Columns2,
  Copy,
  CornerDownLeft,
  ExternalLink,
  FileCode2,
  FolderOpen,
  PanelTop,
  PanelBottomClose,
  PanelBottomOpen,
  RotateCw,
  ShieldCheck,
  Activity,
  Container,
  Cable,
  SquareTerminal,
  Unplug,
  X,
} from "lucide-react";
import type { SessionReconnecting } from "../../api/types";
import type { SessionTab } from "../../stores/tabs";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";
import { FileExplorer } from "../FileExplorer/FileExplorer";
import { ContextMenu, type MenuItem } from "../FileExplorer/ContextMenu";
import { TerminalArea } from "../Terminal/TerminalArea";
import { confirmDialog } from "../ui/dialogs";
import { basename } from "../../lib/paths";
import { clipboard } from "../../lib/clipboard";
import { preloadable } from "../../lib/lazy";
import type { RemoteEditorHandle } from "../Editor/RemoteEditor";
import { getEditorOpenMode } from "../Editor/openPref";
import {
  focusEditorWindow,
  initEditorWindowsBridge,
  openInWindow,
  requestReturn,
  useDetachedEditors,
  type WindowAt,
} from "../Editor/editorWindows";
import { cancelReconnect, reconnectTab, requestCloseTab, setSessionPath, useEditorDirty } from "./sessionState";
import "./SessionView.css";

const RemoteEditor = lazy(() => import("../Editor/RemoteEditor"));
/** Biblioteca de comandos (catálogo grande): se carga la primera vez que se abre la pestaña «Comandos». */
export const CommandsPanel = preloadable(() => import("../Commands/CommandsPanel").then((m) => m.CommandsPanel));
/** Administración del servidor: se carga la primera vez que se abre su pestaña. */
const AdminPanel = preloadable(() => import("../Admin/AdminPanel").then((m) => m.AdminPanel));
/** Monitoreo en vivo (CPU, memoria, disco, red, procesos). */
const MonitorPanel = preloadable(() => import("../Monitor/MonitorPanel").then((m) => m.MonitorPanel));
/** Contenedores (Podman / Docker) del servidor. */
const ContainersPanel = preloadable(() => import("../Containers/ContainersPanel").then((m) => m.ContainersPanel));
/** Túneles (port forwarding) de esta conexión. */
const TunnelsPanel = preloadable(() => import("../Tunnels/TunnelsPanel").then((m) => m.TunnelsPanel));

export interface SessionViewProps {
  tab: SessionTab;
  active: boolean;
}

const EMPTY: string[] = [];

/** Vistas fijas (siempre presentes, sin botón de cerrar). */
type FixedTab = "files" | "commands" | "containers" | "monitor" | "tunnels" | "admin";

const FIXED: { id: FixedTab; label: string; title?: string; icon: ReactNode }[] = [
  { id: "files", label: "Archivos", icon: <FolderOpen size={14} /> },
  {
    id: "commands",
    label: "Comandos",
    title: "Biblioteca de comandos (Ctrl+Shift+P para la paleta)",
    icon: <SquareTerminal size={14} />,
  },
  { id: "containers", label: "Contenedores", title: "Contenedores (Podman / Docker)", icon: <Container size={14} /> },
  { id: "monitor", label: "Monitor", title: "Monitoreo en vivo del servidor", icon: <Activity size={14} /> },
  { id: "tunnels", label: "Túneles", title: "Túneles (port forwarding)", icon: <Cable size={14} /> },
  { id: "admin", label: "Administración", title: "Administración del servidor", icon: <ShieldCheck size={14} /> },
];
const fixedLabel = (id: FixedTab) => FIXED.find((f) => f.id === id)?.label ?? "";

/** side: se ve una vista fija · editors: se ve un archivo · split: vista fija | editores, lado a lado. */
type WorkMode = "side" | "split" | "editors";

/** Distancia (px) por debajo/encima de la barra a partir de la cual la pestaña «se despega» (como en Chrome). */
const DETACH_MARGIN = 60;
/** Movimiento mínimo (px) para que pulsar una pestaña cuente como arrastre. */
const DRAG_THRESHOLD = 5;

/** Segundos que faltan para el próximo intento (cuenta atrás en vivo). */
/** Solo corre mientras la pestaña se ve (las ocultas no gastan un temporizador). */
function useCountdown(info: SessionReconnecting | null, visible: boolean): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const [deadline, setDeadline] = useState<{ info: SessionReconnecting; at: number } | null>(null);
  // El plazo se fija al llegar el aviso, aunque la pestaña esté oculta.
  if (info && deadline?.info !== info) setDeadline({ info, at: Date.now() + info.nextRetrySecs * 1000 });
  else if (!info && deadline) setDeadline(null);
  useEffect(() => {
    if (!deadline) {
      setLeft(null);
      return;
    }
    if (!visible) return;
    const at = deadline.at;
    // setLeft con el mismo número no vuelve a dibujar: basta con mirar 4 veces por segundo.
    const tick = () => setLeft(Math.max(0, Math.ceil((at - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadline, visible]);
  return left;
}

function ReconnectingBanner({ tab, visible }: { tab: SessionTab; visible: boolean }) {
  const r = tab.reconnect;
  const left = useCountdown(r, visible);
  return (
    <div className="sv-banner sv-banner-warn" role="status" aria-live="polite">
      <span className="spinner sv-banner-spinner" />
      <span className="sv-banner-text">
        <strong>Reconectando…</strong>
        {r && (
          <>
            {" "}
            intento {r.attempt} de {r.maxAttempts}
            {" · "}
            {left === null || left > 0 ? `próximo en ${left ?? r.nextRetrySecs} s` : "intentando ahora"}
          </>
        )}
        {r?.reason && <span className="sv-banner-reason"> — {r.reason}</span>}
      </span>
      <button className="btn btn-sm" onClick={() => void cancelReconnect(tab.id)} title="Dejar de reintentar">
        Cancelar
      </button>
    </div>
  );
}

function initialLayout(saved: number[] | undefined): Layout {
  if (saved && saved.length === 2 && saved.every((n) => Number.isFinite(n) && n > 5)) {
    return { work: saved[0], terminal: saved[1] };
  }
  return { work: 58, terminal: 42 };
}

/** Reparto guardado entre la vista fija y los editores (layout «sessionSplit»). */
function splitLayout(saved: number[] | undefined): Layout {
  if (saved && saved.length === 2 && saved.every((n) => Number.isFinite(n) && n >= 10 && n <= 90)) {
    return { side: saved[0], editors: saved[1] };
  }
  return { side: 38, editors: 62 };
}

const spinner = (text?: string) => (
  <div className="empty-state">
    <div className="spinner" />
    {text && <span>{text}</span>}
  </div>
);

/** Indicador de archivos abiertos en ventanas aparte, con menú para enfocarlas o traerlos de vuelta. */
function DetachedButton({ sessionId, paths }: { sessionId: string; paths: string[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  if (paths.length === 0) return null;
  const items: MenuItem[] = [];
  paths.forEach((p, i) => {
    if (i > 0) items.push({ sep: true });
    const name = basename(p);
    items.push(
      { label: `Ir a «${name}»`, icon: <ExternalLink size={14} />, onSelect: () => void focusEditorWindow(sessionId, p) },
      { label: `Traer «${name}» aquí`, icon: <CornerDownLeft size={14} />, onSelect: () => void requestReturn(sessionId, p) },
    );
  });
  return (
    <>
      <button
        className="sv-detached"
        title={`Abierto en otra ventana: ${paths.join(", ")}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        <ExternalLink size={13} />
        <span>{paths.length === 1 ? basename(paths[0]) : `${paths.length} archivos`}</span>
        <span className="sv-detached-hint">en otra ventana</span>
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
    </>
  );
}

/** Arrastre en curso de la pestaña de un archivo. */
interface TabDrag {
  path: string;
  pointerId: number;
  el: HTMLElement;
  bar: HTMLElement;
  /** Punto de inicio (cliente) y distancia del cursor al borde izquierdo de la pestaña. */
  x0: number;
  y0: number;
  grabX: number;
  moved: boolean;
  /** Fuera de la barra: al soltar se abre en ventana aparte. */
  out: boolean;
  /** Última posición conocida (por si el sistema no entrega el «soltar»). */
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}


export const SessionView = memo(function SessionView({ tab, active }: SessionViewProps) {
  const sessionId = tab.sessionId;
  /** Archivos abiertos, en orden de pestañas (incluye los que están en otra ventana). */
  const [files, setFiles] = useState<string[]>([]);
  /** Último archivo elegido. */
  const [activeFile, setActiveFile] = useState<string | null>(null);
  /** Última vista fija elegida (la que se ve en su pestaña o a la izquierda al dividir). */
  const [side, setSide] = useState<FixedTab>("files");
  /** En modo pestañas: ¿se ve la vista fija o el archivo? */
  const [focus, setFocus] = useState<"fixed" | "file">("fixed");
  /** Vista dividida (vista fija | editores), solo si el usuario la pide. */
  const [split, setSplit] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const editors = useRef(new Map<string, RemoteEditorHandle>());

  const detached = useDetachedEditors((s) => s.bySession[sessionId] ?? EMPTY);
  const detachedSet = useMemo(() => new Set(detached), [detached]);
  /** Archivos que se ven como pestaña en esta ventana. */
  const attached = useMemo(() => files.filter((p) => !detachedSet.has(p)), [files, detachedSet]);
  const current = useMemo(() => {
    if (activeFile && attached.includes(activeFile)) return activeFile;
    if (attached.length === 0) return null;
    // El elegido se fue a otra ventana: el más cercano a su izquierda.
    const i = activeFile ? files.indexOf(activeFile) : -1;
    for (let k = i - 1; k >= 0; k--) if (!detachedSet.has(files[k])) return files[k];
    return attached[0];
  }, [activeFile, attached, files, detachedSet]);

  /**
   * Orden fijo en el DOM (el de apertura) para pestañas y editores; el orden visible se da con CSS `order`.
   * Mover el nodo en el DOM al reordenar soltaría el arrastre (pierde la captura del puntero) y movería los editores.
   */
  const seq = useRef(new Map<string, number>());
  for (const p of files) if (!seq.current.has(p)) seq.current.set(p, seq.current.size);
  const stable = useMemo(
    () => [...attached].sort((a, b) => (seq.current.get(a) ?? 0) - (seq.current.get(b) ?? 0)),
    [attached],
  );

  // Sin archivos no hay nada que dividir.
  if (attached.length === 0 && split) setSplit(false);
  const mode: WorkMode = current ? (split ? "split" : focus === "file" ? "editors" : "side") : "side";
  const sideVisible = mode !== "editors";
  const editorsVisible = mode !== "side";
  /** Pestaña elegida en la fila única (modo pestañas). */
  const selected: FixedTab | string = mode === "editors" && current ? current : side;

  /** Comandos y Administración se montan la primera vez que se abren y luego se conservan. */
  const [commandsMounted, setCommandsMounted] = useState(false);
  if (side === "commands" && !commandsMounted) setCommandsMounted(true);
  const [adminMounted, setAdminMounted] = useState(false);
  if (side === "admin" && !adminMounted) setAdminMounted(true);
  const [containersMounted, setContainersMounted] = useState(false);
  if (side === "containers" && !containersMounted) setContainersMounted(true);
  const [monitorMounted, setMonitorMounted] = useState(false);
  if (side === "monitor" && !monitorMounted) setMonitorMounted(true);
  const [tunnelsMounted, setTunnelsMounted] = useState(false);
  if (side === "tunnels" && !tunnelsMounted) setTunnelsMounted(true);

  const [termCollapsed, setTermCollapsed] = useState(false);
  const termPanel = usePanelRef();
  const dirtyPaths = useEditorDirty((s) => s.dirty[sessionId] ?? EMPTY);
  const setDirty = useEditorDirty((s) => s.setDirty);
  const setLayout = useSettings((s) => s.setLayout);
  const [defaultLayout] = useState(() => initialLayout(useSettings.getState().settings.layout.session));
  const [defaultSplit] = useState(() => splitLayout(useSettings.getState().settings.layout.sessionSplit));

  const closed = tab.status === "closed";
  const connected = tab.status === "connected";
  const onPathChange = useCallback((path: string) => setSessionPath(sessionId, path), [sessionId]);

  useEffect(() => initEditorWindowsBridge(), []);

  const showFile = useCallback((path: string) => {
    setActiveFile(path);
    setFocus("file");
  }, []);

  const showFixed = useCallback((id: FixedTab) => {
    setSide(id);
    setFocus("fixed");
  }, []);

  // Un archivo vuelve de su ventana con «Volver a la pestaña principal»: mostrarlo.
  const reveal = useDetachedEditors((s) => s.reveal);
  const revealSeen = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.seq === revealSeen.current) return;
    revealSeen.current = reveal.seq;
    if (reveal.sessionId !== sessionId) return;
    setFiles((f) => (f.includes(reveal.path) ? f : [...f, reveal.path]));
    showFile(reveal.path);
  }, [reveal, sessionId, showFile]);

  const openFile = useCallback(
    (path: string) => {
      if (detachedSet.has(path)) {
        void focusEditorWindow(sessionId, path);
        return;
      }
      const pref = getEditorOpenMode();
      const isNew = !files.includes(path);
      setFiles((f) => (f.includes(path) ? f : [...f, path]));
      if (pref === "window" && isNew && connected) {
        void openInWindow(sessionId, path);
        return;
      }
      showFile(path);
      if (pref === "split") setSplit(true);
    },
    [detachedSet, files, sessionId, connected, showFile],
  );

  const closeFile = useCallback(
    async (path: string) => {
      if (useEditorDirty.getState().dirty[sessionId]?.includes(path)) {
        const ok = await confirmDialog({
          title: "Cambios sin guardar",
          message: `«${basename(path)}» tiene cambios sin guardar. ¿Cerrarlo y descartarlos?`,
          confirmText: "Descartar",
          danger: true,
        });
        if (!ok) return;
      }
      setDirty(sessionId, path, false);
      const idx = attached.indexOf(path);
      const next = attached.filter((p) => p !== path);
      setFiles((f) => f.filter((p) => p !== path));
      // Al cerrar el activo, pasar al de la izquierda (o al primero); sin más archivos, a la vista fija.
      if (current === path) {
        const n = idx > 0 ? next[idx - 1] : (next[0] ?? null);
        setActiveFile(n);
        if (!n) setFocus("fixed");
      }
    },
    [sessionId, setDirty, attached, current],
  );

  /** Manda el archivo a una ventana aparte. Si tiene cambios sin guardar, primero hay que guardarlos. */
  const detachFile = useCallback(
    async (path: string, at?: WindowAt) => {
      if (!connected) {
        toast.error("No se puede abrir en otra ventana", "No hay conexión con el servidor.");
        return;
      }
      const ed = editors.current.get(path);
      if (ed?.isDirty()) {
        const ok = await confirmDialog({
          title: "Cambios sin guardar",
          message: `«${basename(path)}» tiene cambios sin guardar. Se guardará en el servidor antes de abrirlo en otra ventana.`,
          confirmText: "Guardar y abrir",
        });
        if (!ok || !(await ed.save())) return;
      }
      setDirty(sessionId, path, false);
      await openInWindow(sessionId, path, at);
    },
    [connected, sessionId, setDirty],
  );

  /** Divide el área: la vista fija `id` a la izquierda y el archivo a la derecha. */
  const splitWith = useCallback((id: FixedTab, path?: string) => {
    setSide(id);
    if (path) setActiveFile(path);
    setFocus("file");
    setSplit(true);
  }, []);

  const unsplit = useCallback(() => {
    setSplit(false);
    setFocus("file");
  }, []);

  const toggleTerminal = useCallback(() => {
    const p = termPanel.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, [termPanel]);

  // Ctrl+` muestra/oculta la terminal y Ctrl+Shift+M divide o quita la división (en la pestaña activa).
  const hasEditors = attached.length > 0;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (!e.shiftKey && (e.code === "Backquote" || e.key === "`")) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
      } else if (e.shiftKey && (e.code === "KeyM" || e.key.toLowerCase() === "m") && hasEditors) {
        if (document.querySelector(".modal-backdrop")) return;
        e.preventDefault();
        e.stopPropagation();
        if (split) unsplit();
        else splitWith(side);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, toggleTerminal, hasEditors, split, side, splitWith, unsplit]);

  const onLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const l = meta.requestedLayout ?? layout;
      if ((l.terminal ?? 0) < 5) return; // no guardar el estado plegado
      setLayout("session", [l.work, l.terminal]);
    },
    [setLayout],
  );

  const onSplitChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const l = meta.requestedLayout ?? layout;
      if (!(l.side >= 10 && l.editors >= 10)) return;
      setLayout("sessionSplit", [l.side, l.editors]);
    },
    [setLayout],
  );

  // ── Arrastrar pestañas de archivo: reordenar dentro de la barra o despegar a una ventana aparte ──
  // Con eventos de puntero: el arrastre HTML5 lo intercepta Tauri (y en WebKitGTK falla).
  const drag = useRef<TabDrag | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  /** Archivo «despegado» (fuera de la barra): se dibuja un fantasma que sigue al cursor. */
  const [ghostPath, setGhostPath] = useState<string | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  /** Coloca la pestaña arrastrada bajo el cursor (desplazamiento visual, sin salir de las pestañas de archivo). */
  const placeDragged = useCallback(() => {
    const d = drag.current;
    if (!d?.moved) return;
    const g = ghostRef.current;
    if (g) {
      // Posición directa en el DOM: sin volver a dibujar la sesión entera en cada movimiento.
      g.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, d.clientX))}px`;
      g.style.top = `${Math.max(0, Math.min(window.innerHeight - 24, d.clientY))}px`;
    }
    if (d.out) {
      d.el.style.transform = "";
      return;
    }
    const tabs = Array.from(d.bar.querySelectorAll<HTMLElement>("[data-file-tab]"));
    if (tabs.length === 0) return;
    // offsetLeft es la posición sin el desplazamiento visual; se pasa a coordenadas de la barra visible.
    const scroll = d.bar.scrollLeft;
    const natural = d.el.offsetLeft - scroll;
    const minLeft = Math.min(...tabs.map((t) => t.offsetLeft)) - scroll;
    const maxLeft = Math.max(...tabs.map((t) => t.offsetLeft + t.offsetWidth)) - d.el.offsetWidth - scroll;
    const want = d.clientX - d.grabX - d.bar.getBoundingClientRect().left;
    const left = Math.max(minLeft, Math.min(maxLeft, want));
    d.el.style.transform = `translateX(${Math.round(left - natural)}px)`;
  }, []);

  // Tras reordenar (la pestaña cambió de sitio en el DOM) o al despegarse: recolocar.
  useLayoutEffect(() => placeDragged(), [files, ghostPath, placeDragged]);

  const endDrag = useCallback((drop: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.el.style.transform = "";
    setDragPath(null);
    setGhostPath(null);
    if (drop && d.moved && d.out) {
      void detachFile(d.path, { screenX: d.screenX, screenY: d.screenY });
    }
  }, [detachFile]);

  // Esc cancela el arrastre.
  useEffect(() => {
    if (!dragPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragPath, endDrag]);

  const onTabPointerDown = (e: RPointerEvent<HTMLDivElement>, path: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".sv-tab-close")) return;
    const el = e.currentTarget;
    const bar = el.parentElement;
    if (!bar) return;
    showFile(path);
    drag.current = {
      path,
      pointerId: e.pointerId,
      el,
      bar,
      x0: e.clientX,
      y0: e.clientY,
      grabX: e.clientX - el.getBoundingClientRect().left,
      moved: false,
      out: false,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    };
  };

  const onTabPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.clientX = e.clientX;
    d.clientY = e.clientY;
    d.screenX = e.screenX;
    d.screenY = e.screenY;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return;
      d.moved = true;
      try {
        d.el.setPointerCapture(d.pointerId);
      } catch {
        /* el puntero ya se soltó */
      }
      setDragPath(d.path);
    }
    const r = d.bar.getBoundingClientRect();
    const outside =
      e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
    d.out = connected && (outside || e.clientY > r.bottom + DETACH_MARGIN || e.clientY < r.top - DETACH_MARGIN);
    setGhostPath(d.out ? d.path : null);
    if (d.out) {
      placeDragged();
      return;
    }
    // Reordenar: cambiar de sitio con la pestaña bajo el cursor cuando, tras el cambio, el cursor seguiría
    // encima de la arrastrada (así no rebota entre pestañas de distinto ancho).
    const w = d.el.offsetWidth;
    const tabs = Array.from(d.bar.querySelectorAll<HTMLElement>("[data-file-tab]"));
    for (const t of tabs) {
      if (t === d.el) continue;
      const tr = t.getBoundingClientRect();
      if (e.clientX < tr.left || e.clientX >= tr.right) continue;
      const after = t.offsetLeft > d.el.offsetLeft;
      const swap = after ? e.clientX >= tr.right - w : e.clientX <= tr.left + w;
      const target = t.dataset.fileTab;
      if (swap && target) {
        setFiles((f) => {
          const from = f.indexOf(d.path);
          const to = f.indexOf(target);
          if (from < 0 || to < 0) return f;
          const n = f.slice();
          n.splice(from, 1);
          n.splice(to, 0, d.path);
          return n;
        });
      }
      break;
    }
    placeDragged();
  };

  const onTabPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.screenX = e.screenX;
    d.screenY = e.screenY;
    endDrag(true);
  };

  // Si el sistema retira el puntero sin «soltar» (p. ej. al salir de la ventana), vale la última posición.
  const onTabLostCapture = () => endDrag(true);
  const onTabPointerCancel = () => endDrag(false);

  const onMiddle = (e: MouseEvent, path: string) => {
    if (e.button === 1) {
      e.preventDefault();
      void closeFile(path);
    }
  };

  const dirtySet = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);

  const termToggle = (
    <button
      className={termCollapsed ? "icon-btn sv-bar-btn" : "icon-btn sv-bar-btn on"}
      onClick={toggleTerminal}
      title={termCollapsed ? "Mostrar terminal (Ctrl+`)" : "Ocultar terminal (Ctrl+`)"}
      aria-label="Mostrar u ocultar terminal"
    >
      {termCollapsed ? <PanelBottomOpen size={15} /> : <PanelBottomClose size={15} />}
    </button>
  );
  const detachedButton = <DetachedButton sessionId={sessionId} paths={detached} />;

  const tabMenuItems = (path: string): MenuItem[] => [
    {
      label: "Abrir en ventana aparte",
      icon: <ExternalLink size={14} />,
      disabled: !connected,
      onSelect: () => void detachFile(path),
    },
    { sep: true },
    ...(split
      ? [{ label: "Quitar división", icon: <PanelTop size={14} />, hint: "Ctrl+Shift+M", onSelect: unsplit }]
      : [
          {
            label: "Dividir con Archivos",
            icon: <Columns2 size={14} />,
            hint: side === "files" ? "Ctrl+Shift+M" : undefined,
            onSelect: () => splitWith("files", path),
          },
          {
            label: "Dividir con Comandos",
            icon: <Columns2 size={14} />,
            hint: side === "commands" ? "Ctrl+Shift+M" : undefined,
            onSelect: () => splitWith("commands", path),
          },
        ]),
    { sep: true },
    {
      label: "Copiar ruta",
      icon: <Copy size={14} />,
      onSelect: () => {
        clipboard.write(path).then(
          () => toast.success("Ruta copiada"),
          (e: unknown) => toast.error("No se pudo copiar", e),
        );
      },
    },
    { sep: true },
    { label: "Cerrar", icon: <X size={14} />, onSelect: () => void closeFile(path) },
  ];

  /** Pestañas de las vistas fijas. `isOn` dice cuál se marca como elegida. */
  const fixedTabs = (isOn: (id: FixedTab) => boolean, onPick: (id: FixedTab) => void) =>
    FIXED.map((f) => {
      const on = isOn(f.id);
      return (
        <button
          key={f.id}
          role="tab"
          aria-selected={on}
          className={on ? "sv-tab sv-tab-fixed active" : "sv-tab sv-tab-fixed"}
          onClick={() => onPick(f.id)}
          title={f.title}
        >
          {f.icon}
          <span>{f.label}</span>
        </button>
      );
    });

  /** Pestañas de los archivos (arrastrables). */
  const fileTabs = (isOn: (p: string) => boolean) =>
    stable.map((p) => {
      const on = isOn(p);
      const isDirty = dirtySet.has(p);
      const cls = ["sv-tab", "sv-tab-file", on && "active", dragPath === p && "dragging", ghostPath === p && "detaching"]
        .filter(Boolean)
        .join(" ");
      return (
        <div
          key={p}
          data-file-tab={p}
          role="tab"
          aria-selected={on}
          tabIndex={0}
          className={cls}
          style={{ order: attached.indexOf(p) + 1 }}
          title={`${p}\nArrastra fuera de la ventana para abrirlo aparte`}
          onClick={() => showFile(p)}
          onPointerDown={(e) => onTabPointerDown(e, p)}
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerUp}
          onPointerCancel={onTabPointerCancel}
          onLostPointerCapture={onTabLostCapture}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => onMiddle(e, p)}
          onContextMenu={(e) => {
            e.preventDefault();
            showFile(p);
            setTabMenu({ x: e.clientX, y: e.clientY, path: p });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") showFile(p);
            else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setTabMenu({ x: r.left, y: r.bottom, path: p });
            }
          }}
        >
          <FileCode2 size={14} className="sv-tab-icon" />
          <span className="sv-tab-title">{basename(p)}</span>
          <button
            className={isDirty ? "sv-tab-close dirty" : "sv-tab-close"}
            title={isDirty ? "Sin guardar — cerrar" : "Cerrar"}
            aria-label="Cerrar archivo"
            onClick={(e) => {
              e.stopPropagation();
              void closeFile(p);
            }}
          >
            <span className="sv-dirty-dot" />
            <X size={13} />
          </button>
        </div>
      );
    });

  const windowButton = (
    <button
      className="icon-btn sv-bar-btn"
      onClick={() => current && void detachFile(current)}
      disabled={!current || !connected}
      title="Abrir en ventana aparte (o arrastra la pestaña fuera de la ventana)"
      aria-label="Abrir en ventana aparte"
    >
      <ExternalLink size={15} />
    </button>
  );

  return (
    <div className={active ? "sv-root" : "sv-root sv-hidden"} aria-hidden={!active}>
      {tab.status === "reconnecting" && <ReconnectingBanner tab={tab} visible={active} />}
      {closed && (
        <div className="sv-banner" role="alert">
          <Unplug size={15} />
          <span className="sv-banner-text">
            <strong>Conexión perdida</strong>
            {tab.closedReason ? `: ${tab.closedReason}` : ""}
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => void reconnectTab(tab.id)}>
            <RotateCw size={13} /> Reconectar
          </button>
          <button className="btn btn-sm" onClick={() => void requestCloseTab(tab.id)}>
            Cerrar
          </button>
        </div>
      )}
      <Group orientation="vertical" className="sv-group" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <Panel id="work" minSize="120px" className="sv-work" style={{ overflow: "hidden" }}>
          {mode !== "split" && (
            // Modo pestañas: una sola fila con las vistas fijas y los archivos.
            <div className="sv-tabs" role="tablist" aria-label="Área de trabajo">
              {fixedTabs((id) => selected === id, showFixed)}
              {attached.length > 0 && <span className="sv-tabs-sep" aria-hidden />}
              {fileTabs((p) => selected === p)}
              <div className="sv-tabs-fill" />
              {detachedButton}
              {mode === "editors" && (
                <>
                  {windowButton}
                  <button
                    className="icon-btn sv-bar-btn"
                    onClick={() => splitWith(side)}
                    title={`Dividir con ${fixedLabel(side)} (Ctrl+Shift+M)`}
                    aria-label={`Dividir con ${fixedLabel(side)}`}
                  >
                    <Columns2 size={15} />
                  </button>
                </>
              )}
              {termToggle}
            </div>
          )}
          {/* Siempre los dos paneles montados (no se pierde el estado del explorador ni de los editores):
              según el modo, el CSS oculta uno de ellos. */}
          <Group
            orientation="horizontal"
            className="sv-split"
            data-mode={mode}
            disabled={mode !== "split"}
            defaultLayout={defaultSplit}
            onLayoutChanged={onSplitChanged}
          >
            <Panel id="side" data-sv-panel="side" minSize="200px" className="sv-col" style={{ overflow: "hidden" }}>
              {mode === "split" && (
                <div className="sv-tabs" role="tablist" aria-label="Vistas">
                  {fixedTabs((id) => side === id, setSide)}
                  <div className="sv-tabs-fill" />
                  {detachedButton}
                </div>
              )}
              <div className="sv-work-body">
                <div className={side === "files" ? "sv-pane" : "sv-pane sv-hidden"}>
                  <FileExplorer
                    sessionId={sessionId}
                    initialPath={tab.initialPath}
                    active={active && sideVisible && side === "files" && connected}
                    onOpenFile={openFile}
                    onPathChange={onPathChange}
                  />
                </div>
                {commandsMounted && (
                  <div className={side === "commands" ? "sv-pane" : "sv-pane sv-hidden"}>
                    <Suspense fallback={spinner()}>
                      <CommandsPanel
                        sessionId={sessionId}
                        profileId={tab.profileId}
                        active={active && sideVisible && side === "commands"}
                        disabled={!connected}
                      />
                    </Suspense>
                  </div>
                )}
                {containersMounted && (
                  <div className={side === "containers" ? "sv-pane" : "sv-pane sv-hidden"}>
                    <Suspense fallback={spinner()}>
                      <ContainersPanel
                        sessionId={sessionId}
                        profileId={tab.profileId}
                        active={active && sideVisible && side === "containers"}
                        disabled={!connected}
                      />
                    </Suspense>
                  </div>
                )}
                {monitorMounted && (
                  <div className={side === "monitor" ? "sv-pane" : "sv-pane sv-hidden"}>
                    <Suspense fallback={spinner()}>
                      <MonitorPanel
                        sessionId={sessionId}
                        profileId={tab.profileId}
                        active={active && sideVisible && side === "monitor"}
                        disabled={!connected}
                      />
                    </Suspense>
                  </div>
                )}
                {tunnelsMounted && (
                  <div className={side === "tunnels" ? "sv-pane" : "sv-pane sv-hidden"}>
                    <Suspense fallback={spinner()}>
                      <TunnelsPanel
                        sessionId={sessionId}
                        profileId={tab.profileId}
                        active={active && sideVisible && side === "tunnels"}
                        disabled={!connected}
                      />
                    </Suspense>
                  </div>
                )}
                {adminMounted && (
                  <div className={side === "admin" ? "sv-pane" : "sv-pane sv-hidden"}>
                    <Suspense fallback={spinner()}>
                      <AdminPanel
                        sessionId={sessionId}
                        profileId={tab.profileId}
                        active={active && sideVisible && side === "admin"}
                        disabled={!connected}
                      />
                    </Suspense>
                  </div>
                )}
              </div>
            </Panel>
            <Separator className="app-sep app-sep-v sv-split-sep">
              <span className="app-sep-grip" />
            </Separator>
            <Panel id="editors" data-sv-panel="editors" minSize="260px" className="sv-col sv-editors" style={{ overflow: "hidden" }}>
              {mode === "split" && (
                <div className="sv-tabs" role="tablist" aria-label="Archivos abiertos">
                  {fileTabs((p) => current === p)}
                  <div className="sv-tabs-fill" />
                  {windowButton}
                  <button
                    className="icon-btn sv-bar-btn on"
                    onClick={unsplit}
                    title="Quitar división (Ctrl+Shift+M)"
                    aria-label="Quitar división"
                    aria-pressed
                  >
                    <Columns2 size={15} />
                  </button>
                  {termToggle}
                </div>
              )}
              <div className="sv-work-body">
                {stable.map((p) => (
                  <div key={p} className={current === p ? "sv-pane" : "sv-pane sv-hidden"}>
                    <Suspense fallback={spinner("Cargando editor…")}>
                      <RemoteEditor
                        ref={(h: RemoteEditorHandle | null) => {
                          if (h) editors.current.set(p, h);
                          else editors.current.delete(p);
                        }}
                        sessionId={sessionId}
                        path={p}
                        active={active && editorsVisible && current === p}
                        offline={!connected}
                        onDirtyChange={(d) => setDirty(sessionId, p, d)}
                      />
                    </Suspense>
                  </div>
                ))}
              </div>
            </Panel>
          </Group>
        </Panel>
        <Separator className="app-sep app-sep-h">
          <span className="app-sep-grip" />
        </Separator>
        <Panel
          id="terminal"
          panelRef={termPanel}
          collapsible
          collapsedSize={0}
          minSize="90px"
          className="sv-terminal"
          style={{ overflow: "hidden" }}
          onResize={() => setTermCollapsed(termPanel.current?.isCollapsed() ?? false)}
        >
          <TerminalArea sessionId={sessionId} active={active && !termCollapsed} disabled={closed} />
        </Panel>
      </Group>
      {tabMenu && <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.path)} onClose={closeTabMenu} />}
      {ghostPath &&
        createPortal(
          <div className="sv-drag-ghost" ref={ghostRef} aria-hidden>
            <div className="sv-drag-ghost-tab">
              <FileCode2 size={14} />
              <span>{basename(ghostPath)}</span>
            </div>
            <div className="sv-drag-ghost-hint">
              <ExternalLink size={12} /> Suelta para abrir en otra ventana
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});
