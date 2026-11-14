// Mapa de infraestructura: de lo leído en cada servidor (puertos, sitios web, contenedores, conexiones)
// a un grafo de nodos y aristas, como un diagrama de arquitectura. Funciones puras.
import type { ListenPort, PortsResult } from "../admin/ports";
import { WELL_KNOWN } from "../admin/ports";
import { certStatus, type Site, type WebResult } from "../admin/web";
import type { Container, Engine } from "../containers/types";
import type { InfraExtra } from "./parse";

/** Dueño de lo que corre como root o como usuarios del sistema (www-data, postgres…). */
export const SYSTEM_OWNER = "sistema";

export interface OwnedContainer extends Container {
  engine: Engine;
  /** Usuario dueño para el mapa (SYSTEM_OWNER = root o el demonio de Docker). */
  user: string;
}

/** Lo leído en un servidor. */
export interface ServerSnapshot {
  /** id del perfil. */
  id: string;
  name: string;
  /** Host o IP del perfil. */
  host: string;
  sessionId: string | null;
  /** null = sin leer (no conectado). */
  error: string | null;
  offline?: boolean;
  /** Se leyó con root/sudo (se ven los procesos y contenedores de todos los usuarios). */
  elevated: boolean;
  /** Usuario conectado. */
  me: string | null;
  ports: PortsResult | null;
  web: WebResult | null;
  containers: OwnedContainer[];
  extra: InfraExtra | null;
  /** Servicios `systemctl --user` en marcha por usuario. */
  userServices: Record<string, string[]>;
  /** Avisos cortos de la lectura. */
  notes: string[];
}

export type NodeKind =
  | "internet"
  | "firewall"
  | "port"
  | "proxy"
  | "site"
  | "container"
  | "service"
  | "process"
  | "db"
  | "system"
  | "external";

export type Health = "ok" | "warn" | "bad" | "off";

/** Adónde lleva «Ir a…» desde el panel de detalles. */
export type NavTarget =
  | { kind: "ports"; port: number }
  | { kind: "web" }
  | { kind: "containers"; name: string };

export interface MapNode {
  id: string;
  /** Servidor (id del perfil); null = Internet. */
  server: string | null;
  owner: string | null;
  kind: NodeKind;
  /** Columna: 0 Internet · 1 cortafuegos · 2 puertos · 3 proxy · 4 sitios · 5 apps · 6 datos. */
  layer: number;
  label: string;
  sub: string;
  health: Health;
  /** Proyecto de Compose o pod. */
  group: string | null;
  /** Solo escucha en local (o no escucha). */
  localOnly: boolean;
  details: [string, string][];
  nav: NavTarget | null;
}

export type EdgeKind = "net" | "proxy" | "publish" | "cross";

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: EdgeKind;
}

export interface MapServer {
  id: string;
  name: string;
  os: string | null;
  host: string;
  health: Health;
  owners: string[];
  elevated: boolean;
  notes: string[];
  firewall: string | null;
}

export interface InfraGraph {
  servers: MapServer[];
  nodes: MapNode[];
  edges: MapEdge[];
}

export const LAYERS = ["Internet", "Cortafuegos", "Entrada", "Proxy", "Sitios", "Apps", "Datos"];

const DB_RE = /postgres|mysqld|mariadb|mongod|mongo|redis|valkey|memcached|elasticsearch|opensearch|clickhouse|rabbitmq|beam\.smp|influxd|cassandra|cockroach|etcd|keydb|minio/i;
const PROXY_RE = /^(nginx|caddy|apache2?|httpd|traefik|haproxy|envoy|lighttpd)$/i;
const PROXY_IMG_RE = /(^|\/)(nginx|caddy|traefik|haproxy|httpd|envoy)(:|$|-)/i;
const SYSTEM_RE =
  /^(sshd|systemd.*|chronyd|ntpd|cupsd|cups-browsed|rpcbind|rpc\.\w+|avahi-daemon|dnsmasq|master|exim4?|postfix|dhclient|NetworkManager|containerd|dockerd|cockpit.*|smbd|nmbd|rsyslogd|sssd|zabbix_agentd|node_exporter|tailscaled|xrdp.*|colord|snapd)$/;
/** Procesos que solo reenvían el puerto publicado de un contenedor. */
const PLUMBING_RE = /^(rootlessport|rootlesskit|docker-proxy|conmon|pasta|pasta\.avx2|slirp4netns|podman)$/;
const DB_PORTS = new Set([5432, 3306, 6379, 27017, 11211, 9200, 5672, 9042, 26257, 8086, 6380, 2379, 9000]);

function isLocalHost(h: string | null): boolean {
  if (!h) return true;
  const x = h.toLowerCase().replace(/^\[|\]$/g, "");
  return x === "localhost" || x.startsWith("127.") || x === "::1" || x === "0.0.0.0" || x === "::" || x === "*";
}

function healthOfContainer(c: Container): Health {
  if (c.state === "running") return c.health === "unhealthy" ? "bad" : c.health === "starting" ? "warn" : "ok";
  if (c.state === "restarting" || c.state === "paused") return "warn";
  if (c.state === "exited" && c.exitCode !== null && c.exitCode !== 0) return "bad";
  return "off";
}

function portText(p: { port: number; proto: string }): string {
  return p.proto === "udp" ? `${p.port}/udp` : `:${p.port}`;
}

interface Listener {
  node: MapNode;
  pids: Set<number>;
  procName: string | null;
  ports: ListenPort[];
}

/** Dueño de un proceso para el mapa: personas (uid ≥ 1000) con su nombre; el resto, «sistema». */
export function ownerFor(user: string | null, snap: Pick<ServerSnapshot, "me" | "extra">): string {
  if (!user || user === "root") return SYSTEM_OWNER;
  const humans = snap.extra?.humans;
  if (humans && humans.size > 0) return humans.has(user) ? user : SYSTEM_OWNER;
  return user === snap.me ? user : SYSTEM_OWNER;
}

/** Busca el contenedor de un puerto: por nombre/id (cgroup) o por el puerto publicado. */
function containerFor(p: ListenPort, cs: OwnedContainer[]): OwnedContainer | null {
  if (p.container) {
    const k = p.container;
    const byName = cs.find((c) => c.name === k || c.id.startsWith(k) || k.startsWith(c.shortId));
    if (byName) return byName;
  }
  const pub = cs.filter((c) => c.ports.some((m) => m.hostPort !== null && p.port >= m.hostPort && p.port < m.hostPort + Math.max(1, m.range) && m.protocol === p.proto));
  if (pub.length === 0) return null;
  // Con varios usuarios, el del mismo dueño que el proceso que escucha.
  return pub.find((c) => c.user === p.user) ?? pub.find((c) => c.state === "running") ?? pub[0];
}

function classify(name: string, port: number | null): NodeKind {
  if (PROXY_RE.test(name)) return "proxy";
  if (DB_RE.test(name)) return "db";
  if (SYSTEM_RE.test(name) || /^systemd-/.test(name)) return "system";
  if (port !== null && DB_PORTS.has(port) && !name) return "db";
  return "process";
}

/** Construye el grafo de uno o varios servidores (los de un proyecto en un mismo lienzo). */
export function buildGraph(snaps: ServerSnapshot[], now = Date.now()): InfraGraph {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const servers: MapServer[] = [];
  const pendingUpstreams: PendingUpstream[] = [];
  const add = (n: MapNode) => {
    const ex = nodes.get(n.id);
    if (ex) return ex;
    nodes.set(n.id, n);
    return n;
  };
  const edge = (from: string, to: string, label: string, kind: EdgeKind) => {
    if (from === to) return;
    const id = `${from}>${to}>${label}`;
    if (!edges.has(id)) edges.set(id, { id, from, to, label, kind });
  };
  const internet: MapNode = {
    id: "internet",
    server: null,
    owner: null,
    kind: "internet",
    layer: 0,
    label: "Internet",
    sub: "",
    health: "ok",
    group: null,
    localOnly: false,
    details: [],
    nav: null,
  };

  // Por servidor: puerto → quien escucha (para resolver upstreams y conexiones de otros servidores).
  const byPort = new Map<string, Map<number, Listener>>();
  const allListeners = new Map<string, Listener[]>();

  for (const s of snaps) {
    const sid = s.id;
    const srv: MapServer = {
      id: sid,
      name: s.name,
      os: s.extra?.os ?? null,
      host: s.host,
      health: s.offline ? "off" : s.error ? "bad" : "ok",
      owners: [],
      elevated: s.elevated,
      notes: [...s.notes],
      firewall: null,
    };
    servers.push(srv);
    const owners = new Set<string>();
    const listeners: Listener[] = [];
    const portMap = new Map<number, Listener>();
    byPort.set(sid, portMap);
    allListeners.set(sid, listeners);
    const nid = (x: string) => `${sid}|${x}`;

    // Cortafuegos activo: Internet → cortafuegos → puertos.
    const fw = s.extra?.firewall.find((f) => f.active) ?? null;
    if (s.extra?.firewall.length) srv.firewall = s.extra.firewall.map((f) => `${f.tool} ${f.state}`).join(" · ");
    let entry = internet.id;
    if (fw) {
      const n = add({
        id: nid("fw"),
        server: sid,
        owner: SYSTEM_OWNER,
        kind: "firewall",
        layer: 1,
        label: fw.tool,
        sub: fw.state,
        health: "ok",
        group: null,
        localOnly: false,
        details: [["Cortafuegos", fw.tool], ["Estado", fw.state]],
        nav: null,
      });
      edge(internet.id, n.id, "", "net");
      entry = n.id;
    }

    // Contenedores.
    const ctrNode = new Map<OwnedContainer, MapNode>();
    for (const c of s.containers) {
      const db = DB_RE.test(c.image) || DB_RE.test(c.name);
      const proxy = PROXY_IMG_RE.test(c.image);
      const pubs = c.ports.filter((m) => m.hostPort !== null).map((m) => `${m.hostIp ? `${m.hostIp}:` : ""}${m.hostPort}→${m.containerPort}/${m.protocol}`);
      const n = add({
        id: nid(`ctr:${c.user}:${c.name}`),
        server: sid,
        owner: c.user,
        kind: db ? "db" : "container",
        layer: db ? 6 : proxy ? 3 : 5,
        label: c.name,
        sub: c.image.replace(/^(docker\.io|quay\.io|ghcr\.io)\//, "").replace(/^library\//, ""),
        health: healthOfContainer(c),
        group: c.pod ?? c.composeProject,
        localOnly: true,
        details: [
          ["Contenedor", `${c.name} (${c.engine})`],
          ["Imagen", c.image],
          ["Estado", c.status || c.state],
          ...(pubs.length ? [["Puertos", pubs.join(", ")] as [string, string]] : []),
          ...(c.networks.length ? [["Red", c.networks.join(", ")] as [string, string]] : []),
          ...(c.composeProject ? [["Compose", `${c.composeProject}${c.composeService ? ` · ${c.composeService}` : ""}`] as [string, string]] : []),
          ...(c.pod ? [["Pod", c.pod] as [string, string]] : []),
          ["Usuario", c.user],
        ],
        nav: { kind: "containers", name: c.name },
      });
      if (db) n.kind = "db";
      ctrNode.set(c, n);
      owners.add(c.user);
    }

    // Quién escucha cada puerto.
    const seen = new Set<string>();
    for (const p of s.ports?.ports ?? []) {
      const owner = ownerFor(p.user, s);
      const proc = p.procs[0]?.name ?? null;
      const ctr = containerFor(p, s.containers);
      let n: MapNode;
      if (ctr && (!proc || PLUMBING_RE.test(proc) || p.container)) {
        n = ctrNode.get(ctr)!;
      } else if (p.unit) {
        const unitOwner = owner;
        const name = proc ?? p.unit.replace(/\.service$/, "");
        const kind = classify(name, p.port);
        n = add({
          id: nid(`svc:${unitOwner}:${p.unit}`),
          server: sid,
          owner: unitOwner,
          kind: kind === "process" ? "service" : kind,
          layer: kind === "proxy" ? 3 : kind === "db" ? 6 : 5,
          label: p.unit.replace(/\.service$/, ""),
          sub: proc && proc !== p.unit.replace(/\.service$/, "") ? proc : "systemd",
          health: "ok",
          group: null,
          localOnly: true,
          details: [["Servicio", p.unit], ...(proc ? [["Proceso", proc] as [string, string]] : []), ["Usuario", p.user ?? "?"]],
          nav: { kind: "ports", port: p.port },
        });
      } else {
        const name = proc ?? "";
        const kind = classify(name, p.port);
        const label = proc ?? WELL_KNOWN[p.port] ?? "¿?";
        n = add({
          id: nid(proc ? `proc:${owner}:${proc}` : `proc:?:${p.proto}:${p.port}`),
          server: sid,
          owner: proc ? owner : SYSTEM_OWNER,
          kind,
          layer: kind === "proxy" ? 3 : kind === "db" ? 6 : 5,
          label,
          sub: proc ? "proceso" : "sin permiso para ver el proceso",
          health: proc ? "ok" : "warn",
          group: null,
          localOnly: true,
          details: [["Proceso", proc ?? "?"], ["Usuario", p.user ?? "?"]],
          nav: { kind: "ports", port: p.port },
        });
      }
      owners.add(n.owner ?? SYSTEM_OWNER);
      let l = listeners.find((x) => x.node === n);
      if (!l) {
        l = { node: n, pids: new Set(), procName: proc, ports: [] };
        listeners.push(l);
      }
      for (const pp of p.procs) l.pids.add(pp.pid);
      l.ports.push(p);
      if (p.proto === "tcp" && !portMap.has(p.port)) portMap.set(p.port, l);

      const exposed = p.scope !== "local";
      const key = `${p.proto}:${p.port}:${exposed ? "x" : "l"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!exposed) continue;
      n.localOnly = false;
      const service = WELL_KNOWN[p.port];
      const pn = add({
        id: nid(`port:${p.proto}:${p.port}`),
        server: sid,
        owner: n.owner,
        kind: "port",
        layer: 2,
        label: portText(p),
        sub: service ?? p.proto.toUpperCase(),
        health: "ok",
        group: null,
        localOnly: false,
        details: [["Puerto", `${p.port}/${p.proto}`], ["Escucha en", p.ip === "*" ? "todas" : p.ip], ...(service ? [["Servicio", service] as [string, string]] : [])],
        nav: { kind: "ports", port: p.port },
      });
      edge(entry, pn.id, "", "net");
      const m = n.kind === "container" || n.kind === "db" ? ctr?.ports.find((x) => x.hostPort === p.port) : null;
      edge(pn.id, n.id, m ? `→${m.containerPort}` : "", m ? "publish" : "net");
    }
    // Puertos de cada nodo en sus detalles.
    for (const l of listeners) {
      const list = [...new Set(l.ports.map((p) => `${p.scope === "local" ? "local " : ""}${portText(p)}`))];
      l.node.details.push(["Escucha", list.join(", ")]);
      if (l.node.sub === "proceso" || l.node.sub === "systemd") l.node.sub = list.slice(0, 3).join(" ");
    }

    // Servicios de usuario (systemctl --user).
    for (const [user, units] of Object.entries(s.userServices)) {
      for (const u of units) {
        const id = nid(`svc:${user}:${u}`);
        if (nodes.has(id)) continue;
        add({
          id,
          server: sid,
          owner: user,
          kind: "service",
          layer: 5,
          label: u.replace(/\.service$/, ""),
          sub: "systemctl --user",
          health: "ok",
          group: null,
          localOnly: true,
          details: [["Servicio de usuario", u], ["Usuario", user]],
          nav: null,
        });
        owners.add(user);
      }
    }

    // Proxy web y sitios.
    for (const w of s.web?.servers ?? []) {
      const l = listeners.find((x) => x.procName && x.procName.toLowerCase().startsWith(w.server));
      const health: Health = w.status === "failed" ? "bad" : w.status === "inactive" ? "off" : w.warning ? "warn" : "ok";
      let pn: MapNode;
      if (l) {
        pn = l.node;
        pn.kind = "proxy";
        pn.layer = 3;
        pn.health = health;
      } else {
        pn = add({
          id: nid(`proxy:${w.server}`),
          server: sid,
          owner: SYSTEM_OWNER,
          kind: "proxy",
          layer: 3,
          label: w.server,
          sub: w.status ?? "",
          health,
          group: null,
          localOnly: true,
          details: [],
          nav: { kind: "web" },
        });
        owners.add(SYSTEM_OWNER);
      }
      pn.details.push(["Proxy web", `${w.server}${w.status ? ` (${w.status})` : ""}`], ["Configuración", w.configPath]);
      pn.nav = { kind: "web" };
      for (const site of w.sites) {
        const sn = siteNode(site, sid, pn.owner ?? SYSTEM_OWNER, now);
        add(sn);
        edge(pn.id, sn.id, "", "proxy");
        for (const r of site.routes) {
          const t = r.target;
          if (t.kind !== "proxy" && t.kind !== "fastcgi") continue;
          const socket = t.kind === "proxy" ? t.socket : null;
          const label = `${r.path !== "/" ? `${r.path} ` : ""}${t.port ? `:${t.port}` : socket ? "unix" : ""}`.trim();
          pendingUpstreams.push({ sid, from: sn.id, host: t.host, port: t.port, socket, label, owner: pn.owner ?? SYSTEM_OWNER, url: t.kind === "proxy" ? t.url : t.addr });
        }
      }
    }
    srv.owners = sortOwners([...owners], s.me);
  }

  // Upstreams (necesitan los puertos de todos los servidores).
  const findServer = (host: string | null, from: string): ServerSnapshot | null => {
    if (!host || isLocalHost(host)) return null;
    const h = host.toLowerCase();
    return snaps.find((x) => x.id !== from && (x.host.toLowerCase() === h || x.name.toLowerCase() === h || x.extra?.hostname?.toLowerCase() === h || x.extra?.addrs.includes(host))) ?? null;
  };
  for (const u of pendingUpstreams) {
    const snap = snaps.find((x) => x.id === u.sid)!;
    const self = isLocalHost(u.host) || snap.extra?.addrs.includes(u.host ?? "") || snap.extra?.hostname === u.host;
    let target: MapNode | null = null;
    let kind: EdgeKind = "proxy";
    if (u.socket) {
      target = add({
        id: `${u.sid}|sock:${u.socket}`,
        server: u.sid,
        owner: u.owner,
        kind: "process",
        layer: 5,
        label: u.socket.split("/").pop() ?? u.socket,
        sub: "socket unix",
        health: "ok",
        group: null,
        localOnly: true,
        details: [["Socket", u.socket]],
        nav: null,
      });
    } else if (self && u.port !== null) {
      target = byPort.get(u.sid)?.get(u.port)?.node ?? null;
    } else if (u.host && u.port !== null) {
      const ctr = snap.containers.find((c) => c.name === u.host || c.composeService === u.host);
      const other = findServer(u.host, u.sid);
      if (ctr) target = nodes.get(`${u.sid}|ctr:${ctr.user}:${ctr.name}`) ?? null;
      else if (other) {
        target = byPort.get(other.id)?.get(u.port)?.node ?? null;
        kind = "cross";
      }
    }
    if (!target) {
      const host = u.host ?? "localhost";
      target = add({
        id: `${u.sid}|ext:${host}:${u.port ?? ""}`,
        server: u.sid,
        owner: u.owner,
        kind: "external",
        layer: 6,
        label: `${host}${u.port ? `:${u.port}` : ""}`,
        sub: self ? "nada escucha aquí" : "destino externo",
        health: self ? "bad" : "ok",
        group: null,
        localOnly: true,
        details: [["Destino", u.url]],
        nav: null,
      });
    }
    edge(u.from, target.id, u.label, kind);
  }

  // Conexiones establecidas entre servidores del proyecto (p. ej. la app de web-prod → postgres de db-01).
  for (const s of snaps) {
    const mine = byPort.get(s.id)!;
    for (const c of s.extra?.established ?? []) {
      if (mine.has(c.localPort)) continue; // entrante
      const other = snaps.find((x) => x.id !== s.id && (x.extra?.addrs.includes(c.peerIp) || x.host === c.peerIp));
      if (!other) continue;
      const target = byPort.get(other.id)?.get(c.peerPort)?.node;
      if (!target) continue;
      const ls = allListeners.get(s.id)!;
      const src = (c.pid !== null ? ls.find((l) => l.pids.has(c.pid!)) : undefined) ?? (c.proc ? ls.find((l) => l.procName === c.proc) : undefined);
      let node = src?.node;
      if (!node) {
        const owner = SYSTEM_OWNER;
        node = add({
          id: `${s.id}|cli:${c.proc ?? "?"}`,
          server: s.id,
          owner,
          kind: "process",
          layer: 5,
          label: c.proc ?? "conexión saliente",
          sub: "cliente",
          health: "ok",
          group: null,
          localOnly: true,
          details: [["Proceso", c.proc ?? "? (con sudo se ve cuál)"]],
          nav: null,
        });
        const srv = servers.find((x) => x.id === s.id)!;
        if (!srv.owners.includes(owner)) srv.owners = sortOwners([...srv.owners, owner], s.me);
      }
      edge(node.id, target.id, `:${c.peerPort}`, "cross");
    }
  }

  // Estado del servidor: aviso si algo está caído.
  for (const srv of servers) {
    if (srv.health !== "ok") continue;
    if ([...nodes.values()].some((n) => n.server === srv.id && n.health === "bad")) srv.health = "warn";
  }

  const list = [...nodes.values()];
  if (list.length > 0 || servers.length > 0) list.unshift(internet);
  // Internet solo si hay algo expuesto.
  const es = [...edges.values()];
  const out = es.some((e) => e.from === internet.id) ? list : list.filter((n) => n !== internet);
  return { servers, nodes: out, edges: es };
}

interface PendingUpstream {
  sid: string;
  from: string;
  host: string | null;
  port: number | null;
  socket: string | null;
  label: string;
  owner: string;
  url: string;
}
function siteNode(site: Site, sid: string, owner: string, now: number): MapNode {
  const cert = site.https ? certStatus(site.certExpires, now) : null;
  const name = site.names[0] ?? (site.isDefault ? "(por defecto)" : "(sin nombre)");
  const more = site.names.length > 1 ? ` +${site.names.length - 1}` : "";
  return {
    id: `${sid}|site:${site.key}`,
    server: sid,
    owner,
    kind: "site",
    layer: 4,
    label: name + more,
    sub: site.https ? (cert ? `TLS · ${cert.text.replace(/^caduca en /, "")}` : "TLS") : "HTTP",
    health: cert ? cert.level : "ok",
    group: null,
    localOnly: false,
    details: [
      ["Dominios", site.names.join(", ") || "cualquiera"],
      ["Escucha", site.listens.map((l) => `${l.port}${l.https ? " HTTPS" : ""}`).join(", ")],
      ...(site.https ? [["Certificado", cert?.text ?? "sin leer"] as [string, string]] : []),
      ...site.routes.map((r) => [r.path, routeText(r.target)] as [string, string]),
      ...(site.file ? [["Archivo", `${site.file}${site.line ? `:${site.line}` : ""}`] as [string, string]] : []),
    ],
    nav: { kind: "web" },
  };
}

function routeText(t: Site["routes"][number]["target"]): string {
  switch (t.kind) {
    case "proxy":
      return `→ ${t.url}`;
    case "fastcgi":
      return `fastcgi ${t.addr}`;
    case "files":
      return `archivos ${t.root}`;
    case "redirect":
      return `redirige ${t.to}`;
    default:
      return t.text;
  }
}

/** «sistema» primero, luego el usuario conectado y el resto por orden alfabético. */
export function sortOwners(owners: string[], me: string | null): string[] {
  const rank = (o: string) => (o === SYSTEM_OWNER ? 0 : o === me ? 1 : 2);
  return [...new Set(owners)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface GraphFilter {
  hideLocal: boolean;
  hideSystem: boolean;
  /** null = todos. */
  owners: Set<string> | null;
}

/** Aplica los filtros: quita nodos y las aristas que se quedan sin uno de sus extremos. */
export function filterGraph(g: InfraGraph, f: GraphFilter): InfraGraph {
  const linked = new Set<string>();
  for (const e of g.edges) if (e.kind !== "net") (linked.add(e.from), linked.add(e.to));
  let keep = g.nodes.filter((n) => {
    if (n.kind === "internet") return true;
    if (f.owners && n.owner && !f.owners.has(n.owner)) return false;
    if (f.hideSystem && n.kind === "system") return false;
    if (f.hideLocal && n.localOnly && !linked.has(n.id) && n.kind !== "proxy") return false;
    return true;
  });
  let ids = new Set(keep.map((n) => n.id));
  let edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  // Puertos (y cortafuegos) que se quedan sin nadie detrás.
  const outgoing = new Set(edges.map((e) => e.from));
  keep = keep.filter((n) => (n.kind !== "port" && n.kind !== "firewall") || outgoing.has(n.id));
  ids = new Set(keep.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const used = new Set(edges.map((e) => e.from));
  if (!used.has("internet")) keep = keep.filter((n) => n.kind !== "internet");
  const servers = g.servers.map((s) => ({ ...s, owners: f.owners ? s.owners.filter((o) => f.owners!.has(o)) : s.owners }));
  return { servers, nodes: keep, edges };
}

/** Todos los usuarios que aparecen en el grafo. */
export function graphOwners(g: InfraGraph): string[] {
  const all = g.servers.flatMap((s) => s.owners);
  return sortOwners(all, null);
}
