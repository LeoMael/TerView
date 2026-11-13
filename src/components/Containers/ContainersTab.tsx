// Lista de contenedores: filtros, búsqueda, acciones por fila y en lote, CPU/memoria en vivo.
import { useCallback, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  Copy,
  FileSearch,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  Search,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import {
  ago,
  containerAction,
  execShellCmd,
  logsCmd,
  percent,
  portLabel,
  removeContainers,
  renameContainer,
  stateText,
  stateTone,
  statsFor,
  validateObjName,
  withOwner,
  type Container,
  type ContainerAction,
  type PortMapping,
} from "../../features/containers";
import { formatBytes } from "../../lib/format";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { promptDialog } from "../ui/dialogs";
import { ContextMenu, type MenuItem } from "../Admin/ContextMenu";
import { PICK_OWNER_HINT, useCt } from "./context";
import { openPortTunnel } from "./tunnel";

type Filter = "all" | "running" | "stopped";
type SortKey = "name" | "owner" | "image" | "state" | "created" | "cpu" | "mem";

const ACTION_TEXT: Record<ContainerAction, { done: string; verb: string }> = {
  start: { done: "Contenedor iniciado", verb: "Iniciar" },
  stop: { done: "Contenedor parado", verb: "Parar" },
  restart: { done: "Contenedor reiniciado", verb: "Reiniciar" },
  pause: { done: "Contenedor en pausa", verb: "Pausar" },
  unpause: { done: "Contenedor reanudado", verb: "Reanudar" },
};

/** Clave única de la fila (con «Todos», dos usuarios podrían repetir id o nombre). */
const rowKey = (c: Container) => `${c.owner ?? ""}/${c.id}`;

function copy(text: string, what = "Copiado") {
  clipboard.write(text).then(
    () => toast.success(what, text),
    (e) => toast.error("No se pudo copiar", e),
  );
}

export function ContainersTab() {
  const ct = useCt();
  const { engine, res, stats } = ct;
  const list = useMemo(() => res.containers.data ?? [], [res.containers.data]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "state", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "sep")[] } | null>(null);

  const counts = useMemo(
    () => ({
      all: list.length,
      running: list.filter((c) => c.state === "running" || c.state === "restarting").length,
      stopped: list.filter((c) => c.state !== "running" && c.state !== "restarting").length,
    }),
    [list],
  );

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const out = list.filter((c) => {
      if (filter === "running" && c.state !== "running" && c.state !== "restarting") return false;
      if (filter === "stopped" && (c.state === "running" || c.state === "restarting")) return false;
      if (!s) return true;
      return (
        (ct.allOwners && ct.ownerLabel(c.owner).toLowerCase().includes(s)) ||
        c.name.toLowerCase().includes(s) ||
        c.image.toLowerCase().includes(s) ||
        c.shortId.includes(s) ||
        (c.composeProject ?? "").toLowerCase().includes(s) ||
        c.ports.some((p) => String(p.hostPort ?? p.containerPort).includes(s))
      );
    });
    const val = (c: Container): string | number => {
      const st = statsFor(stats, c);
      switch (sort.key) {
        case "name":
          return c.name.toLowerCase();
        case "owner":
          return `${ct.ownerLabel(c.owner)} ${c.name.toLowerCase()}`;
        case "image":
          return c.image.toLowerCase();
        case "state":
          return `${c.state === "running" ? 0 : 1}${c.name.toLowerCase()}`;
        case "created":
          return c.created ?? 0;
        case "cpu":
          return st?.cpuPercent ?? -1;
        case "mem":
          return st?.memUsage ?? -1;
      }
    };
    return out.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, filter, search, sort, stats, ct.allOwners, ct.ownerLabel]);

  const visibleIds = new Set(rows.map(rowKey));
  const sel = list.filter((c) => selected.has(rowKey(c)) && visibleIds.has(rowKey(c)));

  const setBusyIds = (ids: string[], on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });

  // ───────── Acciones ─────────
  const direct = useCallback(
    async (action: ContainerAction, cs: Container[]) => {
      const ids = cs.map(rowKey);
      setBusyIds(ids, true);
      const r = await ct.run(ct.perOwner(cs, (g) => containerAction(engine, action, g.map((c) => c.name || c.id))), 120);
      setBusyIds(ids, false);
      if (r.ok) toast.success(cs.length > 1 ? `${ACTION_TEXT[action].verb}: ${cs.length} contenedores` : ACTION_TEXT[action].done, cs.length === 1 ? cs[0].name : undefined);
      else toast.error(`No se pudo ${ACTION_TEXT[action].verb.toLowerCase()}`, r.error ?? undefined);
      await ct.reload("containers");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ct.run, ct.reload, ct.perOwner, engine],
  );

  const names = (cs: Container[]) => (
    <ul className="ct-list">
      {cs.slice(0, 12).map((c) => (
        <li key={rowKey(c)}>
          <span className={`ct-dot ct-${stateTone(c.state)}`} /> <strong>{c.name}</strong> <span className="faint">{c.image}</span>
          {ct.allOwners && <span className="ct-tag">{ct.ownerLabel(c.owner)}</span>}
        </li>
      ))}
      {cs.length > 12 && <li className="faint">… y {cs.length - 12} más</li>}
    </ul>
  );

  const confirmAction = (action: "stop" | "restart", cs: Container[]) => {
    ct.review({
      title: `${ACTION_TEXT[action].verb} ${cs.length > 1 ? `${cs.length} contenedores` : `«${cs[0].name}»`}`,
      message:
        action === "stop"
          ? "Se enviará la señal de parada; si no termina en 10 segundos se fuerza."
          : "Se parará y se volverá a arrancar. Los servicios dejarán de responder unos segundos.",
      details: () => names(cs),
      build: () => ct.perOwner(cs, (g) => containerAction(engine, action, g.map((c) => c.name || c.id))),
      runLabel: ACTION_TEXT[action].verb,
      success: cs.length > 1 ? `${ACTION_TEXT[action].verb}: ${cs.length} contenedores` : ACTION_TEXT[action].done,
      reload: ["containers"],
      onDone: () => setSelected(new Set()),
    });
  };

  const confirmRemove = (cs: Container[]) => {
    const anyRunning = cs.some((c) => c.state === "running" || c.state === "paused" || c.state === "restarting");
    ct.review({
      title: cs.length > 1 ? `Eliminar ${cs.length} contenedores` : `Eliminar «${cs[0].name}»`,
      message: "Se borra el contenedor y todo lo que tenga dentro que no esté en un volumen o carpeta montada. No se puede deshacer.",
      details: () => names(cs),
      options: [
        {
          key: "force",
          label: "Forzar (parar si está en marcha)",
          hint: anyRunning ? "Hay contenedores en marcha" : undefined,
          initial: anyRunning,
        },
        { key: "volumes", label: "Borrar también sus volúmenes anónimos (-v)" },
      ],
      build: (o) => ct.perOwner(cs, (g) => removeContainers(engine, g.map((c) => c.name || c.id), { force: !!o.force, volumes: !!o.volumes })),
      danger: true,
      runLabel: "Eliminar",
      success: cs.length > 1 ? `${cs.length} contenedores eliminados` : `Contenedor «${cs[0].name}» eliminado`,
      reload: ["containers"],
      onDone: () => setSelected(new Set()),
    });
  };

  const rename = async (c: Container) => {
    const name = await promptDialog({
      title: `Renombrar «${c.name}»`,
      label: "Nuevo nombre",
      initial: c.name,
      confirmText: "Renombrar",
      validate: (v) => validateObjName(v.trim()) ?? (v.trim() === c.name ? "Es el mismo nombre" : null),
    });
    if (!name) return;
    setBusyIds([rowKey(c)], true);
    const r = await ct.run([withOwner(renameContainer(engine, c.id, name.trim()), c.owner)], 30);
    setBusyIds([rowKey(c)], false);
    if (r.ok) toast.success("Contenedor renombrado", `${c.name} → ${name.trim()}`);
    else toast.error("No se pudo renombrar", r.error ?? undefined);
    await ct.reload("containers");
  };

  const openLogs = (c: Container) =>
    ct.openLogs({
      title: ct.allOwners ? `Logs de «${c.name}» (${ct.ownerLabel(c.owner)})` : `Logs de «${c.name}»`,
      build: (tail, ts) => withOwner(logsCmd(engine, c.name || c.id, tail, { timestamps: ts }), c.owner),
      follow: (tail) => withOwner(logsCmd(engine, c.name || c.id, tail, { follow: true }), c.owner),
    });

  const isUp = (c: Container) => c.state === "running" || c.state === "restarting";

  const rowMenu = (c: Container): (MenuItem | "sep")[] => [
    isUp(c)
      ? { label: "Parar", icon: <Square size={13} />, onClick: () => confirmAction("stop", [c]) }
      : { label: "Iniciar", icon: <Play size={13} />, onClick: () => void direct(c.state === "paused" ? "unpause" : "start", [c]) },
    { label: "Reiniciar", icon: <RotateCw size={13} />, onClick: () => confirmAction("restart", [c]), disabled: !isUp(c) && c.state !== "paused" },
    c.state === "paused"
      ? { label: "Reanudar", icon: <Play size={13} />, onClick: () => void direct("unpause", [c]) }
      : { label: "Pausar", icon: <Pause size={13} />, onClick: () => void direct("pause", [c]), disabled: c.state !== "running" },
    "sep",
    { label: "Ver logs", icon: <ScrollText size={13} />, onClick: () => openLogs(c) },
    {
      label: "Terminal dentro",
      icon: <TerminalSquare size={13} />,
      onClick: () => ct.toTerminal(withOwner(execShellCmd(engine, c.name || c.id), c.owner), true),
      disabled: c.state !== "running",
    },
    { label: "Inspeccionar", icon: <FileSearch size={13} />, onClick: () => ct.openInspect(c) },
    { label: "Renombrar…", icon: <Pencil size={13} />, onClick: () => void rename(c) },
    "sep",
    { label: "Copiar nombre", icon: <Copy size={13} />, onClick: () => copy(c.name, "Nombre copiado") },
    { label: "Copiar ID", icon: <Copy size={13} />, onClick: () => copy(c.id, "ID copiado") },
    "sep",
    { label: "Eliminar…", icon: <Trash2 size={13} />, onClick: () => confirmRemove([c]), danger: true },
  ];

  const portMenu = (e: MouseEvent, p: PortMapping) => {
    e.stopPropagation();
    const port = p.hostPort;
    if (port === null) return;
    const host = p.hostIp && p.hostIp !== "127.0.0.1" && p.hostIp !== "::1" ? p.hostIp : "localhost";
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      items: [
        { label: `Copiar ${host}:${port}`, icon: <Copy size={13} />, onClick: () => copy(`${host}:${port}`, "Dirección copiada") },
        {
          label: "Abrir túnel a mi PC…",
          icon: <Play size={13} />,
          title: "Crea un túnel SSH para usar este puerto desde tu PC",
          onClick: () => void openPortTunnel(ct.sessionId, ct.profileId, p),
          disabled: p.protocol !== "tcp",
        },
      ],
    });
  };

  const openRowMenu = (e: MouseEvent | KeyboardEvent, c: Container) => {
    e.preventDefault();
    let x: number;
    let y: number;
    if ("clientX" in e && e.clientX) {
      x = e.clientX;
      y = e.clientY;
    } else {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      x = r.right - 200;
      y = r.bottom;
    }
    setMenu({ x, y, items: rowMenu(c) });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, c: Container) => {
    if (e.target !== e.currentTarget) return;
    const tr = e.currentTarget;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (tr.nextElementSibling as HTMLElement | null)?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (tr.previousElementSibling as HTMLElement | null)?.focus();
    } else if (e.key === " ") {
      e.preventDefault();
      toggle(rowKey(c));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openLogs(c);
    } else if (e.key === "Delete") {
      e.preventDefault();
      confirmRemove([c]);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      openRowMenu(e, c);
    }
  };

  const sortBy = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === "created" || key === "cpu" || key === "mem" ? -1 : 1 }));
  const th = (key: SortKey, label: string, cls?: string) => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="ct-th" onClick={() => sortBy(key)}>
        {label}
        {sort.key === key && <span className="ct-sort">{sort.dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </th>
  );

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(rowKey(r)));
  const loading = res.containers.loading;

  return (
    <div className="ct-tab-body">
      <div className="ct-toolbar">
        <div className="ct-seg ct-seg-sm" role="radiogroup" aria-label="Filtro">
          {(
            [
              ["all", "Todos"],
              ["running", "En marcha"],
              ["stopped", "Parados"],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {label} <span className="ct-count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="ct-search">
          <Search size={13} />
          <input
            className="input"
            placeholder="Buscar nombre, imagen, puerto…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar contenedores"
          />
          {search && (
            <button className="icon-btn" onClick={() => setSearch("")} aria-label="Limpiar búsqueda">
              <X size={12} />
            </button>
          )}
        </div>
        <span className="ct-grow" />
        <button className="icon-btn" onClick={() => void ct.reload("containers")} title="Actualizar" aria-label="Actualizar" disabled={loading}>
          <RefreshCw size={14} className={loading ? "ct-spin" : undefined} />
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => ct.openRunForm()}
          disabled={!ct.newOwner}
          title={ct.newOwner ? undefined : PICK_OWNER_HINT}
        >
          <Plus size={13} /> Nuevo contenedor
        </button>
      </div>

      {sel.length > 0 && (
        <div className="ct-batch" role="toolbar" aria-label="Acciones sobre la selección">
          <strong>{sel.length} seleccionados</strong>
          <button className="btn btn-sm" onClick={() => void direct("start", sel.filter((c) => !isUp(c) && c.state !== "paused"))} disabled={!sel.some((c) => !isUp(c) && c.state !== "paused")}>
            <Play size={13} /> Iniciar
          </button>
          <button className="btn btn-sm" onClick={() => confirmAction("stop", sel.filter(isUp))} disabled={!sel.some(isUp)}>
            <Square size={13} /> Parar
          </button>
          <button className="btn btn-sm" onClick={() => confirmAction("restart", sel)}>
            <RotateCw size={13} /> Reiniciar
          </button>
          <button className="btn btn-sm" onClick={() => void direct("pause", sel.filter((c) => c.state === "running"))} disabled={!sel.some((c) => c.state === "running")}>
            <Pause size={13} /> Pausar
          </button>
          <button className="btn btn-sm" onClick={() => void direct("unpause", sel.filter((c) => c.state === "paused"))} disabled={!sel.some((c) => c.state === "paused")}>
            <Play size={13} /> Reanudar
          </button>
          <button className="btn btn-sm ct-btn-danger" onClick={() => confirmRemove(sel)}>
            <Trash2 size={13} /> Eliminar
          </button>
          <span className="ct-grow" />
          <button className="icon-btn" onClick={() => setSelected(new Set())} title="Quitar selección" aria-label="Quitar selección">
            <X size={14} />
          </button>
        </div>
      )}

      {res.containers.error && (
        <div className="ct-error ct-error-inline" role="alert">
          <pre>{res.containers.error}</pre>
          <button className="btn btn-sm" onClick={() => void ct.reload("containers")}>
            Reintentar
          </button>
        </div>
      )}

      <div className="ct-table-wrap">
        {res.containers.data === null && loading ? (
          <div className="empty-state">
            <span className="spinner" />
            <div>Leyendo contenedores…</div>
          </div>
        ) : list.length === 0 && res.containers.data !== null ? (
          <div className="empty-state">
            <div>No hay contenedores todavía</div>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => ct.openRunForm()}
              disabled={!ct.newOwner}
              title={ct.newOwner ? undefined : PICK_OWNER_HINT}
            >
              <Plus size={13} /> Crear el primero
            </button>
          </div>
        ) : (
          <table className="ct-table ct-table-containers">
            <thead>
              <tr>
                <th className="ct-col-chk">
                  <input
                    type="checkbox"
                    aria-label="Seleccionar todos"
                    checked={allChecked}
                    onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map(rowKey)))}
                  />
                </th>
                {th("name", "Nombre", "ct-col-name")}
                {ct.allOwners && th("owner", "Usuario", "ct-col-owner")}
                {th("image", "Imagen", "ct-col-image")}
                {th("state", "Estado", "ct-col-state")}
                <th className="ct-col-ports">Puertos</th>
                {th("created", "Creado", "ct-col-created")}
                {th("cpu", "CPU", "ct-col-num")}
                {th("mem", "Memoria", "ct-col-mem")}
                <th className="ct-col-actions">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const st = c.state === "running" ? statsFor(stats, c) : undefined;
                const k = rowKey(c);
                const isBusy = busy.has(k);
                return (
                  <tr
                    key={k}
                    tabIndex={0}
                    className={selected.has(k) ? "sel" : undefined}
                    onKeyDown={(e) => onRowKey(e, c)}
                    onContextMenu={(e) => openRowMenu(e, c)}
                    onDoubleClick={() => openLogs(c)}
                    aria-selected={selected.has(k)}
                  >
                    <td className="ct-col-chk">
                      <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(k)} aria-label={`Seleccionar ${c.name}`} tabIndex={-1} />
                    </td>
                    <td className="ct-col-name" title={`${c.name}\n${c.id}`}>
                      <span className="ct-cell-flex">
                        {isBusy ? <span className="spinner ct-spinner-xs" /> : <span className={`ct-dot ct-${stateTone(c.state)}`} />}
                        <span className="ct-ellipsis ct-strong">{c.name}</span>
                        {c.composeProject && (
                          <span className="ct-tag" title={`Proyecto Compose: ${c.composeProject}${c.composeService ? ` · servicio ${c.composeService}` : ""}`}>
                            {c.composeProject}
                          </span>
                        )}
                        {c.pod && <span className="ct-tag" title="Pod">pod {c.pod}</span>}
                      </span>
                    </td>
                    {ct.allOwners && <td className="ct-col-owner ct-ellipsis">{ct.ownerLabel(c.owner)}</td>}
                    <td className="ct-col-image ct-ellipsis mono" title={c.image}>
                      {c.image}
                    </td>
                    <td className="ct-col-state ct-ellipsis" title={c.status}>
                      {stateText(c)}
                    </td>
                    <td className="ct-col-ports">
                      <span className="ct-ports">
                        {c.ports.filter((p) => p.hostPort !== null).slice(0, 4).map((p, i) => (
                          <button key={i} className="ct-port" onClick={(e) => portMenu(e, p)} title="Copiar dirección o abrir túnel" tabIndex={-1}>
                            {portLabel(p)}
                          </button>
                        ))}
                        {c.ports.filter((p) => p.hostPort !== null).length > 4 && (
                          <span className="faint">+{c.ports.filter((p) => p.hostPort !== null).length - 4}</span>
                        )}
                      </span>
                    </td>
                    <td className="ct-col-created faint" title={c.created ? new Date(c.created * 1000).toLocaleString() : ""}>
                      {ago(c.created)}
                    </td>
                    <td className="ct-col-num mono">{st ? percent(st.cpuPercent) : ""}</td>
                    <td className="ct-col-mem mono" title={st?.memLimit ? `Límite: ${formatBytes(st.memLimit)}` : undefined}>
                      {st?.memUsage !== null && st?.memUsage !== undefined ? formatBytes(st.memUsage) : ""}
                    </td>
                    <td className="ct-col-actions">
                      <span className="ct-actions">
                        {isUp(c) ? (
                          <button className="icon-btn" title="Parar" aria-label={`Parar ${c.name}`} onClick={() => confirmAction("stop", [c])} disabled={isBusy} tabIndex={-1}>
                            <Square size={13} />
                          </button>
                        ) : (
                          <button
                            className="icon-btn ct-go"
                            title={c.state === "paused" ? "Reanudar" : "Iniciar"}
                            aria-label={`Iniciar ${c.name}`}
                            onClick={() => void direct(c.state === "paused" ? "unpause" : "start", [c])}
                            disabled={isBusy}
                            tabIndex={-1}
                          >
                            <Play size={13} />
                          </button>
                        )}
                        <button className="icon-btn" title="Logs" aria-label={`Logs de ${c.name}`} onClick={() => openLogs(c)} tabIndex={-1}>
                          <ScrollText size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          title="Terminal dentro del contenedor"
                          aria-label={`Terminal en ${c.name}`}
                          onClick={() => ct.toTerminal(withOwner(execShellCmd(engine, c.name || c.id), c.owner), true)}
                          disabled={c.state !== "running"}
                          tabIndex={-1}
                        >
                          <TerminalSquare size={13} />
                        </button>
                        <button className="icon-btn" title="Más acciones" aria-label={`Más acciones de ${c.name}`} onClick={(e) => openRowMenu(e, c)} tabIndex={-1}>
                          <MoreHorizontal size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={ct.allOwners ? 10 : 9} className="ct-norows">
                    Ningún contenedor coincide con el filtro
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="ct-foot faint">
        Enter: logs · Espacio: seleccionar · Supr: eliminar · Menú o Mayús+F10: más acciones
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
