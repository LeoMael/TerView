// Explorador de archivos remotos (SFTP). DUEÑO: agente SFTP/Explorador.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  Download,
  Eye,
  EyeOff,
  FilePlus,
  FolderDown,
  FolderOpen,
  FolderPlus,
  FolderUp,
  House,
  KeyRound,
  Pencil,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  X,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { sftp } from "../../api/sftp";
import { transfers } from "../../api/transfers";
import { errorMessage } from "../../api/core";
import { clipboard } from "../../lib/clipboard";
import { EV_TRANSFER_UPDATE, type FileEntry, type TransferJob } from "../../api/types";
import { formatBytes } from "../../lib/format";
import { basename, dirname, joinPath } from "../../lib/paths";
import { localBasename } from "../../lib/platform";
import { useSettings } from "../../stores/settings";
import { useTabs } from "../../stores/tabs";
import { toast } from "../../stores/toasts";
import { confirmDialog, promptDialog } from "../ui/dialogs";
import { Breadcrumb } from "./Breadcrumb";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { FileList, HEADER_H, ROW_H, type RowHandlers, type SortKey, type SortState } from "./FileList";
import { isDirLike } from "./icons";
import { PermissionsDialog } from "./PermissionsDialog";
import { revealWhenDone, systemDownloadDir } from "./revealDownload";
import "./FileExplorer.css";

export interface FileExplorerProps {
  sessionId: string;
  /** Carpeta inicial (null = home del usuario). */
  initialPath: string | null;
  /** Solo la pestaña activa reacciona a arrastrar/soltar y atajos. */
  active: boolean;
  /** Doble clic en un archivo: abrirlo en el editor. */
  onOpenFile: (path: string) => void;
  /** Se llama cada vez que cambia la carpeta actual (p. ej. para reabrirla al reconectar). */
  onPathChange?: (path: string) => void;
}

type HistoryMode = "push" | "back" | "forward" | "none";
interface LoadOpts {
  history?: HistoryMode;
  /** Ruta a seleccionar al terminar. */
  select?: string | null;
}

const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

function compareEntries(a: FileEntry, b: FileEntry, sort: SortState): number {
  const da = isDirLike(a);
  const db = isDirLike(b);
  if (da !== db) return da ? -1 : 1;
  let r = 0;
  switch (sort.key) {
    case "size":
      r = da ? 0 : a.size - b.size;
      break;
    case "modified":
      r = (a.modified ?? 0) - (b.modified ?? 0);
      break;
    case "permissions":
      r = a.permissionsStr < b.permissionsStr ? -1 : a.permissionsStr > b.permissionsStr ? 1 : 0;
      break;
    default:
      r = collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  if (r === 0 && sort.key !== "name") return collator.compare(a.name, b.name);
  return r * sort.dir;
}

function validateName(v: string): string | null {
  const t = v.trim();
  if (!t) return "Escribe un nombre";
  if (t.includes("/")) return "El nombre no puede contener «/»";
  if (t === "." || t === "..") return "Ese nombre no es válido";
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Devuelve una función estable que siempre llama a la versión más reciente de `fn`. */
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** ¿La conexión de la pestaña está activa? (sin pestaña = se asume que sí). */
function sessionOnline(sessionId: string): boolean {
  const t = useTabs.getState().tabs.find((x) => x.sessionId === sessionId);
  return !t || t.status === "connected";
}

export const FileExplorer = memo(function FileExplorer({
  sessionId,
  initialPath,
  active,
  onOpenFile,
  onPathChange,
}: FileExplorerProps) {
  // Estado de la conexión (reconexión automática / cierre definitivo).
  const tabStatus = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.status ?? "connected");
  const closedReason = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.closedReason ?? null);
  const reconnectCount = useTabs((s) => s.tabs.find((t) => t.sessionId === sessionId)?.reconnectCount ?? 0);
  const offline = tabStatus !== "connected";

  const showHidden = useSettings((s) => s.settings.showHiddenFiles);
  const confirmDelete = useSettings((s) => s.settings.confirmDelete);
  const updateSettings = useSettings((s) => s.update);

  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<{ path: string; err: unknown } | null>(null);
  const [hist, setHist] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "name", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; onEntry: boolean } | null>(null);
  const [permsFor, setPermsFor] = useState<FileEntry[] | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [drop, setDrop] = useState<{ over: boolean; target: string | null }>({ over: false, target: null });

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<string | null>(null);
  const homeRef = useRef<string | null>(null);
  const reqRef = useRef(0);
  const cwdRef = useRef<string | null>(null);
  const scrollToRef = useRef<string | null>(null);
  const typeAheadRef = useRef({ text: "", at: 0 });

  // ───────── Carga de carpetas ─────────

  const getHome = useCallback(async () => {
    if (!homeRef.current) homeRef.current = await sftp.home(sessionId);
    return homeRef.current;
  }, [sessionId]);

  const load = useEvent(async (path: string, opts: LoadOpts = {}) => {
    // Sin conexión no se pide nada (al reconectar se recarga la carpeta actual).
    if (!sessionOnline(sessionId)) return;
    const req = ++reqRef.current;
    setLoadingPath(path);
    try {
      const list = await sftp.listDir(sessionId, path);
      if (req !== reqRef.current) return;
      const prev = cwdRef.current;
      const same = prev === path;
      const mode = opts.history ?? "push";
      if (prev && !same) {
        if (mode === "push") setHist((h) => ({ back: [...h.back, prev].slice(-100), fwd: [] }));
        else if (mode === "back") setHist((h) => ({ back: h.back.slice(0, -1), fwd: [prev, ...h.fwd] }));
        else if (mode === "forward") setHist((h) => ({ back: [...h.back, prev], fwd: h.fwd.slice(1) }));
      }
      cwdRef.current = path;
      setCwd(path);
      setEntries(list);
      setError(null);
      if (opts.select) {
        setSelected(new Set([opts.select]));
        setCursor(opts.select);
        anchorRef.current = opts.select;
        scrollToRef.current = opts.select;
      } else if (same) {
        const exists = new Set(list.map((e) => e.path));
        setSelected((s) => new Set([...s].filter((p) => exists.has(p))));
        setCursor((c) => (c && exists.has(c) ? c : null));
      } else {
        setSelected(new Set());
        setCursor(null);
        anchorRef.current = null;
        setFilter("");
        if (listRef.current) listRef.current.scrollTop = 0;
      }
    } catch (err) {
      if (req !== reqRef.current) return;
      // La conexión se cayó mientras tanto: sin avisos (se recarga al reconectar).
      if (!sessionOnline(sessionId)) return;
      if (cwdRef.current && cwdRef.current !== path) {
        toast.error(`No se pudo abrir «${basename(path)}»`, err);
      } else {
        setError({ path, err });
      }
    } finally {
      if (req === reqRef.current) setLoadingPath(null);
    }
  });

  // Carga inicial (y si cambia la sesión).
  useEffect(() => {
    let cancelled = false;
    homeRef.current = null;
    cwdRef.current = null;
    setCwd(null);
    setEntries([]);
    setHist({ back: [], fwd: [] });
    (async () => {
      let start = initialPath;
      if (!start) {
        try {
          start = await getHome();
        } catch (err) {
          if (!cancelled) setError({ path: "~", err });
          return;
        }
      }
      if (!cancelled) load(start, { history: "none" });
    })();
    return () => {
      cancelled = true;
    };
    // initialPath solo cuenta al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Informa la carpeta actual (la pestaña la usa para reabrirla al reconectar).
  const notifyPath = useEvent((p: string) => onPathChange?.(p));
  useEffect(() => {
    if (cwd) notifyPath(cwd);
  }, [cwd, notifyPath]);

  const refresh = useEvent(() => {
    const target = cwdRef.current ?? error?.path;
    if (!target || target === "~") {
      getHome()
        .then((h) => load(h, { history: "none" }))
        .catch((err) => setError({ path: "~", err }));
      return;
    }
    load(target, { history: "none" });
  });

  // Reconectada (mismo sessionId, canales nuevos): recargar la carpeta actual.
  const seenReconnect = useRef(reconnectCount);
  useEffect(() => {
    if (reconnectCount === seenReconnect.current) return;
    seenReconnect.current = reconnectCount;
    if (!cwdRef.current && !error && initialPath) load(initialPath, { history: "none" });
    else refresh();
    setError(null);
    // Solo cuando sube el contador de reconexiones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectCount]);

  // Al perder la conexión se cierran menús y diálogos de esta vista.
  useEffect(() => {
    if (!offline) return;
    setMenu(null);
    setPermsFor(null);
    setEditingPath(false);
  }, [offline]);

  const navigate = useEvent(async (raw: string) => {
    let p = raw.trim();
    if (!p) return;
    if (p === "~" || p.startsWith("~/")) {
      try {
        p = joinPath(await getHome(), p.slice(2));
      } catch (err) {
        toast.error("No se pudo obtener la carpeta de inicio", err);
        return;
      }
    } else if (!p.startsWith("/")) {
      p = joinPath(cwdRef.current ?? "/", p);
    }
    p = p.length > 1 ? p.replace(/\/+$/, "") : p;
    // Si la ruta escrita es un archivo, se abre su carpeta y se selecciona.
    try {
      const st = await sftp.stat(sessionId, p);
      if (!isDirLike(st)) {
        load(dirname(p), { select: p });
        return;
      }
    } catch {
      /* el listado mostrará el error */
    }
    load(p);
  });

  const goUp = useEvent(() => {
    const c = cwdRef.current;
    if (!c || c === "/") return;
    load(dirname(c), { select: c });
  });
  const goBack = useEvent(() => {
    const t = hist.back[hist.back.length - 1];
    if (t) load(t, { history: "back" });
  });
  const goForward = useEvent(() => {
    const t = hist.fwd[0];
    if (t) load(t, { history: "forward" });
  });
  const goHome = useEvent(async () => {
    try {
      load(await getHome());
    } catch (err) {
      toast.error("No se pudo obtener la carpeta de inicio", err);
    }
  });

  // ───────── Filas visibles ─────────

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = entries.filter((e) => (showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
    list.sort((a, b) => compareEntries(a, b, sort));
    return list;
  }, [entries, filter, showHidden, sort]);

  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.path, i])), [rows]);
  const selectedEntries = useMemo(() => rows.filter((r) => selected.has(r.path)), [rows, selected]);

  const scrollToIndex = useCallback((i: number) => {
    const el = listRef.current;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    const minTop = HEADER_H + (i + 1) * ROW_H - el.clientHeight;
    if (el.scrollTop > top) el.scrollTop = top;
    else if (el.scrollTop < minTop) el.scrollTop = minTop;
  }, []);

  useEffect(() => {
    const p = scrollToRef.current;
    if (!p) return;
    const i = indexOf.get(p);
    if (i !== undefined) {
      scrollToRef.current = null;
      requestAnimationFrame(() => scrollToIndex(i));
    }
  }, [indexOf, scrollToIndex]);

  // ───────── Selección ─────────

  const selectOnly = useCallback((path: string) => {
    setSelected(new Set([path]));
    setCursor(path);
    anchorRef.current = path;
  }, []);

  const selectRange = useEvent((to: string, additive: boolean) => {
    const from = anchorRef.current ?? to;
    const a = indexOf.get(from) ?? indexOf.get(to) ?? 0;
    const b = indexOf.get(to) ?? 0;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = rows.slice(lo, hi + 1).map((r) => r.path);
    setSelected((s) => (additive ? new Set([...s, ...range]) : new Set(range)));
    setCursor(to);
  });

  const moveCursor = useEvent((index: number, shift: boolean, ctrl: boolean) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, index));
    const p = rows[i].path;
    if (shift) selectRange(p, ctrl);
    else if (ctrl) setCursor(p);
    else selectOnly(p);
    scrollToIndex(i);
  });

  const focusRoot = () => {
    if (active) rootRef.current?.focus({ preventScroll: true });
  };

  // ───────── Acciones ─────────

  const openEntry = useEvent((e: FileEntry) => {
    if (isDirLike(e)) load(e.path);
    else if (e.kind === "other") toast.info("No se puede abrir este elemento", "Solo se abren archivos y carpetas.");
    else onOpenFile(e.path);
  });

  const startUpload = useEvent(async (paths: string[], dir: string | null) => {
    if (!paths.length || !dir) return;
    try {
      await transfers.upload(sessionId, paths, dir);
      // Rutas locales: pueden venir con "\" y letra de unidad (Windows).
      const what = paths.length === 1 ? `«${localBasename(paths[0])}»` : plural(paths.length, "elemento", "elementos");
      toast.info(`Subiendo ${what}…`, `a ${dir}`);
    } catch (err) {
      toast.error("No se pudo iniciar la subida", err);
    }
  });

  const pickAndUpload = useEvent(async (folders: boolean) => {
    const dir = cwdRef.current;
    if (!dir) return;
    try {
      const res = await openDialog({ multiple: true, directory: folders, title: folders ? "Subir carpetas" : "Subir archivos" });
      const paths = res == null ? [] : Array.isArray(res) ? res : [res];
      await startUpload(paths, dir);
    } catch (err) {
      toast.error("No se pudo abrir el selector", err);
    }
    focusRoot();
  });

  /** "Descargar en…" (elige carpeta) o, con `reveal`, "Descargar y abrir carpeta": baja a
   *  Descargas y al terminar abre el gestor de archivos con lo descargado seleccionado. */
  const download = useEvent(async (list: FileEntry[], reveal = false) => {
    if (!list.length) return;
    try {
      let dir: string | null = reveal ? await systemDownloadDir() : null;
      if (!dir) {
        const res = await openDialog({ directory: true, multiple: false, title: "Descargar en…" });
        dir = (Array.isArray(res) ? res[0] : res) ?? null;
      }
      if (!dir) return;
      // `dir` es una ruta LOCAL (en Windows "C:\Users\…"): se pasa tal cual al motor, sin unirle "/".
      const batchId = await transfers.download(sessionId, list.map((e) => e.path), dir);
      if (reveal) revealWhenDone(batchId, dir, list);
      const what = list.length === 1 ? `«${list[0].name}»` : plural(list.length, "elemento", "elementos");
      toast.info(`Descargando ${what}…`, reveal ? `a ${dir}; al terminar se abrirá la carpeta` : `a ${dir}`);
    } catch (err) {
      toast.error("No se pudo iniciar la descarga", err);
    } finally {
      focusRoot();
    }
  });

  const createItem = useEvent(async (kind: "dir" | "file") => {
    const dir = cwdRef.current;
    if (!dir) return;
    const isDir = kind === "dir";
    const name = await promptDialog({
      title: isDir ? "Nueva carpeta" : "Nuevo archivo",
      label: "Nombre",
      placeholder: isDir ? "nueva-carpeta" : "archivo.txt",
      confirmText: "Crear",
      validate: validateName,
    });
    focusRoot();
    if (name == null) return;
    const path = joinPath(dir, name.trim());
    try {
      if (isDir) await sftp.mkdir(sessionId, path);
      else await sftp.createFile(sessionId, path);
      await load(dir, { history: "none", select: path });
      if (!isDir) onOpenFile(path);
    } catch (err) {
      toast.error(isDir ? "No se pudo crear la carpeta" : "No se pudo crear el archivo", err);
    }
  });

  const rename = useEvent(async (e: FileEntry) => {
    const name = await promptDialog({
      title: "Renombrar",
      label: "Nuevo nombre",
      initial: e.name,
      selectBaseName: !isDirLike(e),
      confirmText: "Renombrar",
      validate: validateName,
    });
    focusRoot();
    if (name == null || name.trim() === e.name) return;
    const to = joinPath(dirname(e.path), name.trim());
    try {
      await sftp.rename(sessionId, e.path, to);
      await load(dirname(e.path), { history: "none", select: to });
    } catch (err) {
      toast.error(`No se pudo renombrar «${e.name}»`, err);
    }
  });

  const remove = useEvent(async (list: FileEntry[]) => {
    if (!list.length) return;
    if (confirmDelete) {
      const hasDir = list.some((e) => e.kind === "dir");
      const shown = list.slice(0, 6);
      const ok = await confirmDialog({
        title: list.length === 1 ? `¿Eliminar «${list[0].name}»?` : `¿Eliminar ${list.length} elementos?`,
        message: (
          <>
            {list.length > 1 && (
              <ul className="fx-del-list">
                {shown.map((e) => (
                  <li key={e.path}>{e.name}</li>
                ))}
                {list.length > shown.length && <li className="faint">y {list.length - shown.length} más…</li>}
              </ul>
            )}
            {hasDir && <div>Las carpetas se borran con todo su contenido.</div>}
            <div>Esta acción no se puede deshacer.</div>
          </>
        ),
        confirmText: "Eliminar",
        danger: true,
      });
      focusRoot();
      if (!ok) return;
    }
    try {
      await sftp.delete(sessionId, list.map((e) => e.path));
    } catch (err) {
      toast.error("No se pudo eliminar", err);
    }
    refresh();
  });

  const applyPerms = useEvent(async (list: FileEntry[], mode: number) => {
    setPermsFor(null);
    focusRoot();
    const failed: string[] = [];
    let lastErr: unknown;
    for (const e of list) {
      try {
        await sftp.chmod(sessionId, e.path, mode);
      } catch (err) {
        failed.push(e.name);
        lastErr = err;
      }
    }
    if (failed.length === 1) toast.error(`No se pudieron cambiar los permisos de «${failed[0]}»`, lastErr);
    else if (failed.length > 1) toast.error(`No se pudieron cambiar los permisos de ${failed.length} elementos`, lastErr);
    refresh();
  });

  const copyPaths = useEvent(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      await clipboard.write(paths.join("\n"));
      toast.success(paths.length === 1 ? "Ruta copiada" : `${paths.length} rutas copiadas`);
    } catch (err) {
      toast.error("No se pudo copiar al portapapeles", errorMessage(err));
    }
  });

  // ───────── Ratón ─────────

  const handlers: RowHandlers = useMemo(
    () => ({
      onMouseDown: (e: ReactMouseEvent, entry: FileEntry) => {
        if (e.button !== 0) return;
        const mod = e.ctrlKey || e.metaKey;
        if (e.shiftKey) {
          e.preventDefault();
          selectRange(entry.path, mod);
        } else if (mod) {
          setSelected((s) => {
            const n = new Set(s);
            if (n.has(entry.path)) n.delete(entry.path);
            else n.add(entry.path);
            return n;
          });
          setCursor(entry.path);
          anchorRef.current = entry.path;
        } else {
          selectOnly(entry.path);
        }
      },
      onDoubleClick: (entry: FileEntry) => {
        if (sessionOnline(sessionId)) openEntry(entry);
      },
      onContextMenu: (e: ReactMouseEvent, entry: FileEntry) => {
        e.preventDefault();
        e.stopPropagation();
        if (!sessionOnline(sessionId)) return;
        setSelected((s) => {
          if (s.has(entry.path)) return s;
          anchorRef.current = entry.path;
          return new Set([entry.path]);
        });
        setCursor(entry.path);
        rootRef.current?.focus({ preventScroll: true });
        setMenu({ x: e.clientX, y: e.clientY, onEntry: true });
      },
    }),
    [openEntry, selectOnly, selectRange, sessionId],
  );

  const onEmptyMouseDown = useCallback(() => {
    setSelected(new Set());
    setCursor(null);
    anchorRef.current = null;
  }, []);

  const onEmptyContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      if (!sessionOnline(sessionId)) return;
      onEmptyMouseDown();
      rootRef.current?.focus({ preventScroll: true });
      setMenu({ x: e.clientX, y: e.clientY, onEntry: false });
    },
    [onEmptyMouseDown, sessionId],
  );

  const onSort = useCallback((key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }, []);

  // ───────── Teclado ─────────

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!active || offline) return;
    const t = e.target as HTMLElement;
    // Teclas dentro de un diálogo (permisos, etc.) no son para la lista.
    if (t.closest(".modal-backdrop")) return;
    const inInput = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (mod && key.toLowerCase() === "l") {
      e.preventDefault();
      setEditingPath(true);
      return;
    }
    if (mod && key.toLowerCase() === "f") {
      e.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
      return;
    }
    if (key === "F5") {
      e.preventDefault();
      refresh();
      return;
    }
    // Con un botón enfocado, Intro/Espacio activan el botón (no la fila).
    if ((key === "Enter" || key === " ") && t !== rootRef.current && t.closest("button, a, select")) return;
    if (inInput) {
      if (key === "Escape" && t === filterRef.current) {
        e.preventDefault();
        if (filter) setFilter("");
        else rootRef.current?.focus();
      } else if (key === "ArrowDown" && t === filterRef.current) {
        e.preventDefault();
        rootRef.current?.focus();
        moveCursor(0, false, false);
      }
      return;
    }

    const cur = cursor ? (indexOf.get(cursor) ?? -1) : -1;
    const page = Math.max(1, Math.floor(((listRef.current?.clientHeight ?? 300) - HEADER_H) / ROW_H) - 1);
    const curEntry = cur >= 0 ? rows[cur] : selectedEntries.length === 1 ? selectedEntries[0] : undefined;

    if (e.altKey) {
      if (key === "ArrowUp") goUp();
      else if (key === "ArrowLeft") goBack();
      else if (key === "ArrowRight") goForward();
      else return;
      e.preventDefault();
      return;
    }

    switch (key) {
      case "ArrowDown":
        moveCursor(cur + 1, e.shiftKey, mod);
        break;
      case "ArrowUp":
        moveCursor(cur < 0 ? rows.length - 1 : cur - 1, e.shiftKey, mod);
        break;
      case "PageDown":
        moveCursor(cur + page, e.shiftKey, mod);
        break;
      case "PageUp":
        moveCursor(cur - page, e.shiftKey, mod);
        break;
      case "Home":
        moveCursor(0, e.shiftKey, mod);
        break;
      case "End":
        moveCursor(rows.length - 1, e.shiftKey, mod);
        break;
      case " ":
        if (!mod || !cursor) return;
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(cursor)) n.delete(cursor);
          else n.add(cursor);
          return n;
        });
        break;
      case "Enter":
        if (!curEntry) return;
        openEntry(curEntry);
        break;
      case "Backspace":
        goUp();
        break;
      case "Delete":
        remove(selectedEntries);
        break;
      case "F2":
        if (!curEntry) return;
        rename(curEntry);
        break;
      case "Escape":
        if (!selected.size) return;
        setSelected(new Set());
        break;
      default:
        if (mod && key.toLowerCase() === "a") {
          setSelected(new Set(rows.map((r) => r.path)));
          break;
        }
        // Búsqueda rápida escribiendo el nombre.
        if (key.length === 1 && !mod && key !== " ") {
          const now = Date.now();
          const ta = typeAheadRef.current;
          ta.text = now - ta.at < 800 ? ta.text + key.toLowerCase() : key.toLowerCase();
          ta.at = now;
          const from = ta.text.length === 1 ? cur + 1 : Math.max(cur, 0);
          for (let k = 0; k < rows.length; k++) {
            const i = (from + k) % rows.length;
            if (rows[i].name.toLowerCase().startsWith(ta.text)) {
              moveCursor(i, false, false);
              break;
            }
          }
          break;
        }
        return;
    }
    e.preventDefault();
  };

  // ───────── Arrastrar y soltar desde el sistema ─────────

  const dropRef = useRef(drop);
  const setDropState = useCallback((over: boolean, target: string | null) => {
    const d = dropRef.current;
    if (d.over === over && d.target === target) return;
    dropRef.current = { over, target };
    setDrop(dropRef.current);
  }, []);

  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      getCurrentWebview()
        .onDragDropEvent((ev) => {
          const p = ev.payload;
          if (p.type === "leave") {
            setDropState(false, null);
            return;
          }
          const root = rootRef.current;
          if (!root || root.offsetParent === null) return;
          const dpr = window.devicePixelRatio || 1;
          const x = p.position.x / dpr;
          const y = p.position.y / dpr;
          const r = root.getBoundingClientRect();
          const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          let target: string | null = null;
          if (inside) {
            const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-fx-dir]");
            if (el && root.contains(el)) target = el.dataset.fxPath ?? null;
          }
          if (!sessionOnline(sessionId)) {
            setDropState(false, null);
            return;
          }
          if (p.type === "drop") {
            setDropState(false, null);
            if (inside) startUpload(p.paths, target ?? cwdRef.current);
            return;
          }
          setDropState(inside, target);
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      /* fuera de Tauri */
    }
    return () => {
      disposed = true;
      unlisten?.();
      setDropState(false, null);
    };
  }, [active, sessionId, setDropState, startUpload]);

  // ───────── Refresco automático tras subidas ─────────

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    listen<TransferJob[]>(EV_TRANSFER_UPDATE, (ev) => {
      const dir = cwdRef.current;
      if (!dir || !sessionOnline(sessionId)) return;
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const hit = ev.payload.some(
        (j) => j.sessionId === sessionId && j.direction === "upload" && j.status === "done" && j.remotePath.startsWith(prefix),
      );
      if (!hit) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (cwdRef.current === dir) load(dir, { history: "none" });
      }, 600);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [sessionId, load]);

  // ───────── Menú contextual ─────────

  const menuItems = (): MenuItem[] => {
    if (!menu) return [];
    if (!menu.onEntry || !selectedEntries.length) {
      return [
        { label: "Nueva carpeta", icon: <FolderPlus size={15} />, onSelect: () => createItem("dir") },
        { label: "Nuevo archivo", icon: <FilePlus size={15} />, onSelect: () => createItem("file") },
        { sep: true },
        { label: "Subir archivos…", icon: <Upload size={15} />, onSelect: () => pickAndUpload(false) },
        { label: "Subir carpeta…", icon: <FolderUp size={15} />, onSelect: () => pickAndUpload(true) },
        { sep: true },
        { label: "Copiar ruta", icon: <ClipboardCopy size={15} />, disabled: !cwd, onSelect: () => cwd && copyPaths([cwd]) },
        { label: "Refrescar", icon: <RefreshCw size={15} />, hint: "F5", onSelect: () => refresh() },
      ];
    }
    const list = selectedEntries;
    const single = list.length === 1 ? list[0] : null;
    const singleDir = single ? isDirLike(single) : false;
    return [
      {
        label: singleDir ? "Abrir" : "Editar",
        icon: singleDir ? <FolderOpen size={15} /> : <SquarePen size={15} />,
        hint: "Intro",
        disabled: !single || single.kind === "other",
        onSelect: () => single && openEntry(single),
      },
      { label: "Descargar en…", icon: <Download size={15} />, onSelect: () => download(list) },
      {
        label: "Descargar y abrir carpeta",
        icon: <FolderDown size={15} />,
        onSelect: () => download(list, true),
      },
      { sep: true },
      { label: "Renombrar", icon: <Pencil size={15} />, hint: "F2", disabled: !single, onSelect: () => single && rename(single) },
      { label: "Permisos…", icon: <KeyRound size={15} />, onSelect: () => setPermsFor(list) },
      { label: list.length > 1 ? "Copiar rutas" : "Copiar ruta", icon: <ClipboardCopy size={15} />, onSelect: () => copyPaths(list.map((e) => e.path)) },
      { sep: true },
      { label: "Eliminar", icon: <Trash2 size={15} />, hint: "Supr", danger: true, onSelect: () => remove(list) },
    ];
  };

  // ───────── Render ─────────

  const loading = loadingPath !== null;
  const shownPath = cwd ?? (error?.path !== "~" ? error?.path : null) ?? loadingPath ?? "";
  const selSize = selectedEntries.reduce((n, e) => n + (isDirLike(e) ? 0 : e.size), 0);
  const hasSelDirs = selectedEntries.some(isDirLike);

  let placeholder: ReactNode = undefined;
  if (tabStatus === "closed") {
    placeholder = (
      <div className="empty-state fx-error">
        <Unplug size={28} />
        <strong>Conexión cerrada</strong>
        <span className="fx-error-msg">{closedReason ?? "Se perdió la conexión con el servidor"}</span>
      </div>
    );
  } else if (error && (!cwd || error.path === cwd)) {
    const atRoot = error.path === "/" || error.path === "~";
    placeholder = (
      <div className="empty-state fx-error">
        <TriangleAlert size={28} />
        <strong>No se pudo abrir la carpeta</strong>
        <span className="fx-error-msg">{errorMessage(error.err)}</span>
        <div className="fx-error-actions">
          <button className="btn btn-sm btn-primary" onClick={refresh}>
            <RefreshCw size={14} /> Reintentar
          </button>
          {!atRoot && (
            <button className="btn btn-sm" onClick={() => load(dirname(error.path))}>
              <ArrowUp size={14} /> Subir un nivel
            </button>
          )}
          <button className="btn btn-sm" onClick={goHome}>
            <House size={14} /> Ir al inicio
          </button>
        </div>
      </div>
    );
  } else if (cwd === null) {
    placeholder = (
      <div className="empty-state">
        <div className="spinner" />
        <span>Cargando…</span>
      </div>
    );
  } else if (!rows.length) {
    placeholder = (
      <div className="empty-state fx-empty">
        {filter.trim() ? (
          <span>Nada coincide con «{filter.trim()}»</span>
        ) : entries.length ? (
          <span>Solo hay archivos ocultos</span>
        ) : (
          <span>Carpeta vacía</span>
        )}
        <span className="faint">Arrastra archivos aquí para subirlos</span>
      </div>
    );
  }

  let cls = "fx-root";
  if (offline) cls += " fx-offline";
  if (drop.over) cls += " drop-over";
  if (drop.over && !drop.target) cls += " drop-here";

  return (
    <div ref={rootRef} className={cls} tabIndex={0} onKeyDown={onKeyDown} aria-label="Explorador de archivos">
      <div className="fx-toolbar">
        <div className="fx-nav">
          <button className="icon-btn" onClick={goBack} disabled={offline || !hist.back.length} title="Atrás (Alt+←)" aria-label="Atrás">
            <ArrowLeft size={15} />
          </button>
          <button className="icon-btn" onClick={goForward} disabled={offline || !hist.fwd.length} title="Adelante (Alt+→)" aria-label="Adelante">
            <ArrowRight size={15} />
          </button>
          <button className="icon-btn" onClick={goUp} disabled={offline || !cwd || cwd === "/"} title="Carpeta superior (Alt+↑)" aria-label="Subir un nivel">
            <ArrowUp size={15} />
          </button>
          <button className="icon-btn" onClick={refresh} disabled={offline} title="Refrescar (F5)" aria-label="Refrescar">
            <RefreshCw size={15} className={loading ? "fx-spin" : undefined} />
          </button>
          <button className="icon-btn" onClick={goHome} disabled={offline} title="Carpeta de inicio" aria-label="Inicio">
            <House size={15} />
          </button>
        </div>
        <div className="fx-path">
          <Breadcrumb
            path={shownPath}
            editing={editingPath && !offline}
            onEditingChange={(v) => {
              setEditingPath(v);
              if (!v) focusRoot();
            }}
            onNavigate={(p) => {
              if (!offline) navigate(p);
            }}
          />
        </div>
        <div className="fx-filter">
          <Search size={13} className="fx-filter-icon" />
          <input
            ref={filterRef}
            className="input"
            value={filter}
            placeholder="Filtrar"
            spellCheck={false}
            aria-label="Filtrar por nombre"
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button className="fx-filter-clear" onClick={() => setFilter("")} aria-label="Limpiar filtro" tabIndex={-1}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="fx-actions">
        <button className="btn btn-sm btn-accent" onClick={() => pickAndUpload(false)} disabled={offline || !cwd} title="Subir archivos a esta carpeta">
          <Upload size={14} />
          <span className="fx-btn-label">Subir</span>
        </button>
        <button className="btn btn-sm" onClick={() => pickAndUpload(true)} disabled={offline || !cwd} title="Subir carpetas a esta carpeta">
          <FolderUp size={14} />
          <span className="fx-btn-label">Subir carpeta</span>
        </button>
        <button
          className="btn btn-sm"
          onClick={() => download(selectedEntries)}
          disabled={offline || !selectedEntries.length}
          title="Descargar los elementos seleccionados"
        >
          <Download size={14} />
          <span className="fx-btn-label">Descargar</span>
        </button>
        <span className="fx-actions-sep" />
        <button className="btn btn-sm" onClick={() => createItem("dir")} disabled={offline || !cwd} title="Nueva carpeta">
          <FolderPlus size={14} />
          <span className="fx-btn-label">Nueva carpeta</span>
        </button>
        <button className="btn btn-sm" onClick={() => createItem("file")} disabled={offline || !cwd} title="Nuevo archivo">
          <FilePlus size={14} />
          <span className="fx-btn-label">Nuevo archivo</span>
        </button>
        <span className="fx-actions-fill" />
        <button
          className={showHidden ? "icon-btn fx-toggle on" : "icon-btn fx-toggle"}
          onClick={() => updateSettings({ showHiddenFiles: !showHidden })}
          title={showHidden ? "Ocultar archivos ocultos" : "Mostrar archivos ocultos"}
          aria-label="Mostrar archivos ocultos"
          aria-pressed={showHidden}
        >
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </div>

      <div className="fx-main">
        {loading && <div className="fx-loadbar" />}
        <FileList
          rows={rows}
          selected={selected}
          cursor={cursor}
          dropTarget={drop.target}
          sort={sort}
          onSort={onSort}
          handlers={handlers}
          onEmptyMouseDown={onEmptyMouseDown}
          onEmptyContextMenu={onEmptyContextMenu}
          containerRef={listRef}
          placeholder={placeholder}
        />
        {drop.over && (
          <div className="fx-drop-hint">
            <Upload size={14} />
            Soltar para subir a <strong>{drop.target ? basename(drop.target) : basename(cwd ?? "/")}</strong>
          </div>
        )}
      </div>

      <div className="fx-status">
        <span>
          {plural(rows.length, "elemento", "elementos")}
          {rows.length !== entries.length && <span className="faint"> (de {entries.length})</span>}
        </span>
        {selectedEntries.length > 0 && (
          <span>
            · {plural(selectedEntries.length, "seleccionado", "seleccionados")}
            {selSize > 0 || !hasSelDirs ? ` (${formatBytes(selSize)}${hasSelDirs ? " + carpetas" : ""})` : ""}
          </span>
        )}
      </div>

      {tabStatus === "reconnecting" && (
        <div className="fx-reconnecting" role="status" aria-live="polite">
          <span className="fx-reconnecting-pill">
            <RefreshCw size={13} className="fx-spin" />
            Reconectando…
          </span>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={closeMenu} />}
      {permsFor && (
        <PermissionsDialog
          entries={permsFor}
          onCancel={() => {
            setPermsFor(null);
            focusRoot();
          }}
          onApply={(mode) => applyPerms(permsFor, mode)}
        />
      )}
    </div>
  );
});
