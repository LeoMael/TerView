// Datos de ejemplo del mapa de infraestructura: web-prod (nginx → 2 sitios → contenedores y una app de
// Node, varios usuarios) y db-01 (PostgreSQL), conectados. Los usan las pruebas y la vista previa.
import type { ListenPort, PortScope } from "../admin/ports";
import type { Site, WebResult } from "../admin/web";
import type { OwnedContainer, ServerSnapshot } from "./graph";
import type { HumanUser } from "./parse";

function port(p: number, ip: string, proc: string | null, pid: number, user: string | null, extra: Partial<ListenPort> = {}): ListenPort {
  const scope: PortScope = ip === "0.0.0.0" || ip === "::" || ip === "*" ? "public" : ip.startsWith("127.") || ip === "::1" ? "local" : "ip";
  return {
    key: `tcp|${ip}|${p}`,
    proto: "tcp",
    ip,
    iface: null,
    port: p,
    family: ip.includes(":") ? 6 : 4,
    scope,
    procs: proc ? [{ name: proc, pid }] : [],
    user,
    unit: null,
    container: null,
    ...extra,
  };
}

function ctr(name: string, image: string, user: string, x: Partial<OwnedContainer> = {}): OwnedContainer {
  return {
    id: `${name.replace(/[^a-f0-9]/g, "a")}0123456789abcdef`.slice(0, 64),
    shortId: name.slice(0, 12),
    name,
    image,
    state: "running",
    status: "Up 3 days",
    exitCode: null,
    health: null,
    created: null,
    ports: [],
    labels: {},
    networks: [],
    command: "",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: null,
    pod: null,
    engine: "podman",
    user,
    ...x,
  };
}

function site(key: string, names: string[], routes: Site["routes"], certExpires: number | null): Site {
  return {
    key,
    server: "nginx",
    names,
    listens: [
      { host: null, port: 443, https: true },
      { host: null, port: 80, https: false },
    ],
    https: true,
    isDefault: false,
    cert: `/etc/letsencrypt/live/${names[0]}/fullchain.pem`,
    certExpires,
    routes,
    file: `/etc/nginx/sites-enabled/${key}`,
    line: 1,
  };
}

const DAY = 86_400_000;

function humans(list: [string, number][]): Map<string, HumanUser> {
  return new Map(list.map(([name, uid]) => [name, { name, uid, home: `/home/${name}`, runtimeDir: true }]));
}

export function sampleSnapshots(now = Date.now()): ServerSnapshot[] {
  const web: WebResult = {
    servers: [
      {
        server: "nginx",
        source: "dump",
        configPath: "/etc/nginx/nginx.conf",
        status: "active",
        warning: null,
        sites: [
          site(
            "tienda",
            ["tienda.example.com", "www.tienda.example.com"],
            [{ path: "/", target: { kind: "proxy", url: "http://127.0.0.1:8080", host: "127.0.0.1", port: 8080, socket: null } }],
            now + 64 * DAY,
          ),
          site(
            "api",
            ["api.example.com"],
            [
              { path: "/", target: { kind: "proxy", url: "http://localhost:3000", host: "localhost", port: 3000, socket: null } },
              { path: "/static/", target: { kind: "files", root: "/var/www/api" } },
            ],
            now + 20 * DAY,
          ),
        ],
      },
    ],
  };
  const webProd: ServerSnapshot = {
    id: "srv-web",
    name: "web-prod",
    host: "203.0.113.10",
    sessionId: "sess-1",
    error: null,
    elevated: true,
    me: "deploy",
    ports: {
      tool: "ss",
      ports: [
        port(80, "0.0.0.0", "nginx", 1201, "root", { unit: "nginx.service" }),
        port(443, "0.0.0.0", "nginx", 1201, "root", { unit: "nginx.service" }),
        port(22, "0.0.0.0", "sshd", 900, "root", { unit: "ssh.service" }),
        port(8080, "127.0.0.1", "rootlessport", 3301, "ana"),
        port(3000, "127.0.0.1", "node", 812, "deploy", { unit: "api.service" }),
        port(9443, "0.0.0.0", "docker-proxy", 4100, "root"),
        port(53, "127.0.0.53", "systemd-resolve", 700, "systemd-resolve", { unit: "systemd-resolved.service", iface: "lo" }),
      ],
    },
    web,
    containers: [
      ctr("tienda-app", "docker.io/library/php:8.3-apache", "ana", {
        ports: [{ hostIp: "127.0.0.1", hostPort: 8080, containerPort: 80, protocol: "tcp", range: 1 }],
        composeProject: "tienda",
        composeService: "app",
        networks: ["tienda_default"],
      }),
      ctr("tienda-redis", "docker.io/library/redis:7", "ana", { composeProject: "tienda", composeService: "redis", networks: ["tienda_default"] }),
      ctr("portainer", "portainer/portainer-ce:2.21", "sistema", {
        engine: "docker",
        ports: [{ hostIp: "", hostPort: 9443, containerPort: 9443, protocol: "tcp", range: 1 }],
      }),
      ctr("backup-viejo", "docker.io/library/alpine:3", "deploy", { state: "exited", status: "Exited (1) 2 days ago", exitCode: 1 }),
    ],
    extra: {
      os: "Ubuntu 24.04.1 LTS",
      hostname: "web-prod",
      addrs: ["203.0.113.10", "10.0.0.5"],
      firewall: [{ tool: "ufw", state: "active", active: true }],
      humans: humans([
        ["deploy", 1000],
        ["ana", 1001],
      ]),
      established: [
        { localIp: "10.0.0.5", localPort: 51234, peerIp: "10.0.0.9", peerPort: 5432, proc: "node", pid: 812 },
        { localIp: "203.0.113.10", localPort: 22, peerIp: "198.51.100.7", peerPort: 60001, proc: "sshd", pid: 2001 },
      ],
      userServices: [],
    },
    userServices: { ana: ["sync-fotos.service"], deploy: ["api.service"] },
    notes: [],
  };
  const db: ServerSnapshot = {
    id: "srv-db",
    name: "db-01",
    host: "db-01.interno",
    sessionId: "sess-2",
    error: null,
    elevated: true,
    me: "deploy",
    ports: {
      tool: "ss",
      ports: [
        port(5432, "10.0.0.9", "postgres", 1500, "postgres", { unit: "postgresql@16-main.service" }),
        port(5432, "127.0.0.1", "postgres", 1500, "postgres", { unit: "postgresql@16-main.service" }),
        port(22, "0.0.0.0", "sshd", 880, "root", { unit: "ssh.service" }),
        port(9100, "0.0.0.0", "node_exporter", 1600, "prometheus", { unit: "node_exporter.service" }),
      ],
    },
    web: { servers: [] },
    containers: [],
    extra: {
      os: "Debian GNU/Linux 12 (bookworm)",
      hostname: "db-01",
      addrs: ["10.0.0.9"],
      firewall: [{ tool: "nftables", state: "4 cadenas", active: true }],
      humans: humans([["deploy", 1000]]),
      established: [{ localIp: "10.0.0.9", localPort: 5432, peerIp: "10.0.0.5", peerPort: 51234, proc: "postgres", pid: 1777 }],
      userServices: [],
    },
    userServices: {},
    notes: [],
  };
  return [webProd, db];
}
