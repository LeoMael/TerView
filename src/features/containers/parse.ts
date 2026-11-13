// Parseo robusto de las salidas JSON de Podman y Docker (funciones puras, nunca lanzan).
//  - Podman (`--format json`): un array JSON, números y objetos (Ports, Labels, Names como array).
//  - Docker (`--format '{{json .}}'`): una línea JSON por elemento, casi todo como texto
//    (Ports "0.0.0.0:8080->80/tcp", Labels "a=b,c=d", Size "187MB", CreatedAt "2024-01-15 10:00:00 +0000 UTC").
import type {
  Container,
  ContainerState,
  ContainerStats,
  DfRow,
  ImageInfo,
  InspectSummary,
  NetworkInfo,
  PortMapping,
  VolumeInfo,
} from "./types";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Acepta un array JSON, un objeto suelto o una línea JSON por elemento (ignora líneas basura). */
export function parseJsonList(text: string): Obj[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const v: unknown = JSON.parse(t);
      if (Array.isArray(v)) return v.filter(isObj);
    } catch {
      // Puede ser varias líneas que empiezan por "[" (raro): se prueba línea a línea.
    }
  }
  const out: Obj[] = [];
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (Array.isArray(v)) out.push(...v.filter(isObj));
      else if (isObj(v)) out.push(v);
    } catch {
      // línea no válida: se ignora
    }
  }
  if (out.length === 0 && t.startsWith("{")) {
    try {
      const v: unknown = JSON.parse(t);
      if (isObj(v)) out.push(v);
    } catch {
      // nada
    }
  }
  return out;
}

/** Primer campo presente (sin distinguir mayúsculas). */
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (k in o && o[k] !== undefined) return o[k];
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined && o[real] !== undefined) return o[real];
  }
  return undefined;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Etiquetas: objeto (Podman) o "k=v,k2=v2" (Docker; los valores pueden llevar comas). */
export function parseLabels(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = str(val);
    return out;
  }
  if (typeof v !== "string" || !v.trim()) return out;
  // Separa por comas que van seguidas de «clave=» (clave sin espacios ni comas).
  const parts = v.split(/,(?=[^,=\s]+=)/);
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i <= 0) continue;
    out[p.slice(0, i).trim()] = p.slice(i + 1);
  }
  return out;
}

/** "187MB", "1.2 GB", "9.5MiB", "0B", "10.01GB (58%)" → bytes. Docker usa unidades decimales (kB, MB). */
export function parseSize(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = /^\s*([\d.]+)\s*([kKMGTP]?i?B?)\b/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  const bin = unit.includes("i");
  const base = bin ? 1024 : 1000;
  const p = { "": 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit.replace(/i?B?$/, "")] ?? 0;
  return Math.round(n * base ** p);
}

/** "12.5%" → 12.5 */
function parsePercent(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = /([\d.]+)\s*%/.exec(v);
  return m ? Number(m[1]) : num(v);
}

/**
 * Fechas: número unix (s o ns), ISO 8601, o el formato de Docker "2024-01-15 10:00:00 +0000 UTC".
 * Devuelve unix segundos o null. Las fechas «cero» (0001-01-01, negativas) son null.
 */
export function parseTime(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v > 1e17) return Math.floor(v / 1e9); // nanosegundos
    if (v > 1e11) return Math.floor(v / 1e3); // milisegundos
    return Math.floor(v);
  }
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim();
  if (/^\d+$/.test(s)) return parseTime(Number(s));
  // Docker: "2024-01-15 10:00:00 +0000 UTC" (puede llevar fracciones de segundo).
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})?/.exec(s);
  if (m) s = `${m[1]}T${m[2]}${m[3]}:${m[4] ?? "00"}`;
  else s = s.replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const secs = Math.floor(t / 1000);
  return secs > 0 ? secs : null;
}

const STATE_MAP: Record<string, ContainerState> = {
  running: "running",
  up: "running",
  paused: "paused",
  exited: "exited",
  stopped: "exited",
  stopping: "running",
  configured: "created",
  initialized: "created",
  created: "created",
  restarting: "restarting",
  removing: "removing",
  dead: "dead",
};

export function normalizeState(state: string, status = ""): ContainerState {
  const s = state.toLowerCase().trim();
  if (STATE_MAP[s]) return STATE_MAP[s];
  const st = status.toLowerCase();
  if (st.startsWith("up")) return st.includes("paused") ? "paused" : "running";
  if (st.startsWith("exited")) return "exited";
  if (st.startsWith("created")) return "created";
  if (st.startsWith("restarting")) return "restarting";
  return "unknown";
}

function healthOf(status: string): Container["health"] {
  const s = status.toLowerCase();
  if (s.includes("(healthy)")) return "healthy";
  if (s.includes("(unhealthy)")) return "unhealthy";
  if (s.includes("health: starting") || s.includes("(starting)")) return "starting";
  return null;
}

/**
 * Puertos de Docker: "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp, 127.0.0.1:8000-8002->8000-8002/tcp".
 * Las entradas IPv6 duplicadas de un mismo puerto se juntan.
 */
export function parsePortsString(s: string): PortMapping[] {
  const out: PortMapping[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    let m = /^(?:(.*):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)$/.exec(part);
    if (m) {
      let ip = m[1] ?? "";
      if (ip === "0.0.0.0" || ip === "::" || ip === "[::]") ip = "";
      ip = ip.replace(/^\[|\]$/g, "");
      const hostPort = Number(m[2]);
      const range = m[3] ? Number(m[3]) - hostPort + 1 : 1;
      const key = `${ip}|${hostPort}|${m[4]}|${m[6]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hostIp: ip, hostPort, containerPort: Number(m[4]), protocol: m[6], range });
      continue;
    }
    m = /^(\d+)(?:-(\d+))?\/(\w+)$/.exec(part);
    if (m) {
      const key = `x|${m[1]}|${m[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        hostIp: "",
        hostPort: null,
        containerPort: Number(m[1]),
        protocol: m[3],
        range: m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1,
      });
    }
  }
  return out;
}

function parsePorts(v: unknown): PortMapping[] {
  if (typeof v === "string") return parsePortsString(v);
  if (!Array.isArray(v)) return [];
  const out: PortMapping[] = [];
  for (const p of v) {
    if (!isObj(p)) continue;
    const cp = num(pick(p, "container_port", "containerPort", "PrivatePort"));
    if (cp === null) continue;
    let ip = str(pick(p, "host_ip", "hostIP", "IP"));
    if (ip === "0.0.0.0" || ip === "::") ip = "";
    out.push({
      hostIp: ip,
      hostPort: num(pick(p, "host_port", "hostPort", "PublicPort")),
      containerPort: cp,
      protocol: str(pick(p, "protocol", "Type")) || "tcp",
      range: num(pick(p, "range")) ?? 1,
    });
  }
  return out;
}

function exitCodeOf(o: Obj, status: string): number | null {
  const m = /exited \((-?\d+)\)/i.exec(status);
  if (m) return Number(m[1]);
  return num(pick(o, "ExitCode"));
}

/** `ps -a` de Podman (array) o Docker (una línea por contenedor). */
export function parseContainers(text: string): Container[] {
  const out: Container[] = [];
  for (const o of parseJsonList(text)) {
    const id = str(pick(o, "Id", "ID"));
    if (!id) continue;
    const names = strList(pick(o, "Names", "Name"));
    const status = str(pick(o, "Status"));
    const state = normalizeState(str(pick(o, "State")), status);
    const labels = parseLabels(pick(o, "Labels"));
    const cmdRaw = pick(o, "Command");
    const command = Array.isArray(cmdRaw) ? cmdRaw.map(str).join(" ") : str(cmdRaw).replace(/^"|"$/g, "");
    // Podman: Created numérico (ps --format json) o ISO ({{json .}}); Docker: CreatedAt "… +0000 UTC".
    const created = parseTime(pick(o, "Created")) ?? parseTime(pick(o, "CreatedAt"));
    const pod = str(pick(o, "PodName")) || null;
    out.push({
      id,
      shortId: id.slice(0, 12),
      name: (names[0] ?? id.slice(0, 12)).replace(/^\//, ""),
      image: str(pick(o, "Image")),
      state,
      status,
      exitCode: state === "exited" ? exitCodeOf(o, status) : null,
      health: healthOf(status),
      created,
      ports: parsePorts(pick(o, "Ports")),
      labels,
      networks: strList(pick(o, "Networks")),
      command,
      composeProject: labels["com.docker.compose.project"] ?? labels["io.podman.compose.project"] ?? null,
      composeService: labels["com.docker.compose.service"] ?? null,
      composeWorkingDir: labels["com.docker.compose.project.working_dir"] ?? null,
      composeConfigFiles: labels["com.docker.compose.project.config_files"] ?? null,
      pod,
    });
  }
  return out;
}

/** `images` de Podman (array, una entrada por imagen con varias etiquetas) o Docker (una línea por etiqueta). */
export function parseImages(text: string): ImageInfo[] {
  const byId = new Map<string, ImageInfo>();
  const order: string[] = [];
  for (const o of parseJsonList(text)) {
    let id = str(pick(o, "Id", "ID")).replace(/^sha256:/, "");
    if (!id) continue;
    const repo = str(pick(o, "Repository"));
    const tag = str(pick(o, "Tag"));
    const names = strList(pick(o, "Names", "RepoTags"));
    let tags: string[];
    if (names.length) tags = names;
    else if (repo && repo !== "<none>") tags = [`${repo}:${tag && tag !== "<none>" ? tag : "latest"}`];
    else tags = [];
    tags = tags.filter((t) => !t.startsWith("<none>"));
    const containers = num(pick(o, "Containers"));
    const danglingRaw = pick(o, "Dangling");
    const dangling = typeof danglingRaw === "boolean" ? danglingRaw : tags.length === 0;
    id = id.toLowerCase();
    const prev = byId.get(id);
    if (prev) {
      for (const t of tags) if (!prev.tags.includes(t)) prev.tags.push(t);
      prev.dangling = prev.dangling && dangling;
      continue;
    }
    const first = tags[0] ?? "";
    const colon = first.lastIndexOf(":");
    const slash = first.lastIndexOf("/");
    const info: ImageInfo = {
      id,
      shortId: id.slice(0, 12),
      tags,
      repository: first ? (colon > slash ? first.slice(0, colon) : first) : repo || "<none>",
      tag: first ? (colon > slash ? first.slice(colon + 1) : "latest") : tag || "<none>",
      size: parseSize(pick(o, "Size")) ?? parseSize(pick(o, "VirtualSize")),
      created: parseTime(pick(o, "Created")) ?? parseTime(pick(o, "CreatedAt")),
      containers,
      dangling,
    };
    byId.set(id, info);
    order.push(id);
  }
  return order.map((id) => byId.get(id) as ImageInfo);
}

const HEX64 = /^[0-9a-f]{64}$/;

/** `volume ls` (todos) + lista de nombres sin usar (`volume ls -q --filter dangling=true`). */
export function parseVolumes(text: string, unusedNames: string[] = []): VolumeInfo[] {
  const unused = new Set(unusedNames.map((s) => s.trim()).filter(Boolean));
  const out: VolumeInfo[] = [];
  for (const o of parseJsonList(text)) {
    const name = str(pick(o, "Name"));
    if (!name) continue;
    const anon = pick(o, "Anonymous");
    out.push({
      name,
      driver: str(pick(o, "Driver")) || "local",
      mountpoint: str(pick(o, "Mountpoint")),
      created: parseTime(pick(o, "CreatedAt")),
      labels: parseLabels(pick(o, "Labels")),
      anonymous: typeof anon === "boolean" ? anon : HEX64.test(name),
      unused: unused.has(name),
    });
  }
  return out;
}

const BUILTIN_NETWORKS = new Set(["podman", "bridge", "host", "none"]);

export function parseNetworks(text: string): NetworkInfo[] {
  const out: NetworkInfo[] = [];
  for (const o of parseJsonList(text)) {
    const name = str(pick(o, "name", "Name"));
    if (!name) continue;
    const subnetsRaw = pick(o, "subnets", "Subnets");
    const subnets: string[] = [];
    if (Array.isArray(subnetsRaw)) {
      for (const s of subnetsRaw) if (isObj(s)) subnets.push(str(pick(s, "subnet", "Subnet")));
    }
    const internal = pick(o, "internal", "Internal");
    out.push({
      id: str(pick(o, "id", "ID", "Id")),
      name,
      driver: str(pick(o, "driver", "Driver")),
      subnets: subnets.filter(Boolean),
      internal: internal === true || internal === "true",
      created: parseTime(pick(o, "created", "CreatedAt", "Created")),
      labels: parseLabels(pick(o, "labels", "Labels")),
      builtin: BUILTIN_NETWORKS.has(name),
    });
  }
  return out;
}

const DF_LABELS: Record<string, string> = {
  images: "Imágenes",
  containers: "Contenedores",
  "local volumes": "Volúmenes",
  volumes: "Volúmenes",
  "build cache": "Caché de compilación",
};

/** `system df` (Podman: array con RawSize; Docker: una línea por tipo con tamaños en texto). */
export function parseDf(text: string): DfRow[] {
  return parseJsonList(text).map((o) => {
    const type = str(pick(o, "Type"));
    const reclaimText = str(pick(o, "Reclaimable"));
    return {
      type,
      label: DF_LABELS[type.toLowerCase()] ?? type,
      total: num(pick(o, "TotalCount", "Total")),
      active: num(pick(o, "Active")),
      size: num(pick(o, "RawSize")) ?? parseSize(pick(o, "Size")),
      reclaimable: num(pick(o, "RawReclaimable")) ?? parseSize(reclaimText),
      reclaimableText: reclaimText,
    };
  });
}

/** `stats --no-stream` (Podman json: textos "0.21%", "3.3MB / 16GB"; Podman {{json .}}: números; Docker: textos). */
export function parseStats(text: string): ContainerStats[] {
  const out: ContainerStats[] = [];
  for (const o of parseJsonList(text)) {
    const id = str(pick(o, "id", "ID", "ContainerID", "Container"));
    const name = str(pick(o, "name", "Name"));
    if (!id && !name) continue;
    let memUsage: number | null = null;
    let memLimit: number | null = null;
    const mu = pick(o, "mem_usage", "MemUsage");
    if (typeof mu === "string") {
      const [a, b] = mu.split("/");
      memUsage = parseSize(a);
      memLimit = parseSize(b);
    } else {
      memUsage = num(mu);
      memLimit = num(pick(o, "MemLimit"));
    }
    out.push({
      id,
      name,
      cpuPercent: parsePercent(pick(o, "cpu_percent", "CPUPerc", "CPU")),
      memUsage,
      memLimit,
      memPercent: parsePercent(pick(o, "mem_percent", "MemPerc")),
    });
  }
  return out;
}

/** Busca las estadísticas de un contenedor (por id corto/largo o nombre). */
export function statsFor(stats: ContainerStats[], c: { id: string; name: string; owner?: string }): ContainerStats | undefined {
  // Con «Todos», dos usuarios pueden tener contenedores con el mismo nombre: se compara también el dueño.
  return stats.find(
    (s) => (s.owner ?? "") === (c.owner ?? "") && ((s.id && (c.id.startsWith(s.id) || s.id.startsWith(c.id))) || (s.name && s.name === c.name)),
  );
}

/** Resumen legible de `inspect <contenedor>` (igual para Podman y Docker). */
export function parseInspect(text: string): { summary: InspectSummary | null; raw: unknown } {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return { summary: null, raw: null };
  }
  const o = Array.isArray(raw) ? raw[0] : raw;
  if (!isObj(o)) return { summary: null, raw };
  const cfg = isObj(o.Config) ? o.Config : {};
  const host = isObj(o.HostConfig) ? o.HostConfig : {};
  const st = isObj(o.State) ? o.State : {};
  const ns = isObj(o.NetworkSettings) ? o.NetworkSettings : {};
  const rp = isObj(host.RestartPolicy) ? host.RestartPolicy : {};

  const env = (Array.isArray(cfg.Env) ? cfg.Env : []).map(str).map((e) => {
    const i = e.indexOf("=");
    return i < 0 ? { key: e, value: "" } : { key: e.slice(0, i), value: e.slice(i + 1) };
  });
  const mounts = (Array.isArray(o.Mounts) ? o.Mounts : []).filter(isObj).map((m) => ({
    type: str(m.Type),
    source: str(m.Source),
    destination: str(m.Destination),
    rw: m.RW !== false,
    name: str(m.Name),
  }));
  const networks: InspectSummary["networks"] = [];
  if (isObj(ns.Networks)) {
    for (const [name, n] of Object.entries(ns.Networks)) {
      if (!isObj(n)) continue;
      networks.push({ name, ip: str(n.IPAddress), gateway: str(n.Gateway), mac: str(n.MacAddress) });
    }
  }
  if (networks.length === 0 && str(ns.IPAddress)) {
    networks.push({ name: str(host.NetworkMode) || "—", ip: str(ns.IPAddress), gateway: str(ns.Gateway), mac: str(ns.MacAddress) });
  }
  const ports: InspectSummary["ports"] = [];
  if (isObj(ns.Ports)) {
    for (const [cport, binds] of Object.entries(ns.Ports)) {
      if (Array.isArray(binds) && binds.length) {
        for (const b of binds) {
          if (!isObj(b)) continue;
          const ip = str(b.HostIp);
          ports.push({ container: cport, host: `${ip && ip !== "0.0.0.0" ? ip : "*"}:${str(b.HostPort)}` });
        }
      } else ports.push({ container: cport, host: "" });
    }
  }
  const cmdParts = [
    ...(Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint.map(str) : typeof cfg.Entrypoint === "string" ? [cfg.Entrypoint] : []),
    ...(Array.isArray(cfg.Cmd) ? cfg.Cmd.map(str) : typeof cfg.Cmd === "string" ? [cfg.Cmd] : []),
  ];
  const maxRetry = num(rp.MaximumRetryCount);
  const rpName = str(rp.Name);
  return {
    raw,
    summary: {
      id: str(o.Id),
      name: str(o.Name).replace(/^\//, ""),
      image: str(o.ImageName) || str(cfg.Image) || str(o.Image),
      created: str(o.Created),
      state: str(st.Status),
      startedAt: str(st.StartedAt),
      restartPolicy: rpName === "on-failure" && maxRetry ? `${rpName}:${maxRetry}` : rpName,
      restartCount: num(o.RestartCount),
      command: cmdParts.join(" "),
      workingDir: str(cfg.WorkingDir),
      env,
      mounts,
      networks,
      ports,
      labels: parseLabels(cfg.Labels),
    },
  };
}

/** Divide la salida en secciones marcadas con líneas `@@tv:<nombre>`. */
export function splitMarked(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^@@tv:([a-z0-9_-]+)\s*$/.exec(line);
    if (m) {
      if (cur !== null) out.set(cur, buf.join("\n"));
      cur = m[1];
      buf = [];
    } else if (cur !== null) buf.push(line);
  }
  if (cur !== null) out.set(cur, buf.join("\n"));
  return out;
}
