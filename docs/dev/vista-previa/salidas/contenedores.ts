// Salidas de Docker en «lab-docker»: detección del motor (features/containers/detect.ts),
// `docker ps -a` y `docker stats` en formato {{json .}} (una línea JSON por contenedor).
import type { Rule } from "../salidas";

/** Id de 64 caracteres hexadecimales a partir de una semilla (siempre el mismo). */
function fakeId(seed: string): string {
  let h = 2166136261;
  let out = "";
  while (out.length < 64) {
    for (const ch of seed + out.length) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

export interface FakeContainer {
  name: string;
  image: string;
  state: "running" | "exited";
  /** Texto de Docker, sin el «hace…» (se calcula con `ageH`). */
  status: string;
  ports: string;
  command: string;
  /** Horas desde que se creó. */
  ageH: number;
  compose?: string;
  service?: string;
  networks: string;
  /** Consumo típico (para `docker stats`). */
  cpu: number;
  memMiB: number;
  netIO: string;
  blockIO: string;
}

export const CONTENEDORES: FakeContainer[] = [
  {
    name: "tienda-nginx-1",
    image: "nginx:1.27-alpine",
    state: "running",
    status: "Up 3 days",
    ports: "0.0.0.0:80->80/tcp, :::80->80/tcp, 0.0.0.0:443->443/tcp, :::443->443/tcp",
    command: '"/docker-entrypoint.sh nginx -g \'daemon off;\'"',
    ageH: 76,
    compose: "tienda",
    service: "nginx",
    networks: "tienda_default",
    cpu: 0.4,
    memMiB: 14.2,
    netIO: "1.92GB / 6.31GB",
    blockIO: "4.1MB / 12.3kB",
  },
  {
    name: "tienda-api-1",
    image: "registry.example.com/tienda/api:2.4.1",
    state: "running",
    status: "Up 3 days (healthy)",
    ports: "127.0.0.1:3000->3000/tcp",
    command: '"docker-entrypoint.sh node dist/server.js"',
    ageH: 76,
    compose: "tienda",
    service: "api",
    networks: "tienda_default",
    cpu: 6.8,
    memMiB: 186.4,
    netIO: "842MB / 1.23GB",
    blockIO: "38.2MB / 1.05MB",
  },
  {
    name: "tienda-db-1",
    image: "postgres:16-alpine",
    state: "running",
    status: "Up 3 days (healthy)",
    ports: "127.0.0.1:5432->5432/tcp",
    command: '"docker-entrypoint.sh postgres"',
    ageH: 76,
    compose: "tienda",
    service: "db",
    networks: "tienda_default",
    cpu: 2.1,
    memMiB: 312.7,
    netIO: "512MB / 698MB",
    blockIO: "1.21GB / 3.48GB",
  },
  {
    name: "tienda-redis-1",
    image: "redis:7-alpine",
    state: "running",
    status: "Up 3 days",
    ports: "6379/tcp",
    command: '"docker-entrypoint.sh redis-server --appendonly yes"',
    ageH: 76,
    compose: "tienda",
    service: "redis",
    networks: "tienda_default",
    cpu: 0.9,
    memMiB: 21.3,
    netIO: "96.4MB / 141MB",
    blockIO: "2.3MB / 88.1MB",
  },
  {
    name: "adminer",
    image: "adminer:4.8.1",
    state: "running",
    status: "Up 5 hours",
    ports: "0.0.0.0:8081->8080/tcp, :::8081->8080/tcp",
    command: '"entrypoint.sh php -S [::]:8080 -t /var/www/html"',
    ageH: 5,
    networks: "tienda_default",
    cpu: 0.0,
    memMiB: 9.8,
    netIO: "2.11MB / 14.6MB",
    blockIO: "0B / 0B",
  },
  {
    name: "copia-nocturna",
    image: "alpine:3.20",
    state: "exited",
    status: "Exited (0) 9 hours ago",
    ports: "",
    command: '"/bin/sh /scripts/copia.sh"',
    ageH: 340,
    networks: "bridge",
    cpu: 0,
    memMiB: 0,
    netIO: "",
    blockIO: "",
  },
  {
    name: "grafana",
    image: "grafana/grafana:11.2.0",
    state: "exited",
    status: "Exited (137) 2 days ago",
    ports: "",
    command: '"/run.sh"',
    ageH: 410,
    networks: "bridge",
    cpu: 0,
    memMiB: 0,
    netIO: "",
    blockIO: "",
  },
];

export const containerId = (c: FakeContainer) => fakeId(c.name);

const MEM_LIMIT_GIB = 7.69;

/** Ruido pequeño alrededor de un valor (nunca negativo). */
export function jitter(v: number, rel = 0.25): number {
  return Math.max(0, v * (1 + (Math.random() * 2 - 1) * rel));
}

function dockerDate(hoursAgo: number): string {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000 UTC`;
}

function labels(c: FakeContainer): string {
  if (!c.compose) return "";
  return [
    `com.docker.compose.project=${c.compose}`,
    `com.docker.compose.service=${c.service}`,
    `com.docker.compose.project.working_dir=/srv/${c.compose}`,
    `com.docker.compose.project.config_files=/srv/${c.compose}/compose.yaml`,
    "com.docker.compose.oneoff=False",
    "com.docker.compose.version=2.29.7",
  ].join(",");
}

function psLines(): string {
  return CONTENEDORES.map((c) =>
    JSON.stringify({
      Command: c.command,
      CreatedAt: dockerDate(c.ageH),
      ID: containerId(c),
      Image: c.image,
      Labels: labels(c),
      LocalVolumes: c.compose ? "1" : "0",
      Mounts: "",
      Names: c.name,
      Networks: c.networks,
      Ports: c.ports,
      RunningFor: `${Math.round(c.ageH / 24)} days ago`,
      Size: "0B",
      State: c.state,
      Status: c.status,
    }),
  ).join("\n");
}

function memText(mib: number): string {
  return `${mib.toFixed(mib < 100 ? 2 : 1)}MiB / ${MEM_LIMIT_GIB}GiB`;
}

/** Consumo actual de los contenedores en marcha (con algo de ruido en cada llamada). */
export function liveStats() {
  return CONTENEDORES.filter((c) => c.state === "running").map((c) => {
    const cpu = jitter(c.cpu, 0.35);
    const mem = jitter(c.memMiB, 0.03);
    return {
      c,
      id: containerId(c).slice(0, 12),
      cpu: `${cpu.toFixed(2)}%`,
      memUsage: memText(mem),
      memPerc: `${((mem / (MEM_LIMIT_GIB * 1024)) * 100).toFixed(2)}%`,
    };
  });
}

function statsLines(): string {
  return liveStats()
    .map((s) =>
      JSON.stringify({
        BlockIO: s.c.blockIO,
        CPUPerc: s.cpu,
        Container: s.id,
        ID: s.id,
        MemPerc: s.memPerc,
        MemUsage: s.memUsage,
        Name: s.c.name,
        NetIO: s.c.netIO,
        PIDs: String(s.c.name.includes("db") ? 9 : s.c.name.includes("api") ? 11 : 3),
      }),
    )
    .join("\n");
}

const DETECT = [
  "tv_begin=1",
  "uid=1000",
  "groups=ana adm sudo docker",
  "docker=1",
  "docker_cli=Docker version 27.3.1, build ce12230",
  "docker_ok=1",
  "docker_info=27.3.1|[name=apparmor name=seccomp,profile=builtin name=cgroupns]",
  "docker_compose=1",
  "docker_sock=1",
  "docker_sock_w=1",
  "docker_service=active",
  "docker_group=1",
  "tv_end=1",
  "",
].join("\n");

export const reglas: Rule[] = [
  // Detección (script por stdin; ver respuestas/contenedores.ts).
  [/echo tv_begin=1[\s\S]*podman_version/, DETECT],
  [/docker ps -a --no-trunc --format/, psLines],
  [/docker stats --no-stream --format '\{\{json \.\}\}'/, statsLines],
];
