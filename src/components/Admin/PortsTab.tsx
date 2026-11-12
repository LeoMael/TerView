// Sub-pestaña «Puertos»: puertos en escucha del servidor con su proceso, usuario y servicio o contenedor.
// Con root/sudo se ven los procesos de todos; sin privilegios, solo los propios (se avisa).
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Box, Copy, KeyRound, Play, RefreshCw, Search, ShieldAlert, X } from "lucide-react";
import { formatListen, matchPort, tunnelDestHost, WELL_KNOWN, type ListenPort } from "../../features/admin";
import { openLocalTunnel } from "../../features/tunnels/openLocal";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { useProfiles } from "../../stores/profiles";
import { useAdmin, type PortProtoFilter, type PortScopeFilter } from "./context";
import { VirtualTable, type Column } from "./VirtualTable";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Segmented } from "./Segmented";

function copy(text: string, what: string) {
  clipboard.write(text).then(
    () => toast.success(what, text),
    (e) => toast.error("No se pudo copiar", String(e)),
  );
}

function scopeTag(p: ListenPort) {
  if (p.scope === "public")
    return (
      <span
        className="adm-tag adm-tag-yellow"
        title="Escucha en todas las interfaces: se puede llegar desde fuera si el cortafuegos lo permite"
      >
        Expuesto
      </span>
    );
  if (p.scope === "local")
    return (
      <span className="adm-tag adm-tag-green" title="Solo se puede usar desde el propio servidor">
        Solo local
      </span>
    );
  return (
    <span className="adm-tag adm-tag-accent" title="Escucha solo en esta dirección del servidor">
      Una IP
    </span>
  );
}

/** Nombre del programa: «nginx (1200, 1201)». */
function procText(p: ListenPort): string {
  if (p.procs.length === 0) return "";
  const names = [...new Set(p.procs.map((x) => x.name))];
  return `${names.join(", ")} (${p.procs.map((x) => x.pid).join(", ")})`;
}

export function PortsTab() {
  const { ports, loadPorts, portsFilter, setPortsFilter, sessionId, profileId, disabled, elev, askSudo } = useAdmin();
  const serverHost = useProfiles((s) => s.servers.find((x) => x.id === profileId)?.host ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; port: ListenPort } | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const { query, scope, proto } = portsFilter;
  const all = useMemo(() => ports.data?.ports ?? [], [ports.data]);
  const elevated = ports.elevated;

  const rows = useMemo(
    () =>
      all.filter(
        (p) =>
          (proto === "all" || p.proto === proto) &&
          (scope === "all" || (scope === "local" ? p.scope === "local" : p.scope !== "local")) &&
          matchPort(p, query),
      ),
    [all, proto, scope, query],
  );
  const counts = useMemo(
    () => ({
      all: all.length,
      exposed: all.filter((p) => p.scope !== "local").length,
      local: all.filter((p) => p.scope === "local").length,
    }),
    [all],
  );
  const sel = rows.find((p) => p.key === selected) ?? null;

  /** Dirección útil para copiar: el servidor (si escucha en todas las interfaces) o la dirección exacta. */
  const usefulAddr = (p: ListenPort) =>
    p.scope === "public" && serverHost
      ? `${serverHost.includes(":") ? `[${serverHost}]` : serverHost}:${p.port}`
      : formatListen(p);

  const tunnel = (p: ListenPort) => {
    const name = p.procs[0]?.name ?? p.container ?? WELL_KNOWN[p.port] ?? "Puerto";
    void openLocalTunnel(sessionId, profileId, tunnelDestHost(p), p.port, `${name} :${p.port}`);
  };
  const tunnelBlock = (p: ListenPort) =>
    disabled ? "Sin conexión con el servidor" : p.proto !== "tcp" ? "Los túneles SSH solo sirven para TCP" : null;

  const menuItems = (p: ListenPort): MenuItem[] => [
    {
      label: "Abrir túnel a mi PC",
      icon: <Play size={13} />,
      onClick: () => tunnel(p),
      disabled: !!tunnelBlock(p),
      title: tunnelBlock(p) ?? "Crea un túnel SSH para usar este puerto desde tu PC",
    },
    { label: `Copiar ${usefulAddr(p)}`, icon: <Copy size={13} />, onClick: () => copy(usefulAddr(p), "Dirección copiada") },
    ...(usefulAddr(p) !== formatListen(p)
      ? [
          {
            label: `Copiar ${formatListen(p)}`,
            icon: <Copy size={13} />,
            onClick: () => copy(formatListen(p), "Dirección copiada"),
          },
        ]
      : []),
    ...(p.procs.length
      ? [
          {
            label: `Copiar PID ${p.procs[0].pid}`,
            icon: <Copy size={13} />,
            onClick: () => copy(String(p.procs[0].pid), "PID copiado"),
          },
        ]
      : []),
  ];

  const openMenuAtRow = (p: ListenPort) => {
    const row = paneRef.current?.querySelector<HTMLElement>(".adm-tr.sel");
    const r = row?.getBoundingClientRect();
    setMenu({ x: r ? r.left + 40 : 200, y: r ? r.bottom : 200, port: p });
  };

  const columns: Column<ListenPort>[] = [
    {
      key: "port",
      label: "Puerto",
      width: "100px",
      render: (p) => (
        <span className="adm-name">
          {p.port}
          <span className={`adm-proto adm-proto-${p.proto}`}>{p.proto.toUpperCase()}</span>
        </span>
      ),
    },
    {
      key: "addr",
      label: "Escucha en",
      width: "minmax(170px, 1.2fr)",
      render: (p) => (
        <span className="adm-cell-flex">
          <span className="mono adm-ellipsis">{formatListen(p)}</span>
          {scopeTag(p)}
        </span>
      ),
      title: (p) => `${formatListen(p)} · IPv${p.family}`,
    },
    {
      key: "proc",
      label: "Proceso (PID)",
      width: "minmax(140px, 1.2fr)",
      render: (p) =>
        p.procs.length ? (
          procText(p)
        ) : (
          <span
            className="faint"
            title={
              elevated
                ? "El sistema no indica el proceso (p. ej. un servicio del núcleo)"
                : "Sin root o sudo solo se ve el proceso de tus propios puertos"
            }
          >
            {elevated ? "—" : "— (sin permiso)"}
          </span>
        ),
      title: procText,
    },
    {
      key: "user",
      label: "Usuario",
      width: "minmax(80px, 0.7fr)",
      render: (p) => p.user ?? <span className="faint">—</span>,
      title: (p) => p.user ?? "",
    },
    {
      key: "svc",
      label: "Servicio",
      width: "minmax(130px, 1fr)",
      render: (p) =>
        p.container ? (
          <span className="adm-cell-flex" title={`Contenedor ${p.container}`}>
            <Box size={12} /> {p.container}
          </span>
        ) : p.unit ? (
          <span title={p.unit}>{p.unit.replace(/\.service$/, "")}</span>
        ) : WELL_KNOWN[p.port] ? (
          <span className="faint" title="Uso habitual de este puerto (no comprobado)">
            {WELL_KNOWN[p.port]}?
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: "act",
      label: "",
      width: "112px",
      render: (p) => (
        <span className="adm-cell-flex">
          <button
            className="btn btn-sm adm-row-btn"
            disabled={!!tunnelBlock(p)}
            title={tunnelBlock(p) ?? "Abrir un túnel SSH para usar este puerto desde tu PC"}
            onClick={(e) => {
              e.stopPropagation();
              tunnel(p);
            }}
          >
            <Play size={12} /> Túnel
          </button>
          <button
            className="icon-btn adm-row-btn"
            title={`Copiar ${usefulAddr(p)}`}
            aria-label={`Copiar dirección ${usefulAddr(p)}`}
            onClick={(e) => {
              e.stopPropagation();
              copy(usefulAddr(p), "Dirección copiada");
            }}
          >
            <Copy size={12} />
          </button>
        </span>
      ),
    },
  ];

  const setQuery = (q: string) => setPortsFilter({ ...portsFilter, query: q });

  if (ports.error && !ports.data) {
    return (
      <div className="empty-state">
        <ShieldAlert size={22} />
        <div>No se pudieron leer los puertos</div>
        <div className="faint adm-pre-wrap">{ports.error}</div>
        <button className="btn btn-sm" onClick={loadPorts} disabled={disabled}>
          <RefreshCw size={13} /> Reintentar
        </button>
      </div>
    );
  }
  if (!ports.data) {
    return (
      <div className="empty-state">
        <span className="spinner" />
        <div>Leyendo los puertos en escucha…</div>
      </div>
    );
  }
  if (ports.data.tool === "none") {
    return (
      <div className="empty-state">
        <ShieldAlert size={22} />
        <div>El servidor no tiene «ss» ni «netstat»</div>
        <div className="faint adm-pre-wrap">Instala el paquete iproute2 (o net-tools) para poder ver los puertos en escucha.</div>
      </div>
    );
  }

  return (
    <div className="adm-pane" ref={paneRef}>
      {!elevated && !disabled && (
        <div className="adm-banner adm-banner-warn" role="status">
          <ShieldAlert size={14} />
          <span className="adm-banner-text">
            {ports.elevationError ? `No se pudo usar sudo (${ports.elevationError}). ` : ""}
            Sin root ni sudo se ven todos los puertos, pero solo se sabe qué proceso usa los tuyos.
          </span>
          {elev.canAskSudo && (
            <button className="btn btn-sm" onClick={askSudo}>
              <KeyRound size={13} /> Ver todos con sudo
            </button>
          )}
        </div>
      )}
      <div className="adm-toolbar">
        <div className="adm-search adm-search-wide">
          <Search size={13} />
          <input
            className="input"
            placeholder="Puerto, proceso, usuario o servicio (:80 = puerto exacto)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            aria-label="Buscar puertos"
          />
          {query && (
            <button className="icon-btn adm-search-clear" onClick={() => setQuery("")} aria-label="Limpiar búsqueda">
              <X size={12} />
            </button>
          )}
        </div>
        <Segmented<PortScopeFilter>
          label="Alcance"
          value={scope}
          onChange={(v) => setPortsFilter({ ...portsFilter, scope: v })}
          options={[
            {
              value: "all",
              label: (
                <>
                  Todos <span className="adm-seg-n">{counts.all}</span>
                </>
              ),
            },
            {
              value: "exposed",
              label: (
                <>
                  Expuestos <span className="adm-seg-n">{counts.exposed}</span>
                </>
              ),
              title: "Escuchan en todas las interfaces (0.0.0.0, ::) o en una IP de la red",
            },
            {
              value: "local",
              label: (
                <>
                  Solo locales <span className="adm-seg-n">{counts.local}</span>
                </>
              ),
              title: "Solo se pueden usar desde el propio servidor (127.0.0.1, ::1)",
            },
          ]}
        />
        <Segmented<PortProtoFilter>
          label="Protocolo"
          value={proto}
          onChange={(v) => setPortsFilter({ ...portsFilter, proto: v })}
          options={[
            { value: "all", label: "TCP y UDP" },
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
          ]}
        />
      </div>
      <VirtualTable
        label="Puertos en escucha"
        columns={columns}
        rows={rows}
        rowKey={(p) => p.key}
        selected={sel ? sel.key : null}
        onSelect={setSelected}
        onActivate={openMenuAtRow}
        onContextMenu={(e: MouseEvent, p) => setMenu({ x: e.clientX, y: e.clientY, port: p })}
        onKey={(e: KeyboardEvent, p) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            openMenuAtRow(p);
          }
        }}
        placeholder={
          <div className="adm-empty-text">
            {all.length === 0 ? "No hay puertos en escucha." : "Ningún puerto coincide con los filtros."}
            {all.length > 0 && (query || scope !== "all" || proto !== "all") && (
              <div>
                <button className="btn btn-sm" onClick={() => setPortsFilter({ query: "", scope: "all", proto: "all" })}>
                  Quitar filtros
                </button>
              </div>
            )}
          </div>
        }
      />
      <div className="adm-statusbar">
        {rows.length === all.length ? `${all.length} puertos` : `${rows.length} de ${all.length} puertos`}
        <span className="faint">·</span>
        <span>
          leídos con {ports.data.tool} {elevated ? "como root" : "sin privilegios"}
        </span>
        {ports.loading && <span className="spinner adm-spinner-btn" aria-label="Actualizando" />}
        <span className="adm-spacer" />
        <span className="faint">Enter o clic derecho: más acciones</span>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.port)} onClose={() => setMenu(null)} />}
    </div>
  );
}
