// Puertos en escucha del servidor (TCP/UDP) con su proceso, usuario, servicio systemd o contenedor.
// Funciones puras: script de lectura y parseo de `ss -tulpn` o, si no hay ss, `netstat -tulpn`.
import { splitSections } from "./parse";

/**
 * Script de lectura. Con root/sudo `ss -p` muestra el proceso de todos los puertos; sin privilegios,
 * solo el de los propios. Secciones: @@tool (ss|netstat|none), @@listen, @@procs («pid|usuario|cgroup»),
 * @@ctr («id nombre» de Podman/Docker).
 */
export const PORTS_SCRIPT = [
  // En Debian/Ubuntu /usr/sbin no está en el PATH de los usuarios normales.
  "PATH=$PATH:/usr/sbin:/sbin:/usr/local/sbin",
  "if command -v ss >/dev/null 2>&1; then T=ss; L=$(ss -tulpn 2>/dev/null)",
  "elif command -v netstat >/dev/null 2>&1; then T=netstat; L=$(netstat -tulpn 2>/dev/null)",
  "else T=none; L=''; fi",
  "echo @@tool; echo $T",
  "echo @@listen; printf '%s\\n' \"$L\"",
  "echo @@procs",
  // pid=123 (ss) o « 123/nginx» (netstat).
  "for p in $(printf '%s\\n' \"$L\" | grep -oE 'pid=[0-9]+|[[:space:]][0-9]+/' | tr -dc '0-9\\n' | sort -un); do",
  "  u=$(stat -c %U /proc/$p 2>/dev/null)",
  "  c=$(grep -oE '[^/]+\\.(service|scope)' /proc/$p/cgroup 2>/dev/null | tail -n1)",
  '  echo "$p|$u|$c"',
  "done",
  "echo @@ctr",
  "TO=''; command -v timeout >/dev/null 2>&1 && TO='timeout 5'",
  "for t in podman docker; do command -v $t >/dev/null 2>&1 && $TO $t ps --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null; done",
  "echo @@end",
].join("\n");

export type PortProto = "tcp" | "udp";
/** public = todas las interfaces (0.0.0.0, ::, *) · local = solo esta máquina · ip = una dirección concreta. */
export type PortScope = "public" | "local" | "ip";

export interface PortProc {
  name: string;
  pid: number;
}

export interface ListenPort {
  key: string;
  proto: PortProto;
  /** Dirección tal cual (sin corchetes ni %interfaz): 0.0.0.0, ::, *, 127.0.0.1… */
  ip: string;
  /** Interfaz si la dirección la lleva (127.0.0.53%lo → lo). */
  iface: string | null;
  port: number;
  family: 4 | 6;
  scope: PortScope;
  procs: PortProc[];
  /** Dueño del primer proceso (null si no se pudo ver). */
  user: string | null;
  /** Servicio systemd (nginx.service). */
  unit: string | null;
  /** Nombre del contenedor (o id corto si no se encontró el nombre). */
  container: string | null;
}

export interface PortsResult {
  tool: "ss" | "netstat" | "none";
  ports: ListenPort[];
}

/** Servicios habituales por puerto, solo como pista cuando no se sabe el proceso. */
export const WELL_KNOWN: Record<number, string> = {
  21: "FTP",
  22: "SSH",
  25: "SMTP",
  53: "DNS",
  80: "HTTP",
  110: "POP3",
  111: "rpcbind",
  123: "NTP",
  143: "IMAP",
  443: "HTTPS",
  465: "SMTPS",
  587: "SMTP (envío)",
  631: "Impresión (CUPS)",
  993: "IMAPS",
  995: "POP3S",
  2019: "Caddy (admin)",
  2049: "NFS",
  3000: "App web (Node, Grafana…)",
  3306: "MySQL / MariaDB",
  5353: "mDNS",
  5432: "PostgreSQL",
  5672: "RabbitMQ",
  6379: "Redis",
  8080: "HTTP alternativo",
  8443: "HTTPS alternativo",
  9000: "PHP-FPM / Portainer",
  9090: "Cockpit / Prometheus",
  9100: "Node exporter",
  9200: "Elasticsearch",
  11211: "Memcached",
  27017: "MongoDB",
};

function isLoopback(ip: string): boolean {
  return ip.startsWith("127.") || ip === "::1" || ip.toLowerCase().startsWith("::ffff:127.") || ip === "localhost";
}

/** Separa «dirección:puerto» en sus partes (IPv6 con o sin corchetes, «%interfaz», «*»). */
export function parseAddr(s: string): { ip: string; iface: string | null; port: number } | null {
  const i = s.lastIndexOf(":");
  if (i <= 0) return null;
  const portStr = s.slice(i + 1);
  if (!/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (port < 1 || port > 65535) return null;
  let host = s.slice(0, i);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  let iface: string | null = null;
  const pct = host.indexOf("%");
  if (pct >= 0) {
    iface = host.slice(pct + 1) || null;
    host = host.slice(0, pct);
  }
  return { ip: host || "*", iface, port };
}

export function scopeOf(ip: string): PortScope {
  if (ip === "0.0.0.0" || ip === "::" || ip === "*") return "public";
  if (isLoopback(ip)) return "local";
  return "ip";
}

interface RawListen {
  proto: PortProto;
  family: 4 | 6;
  addr: string;
  procs: PortProc[];
}

function protoOf(s: string): { proto: PortProto; v6: boolean } | null {
  const m = /^(tcp|udp)(6)?$/.exec(s.toLowerCase());
  return m ? { proto: m[1] as PortProto, v6: !!m[2] } : null;
}

/** `ss -tulpn` (con o sin cabecera). */
export function parseSs(lines: string[]): RawListen[] {
  const out: RawListen[] = [];
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] === "Netid" || f[0] === "State") continue;
    const p = protoOf(f[0]);
    if (!p) continue;
    // tcp: LISTEN; udp: UNCONN (enlazado, sin conexión).
    if (p.proto === "tcp" && f[1] !== "LISTEN") continue;
    const addr = f[4];
    const procs: PortProc[] = [];
    for (const m of line.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)) {
      const pid = Number(m[2]);
      if (!procs.some((x) => x.pid === pid)) procs.push({ name: m[1], pid });
    }
    out.push({ proto: p.proto, family: addr.includes("[") || (addr.match(/:/g)?.length ?? 0) > 1 ? 6 : 4, addr, procs });
  }
  return out;
}

/** `netstat -tulpn` (net-tools o busybox). */
export function parseNetstat(lines: string[]): RawListen[] {
  const out: RawListen[] = [];
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const p = protoOf(f[0]);
    if (!p) continue;
    if (p.proto === "tcp" && !f.includes("LISTEN")) continue;
    const addr = f[3];
    const procs: PortProc[] = [];
    const m = /(?:^|\s)(\d+)\/(\S+)/.exec(f.slice(5).join(" "));
    if (m) procs.push({ pid: Number(m[1]), name: m[2].replace(/:$/, "") });
    out.push({ proto: p.proto, family: p.v6 || (addr.match(/:/g)?.length ?? 0) > 1 ? 6 : 4, addr, procs });
  }
  return out;
}

export interface ProcInfo {
  user: string | null;
  unit: string | null;
  /** Id (largo o corto) del contenedor al que pertenece. */
  containerId: string | null;
}

/** «pid|usuario|cgroup» → datos del proceso. */
export function parseProcs(lines: string[]): Map<number, ProcInfo> {
  const out = new Map<number, ProcInfo>();
  for (const line of lines) {
    const [pidS, user = "", cg = ""] = line.split("|");
    if (!/^\d+$/.test(pidS)) continue;
    let unit: string | null = null;
    let containerId: string | null = null;
    const c = /^(?:libpod|docker|crio|cri-containerd)-(?:conmon-)?([0-9a-f]{12,64})\.scope$/.exec(cg);
    if (c) containerId = c[1];
    // user@1000.service es el gestor de servicios del usuario, no un servicio concreto.
    else if (cg.endsWith(".service") && !/^user@\d+\.service$/.test(cg)) unit = cg;
    out.set(Number(pidS), { user: user && user !== "UNKNOWN" ? user : null, unit, containerId });
  }
  return out;
}

/** «id nombre» de `podman/docker ps` → id → nombre. */
export function parseContainers(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const m = /^([0-9a-f]{12,64})\s+(\S+)/.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

function containerName(id: string, ctr: Map<string, string>): string {
  for (const [full, name] of ctr) if (full.startsWith(id) || id.startsWith(full)) return name;
  return id.slice(0, 12);
}

export function parsePorts(stdout: string): PortsResult {
  const s = splitSections(stdout);
  const toolS = (s.get("tool") ?? [])[0];
  const tool: PortsResult["tool"] = toolS === "ss" || toolS === "netstat" ? toolS : "none";
  const listen = s.get("listen") ?? [];
  const raw = tool === "netstat" ? parseNetstat(listen) : parseSs(listen);
  const procs = parseProcs(s.get("procs") ?? []);
  const ctr = parseContainers(s.get("ctr") ?? []);
  const seen = new Set<string>();
  const ports: ListenPort[] = [];
  for (const r of raw) {
    const a = parseAddr(r.addr);
    if (!a) continue;
    const key = `${r.proto}|${a.ip}|${a.iface ?? ""}|${a.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const info = r.procs.map((p) => procs.get(p.pid)).find((x) => x) ?? null;
    ports.push({
      key,
      proto: r.proto,
      ip: a.ip,
      iface: a.iface,
      port: a.port,
      family: r.family,
      scope: scopeOf(a.ip),
      procs: r.procs,
      user: info?.user ?? null,
      unit: info?.unit ?? null,
      container: info?.containerId ? containerName(info.containerId, ctr) : null,
    });
  }
  ports.sort((x, y) => x.port - y.port || x.proto.localeCompare(y.proto) || x.family - y.family || x.ip.localeCompare(y.ip));
  return { tool, ports };
}

/** Dirección para mostrar o copiar: «0.0.0.0:80», «[::]:443». */
export function formatListen(p: Pick<ListenPort, "ip" | "port" | "iface">): string {
  const host = p.ip.includes(":") ? `[${p.ip}${p.iface ? `%${p.iface}` : ""}]` : `${p.ip}${p.iface ? `%${p.iface}` : ""}`;
  return `${host}:${p.port}`;
}

/** A qué dirección del servidor debe ir un túnel para llegar a este puerto. */
export function tunnelDestHost(p: Pick<ListenPort, "ip" | "scope">): string {
  if (p.ip === "::") return "::1";
  if (p.scope === "public") return "127.0.0.1";
  return p.ip;
}

/** ¿Algún puerto TCP en escucha atiende conexiones a `host:port` desde el propio servidor? */
export function findListener(ports: ListenPort[], host: string, port: number): ListenPort | null {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const candidates = ports.filter((p) => p.proto === "tcp" && p.port === port);
  if (candidates.length === 0) return null;
  const local = h === "localhost" || isLoopback(h);
  return (
    candidates.find((p) => p.ip === h) ??
    candidates.find((p) => p.scope === "public") ??
    (local ? candidates.find((p) => p.scope === "local") : undefined) ??
    null
  );
}

/** ¿El host es esta misma máquina (localhost, 127.x, ::1, 0.0.0.0)? */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "0.0.0.0" || h === "::" || isLoopback(h);
}

/**
 * ¿El puerto coincide con la búsqueda? «:80» es exactamente el puerto 80; cualquier otro texto se busca
 * en el puerto, la dirección, los procesos y sus PID, el usuario, el servicio, el contenedor y el nombre
 * habitual del puerto.
 */
export function matchPort(p: ListenPort, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const exact = /^:(\d+)$/.exec(q);
  if (exact) return p.port === Number(exact[1]);
  const hay = [
    String(p.port),
    formatListen(p),
    p.proto,
    p.user ?? "",
    p.unit ?? "",
    p.container ?? "",
    WELL_KNOWN[p.port] ?? "",
    ...p.procs.flatMap((x) => [x.name, String(x.pid)]),
  ];
  return hay.some((h) => h.toLowerCase().includes(q));
}
