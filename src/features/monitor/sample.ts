// Muestreo del servidor: comando POSIX + parseo de su salida (funciones puras, sin React ni Tauri).
//
// Reglas del script (mismas que en privileges/detect.ts):
// - va entre comillas simples para el shell de login (bash, zsh, fish, tcsh…): dentro NO puede haber
//   comillas simples, barras invertidas ni "!";
// - solo lee: /proc, df, id, getconf, stat. Nada se instala ni se escribe en el servidor;
// - salida en secciones que empiezan con una línea "@@nombre"; quien la lee ignora lo que no conoce.
//
// Procesos: en vez de `ps --sort=-pcpu` (su %CPU es la media desde que arrancó el proceso, no el
// consumo actual, y busybox no lo admite) se leen los contadores de /proc/[pid]/stat y el % se
// calcula por diferencia entre dos muestras, igual que `top`. Funciona igual en GNU y en busybox.

export interface CpuTicks {
  /** Suma de todos los campos de la línea "cpu" de /proc/stat. */
  total: number;
  /** idle + iowait. */
  idle: number;
  iowait: number;
  steal: number;
}

export interface MemInfo {
  totalKb: number;
  availableKb: number;
  freeKb: number;
  buffersKb: number;
  /** Cached + SReclaimable. */
  cachedKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
}

export interface NetCounter {
  iface: string;
  rx: number;
  tx: number;
}

export interface DiskUsage {
  fs: string;
  mount: string;
  sizeKb: number;
  usedKb: number;
  availKb: number;
  /** Porcentaje usado (como lo muestra df: usado / (usado + disponible)). */
  pct: number;
}

export interface ProcStat {
  pid: number;
  ppid: number;
  comm: string;
  state: string;
  /** utime + stime, en ticks de reloj. */
  ticks: number;
  /** Arranque, en ticks desde el inicio del sistema. */
  start: number;
  /** Páginas residentes (null si no se pudo leer). */
  rssPages: number | null;
}

export interface SampleInfo {
  nproc: number | null;
  user: string | null;
  uid: number | null;
  pageSize: number | null;
  hz: number | null;
  docker: boolean;
  podman: boolean;
}

export interface RawSample {
  /** Hora local de la muestra (ms). */
  at: number;
  /** Segundos desde el arranque del servidor (/proc/uptime): reloj del servidor para las diferencias. */
  uptime: number | null;
  cpu: CpuTicks | null;
  mem: MemInfo | null;
  load: [number, number, number] | null;
  /** "en ejecución/total" de /proc/loadavg. */
  tasks: { running: number; total: number } | null;
  net: NetCounter[];
  disks: DiskUsage[];
  procs: ProcStat[];
  /** uid de cada pid pedido en esta muestra. */
  uids: Map<number, number>;
  /** uid → nombre (de /etc/passwd), solo en muestras completas. */
  users: Map<number, string>;
  /** Solo en muestras completas (la primera y cada cierto tiempo). */
  info: SampleInfo | null;
  /** La salida llegó entera (marca final presente). */
  complete: boolean;
  /** El servidor no tiene /proc (no es Linux). */
  noProc: boolean;
  /** pid del shell del muestreo. */
  selfPid: number | null;
}

/** Tiempo límite de cada muestreo (s). */
export const SAMPLE_TIMEOUT_SECS = 12;

export interface SampleCommandOptions {
  /** Incluir datos que casi no cambian (CPU, usuario, tamaños, herramientas, /etc/passwd). */
  full: boolean;
  /** pids cuyo dueño (uid) hay que averiguar. */
  uidPids?: number[];
}

/** Comando exacto que se envía por el canal exec. */
export function buildSampleCommand(opts: SampleCommandOptions): string {
  const parts: string[] = [
    "echo @@begin",
    // pid de este shell: sus hijos (cut, grep, df…) no son procesos del servidor.
    'echo "@@self=$$"',
    'if [ -r /proc/stat ]; then :; else echo @@noproc; fi',
    'echo @@stat; grep "^cpu " /proc/stat 2>/dev/null',
    "echo @@mem; cat /proc/meminfo 2>/dev/null",
    "echo @@load; cat /proc/loadavg 2>/dev/null",
    "echo @@up; cat /proc/uptime 2>/dev/null",
    "echo @@net; cat /proc/net/dev 2>/dev/null",
  ];
  if (opts.full) {
    parts.push(
      "echo @@info",
      'echo "nproc=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null)"',
      'echo "user=$(id -un 2>/dev/null)"',
      'echo "uid=$(id -u 2>/dev/null)"',
      'echo "page=$(getconf PAGESIZE 2>/dev/null)"',
      'echo "hz=$(getconf CLK_TCK 2>/dev/null)"',
      'if command -v docker >/dev/null 2>&1; then echo docker=1; fi',
      'if command -v podman >/dev/null 2>&1; then echo podman=1; fi',
      "echo @@passwd; cut -d: -f1,3 /etc/passwd 2>/dev/null",
    );
  }
  parts.push(
    // Procesos: pid (comm) estado ppid utime stime arranque rss. Sin hilos del kernel (padre = 2).
    'echo @@ps; cut -d" " -f1,2,3,4,14,15,22,24 /proc/[0-9]*/stat 2>/dev/null | grep -v ") . 2 "',
    // Los que tienen espacios en el nombre (p. ej. "tmux: server") descuadran cut: van completos.
    'echo @@psx; grep -h "(.* .*)" /proc/[0-9]*/stat 2>/dev/null',
  );
  const pids = (opts.uidPids ?? []).filter((p) => Number.isInteger(p) && p > 0).slice(0, 64);
  if (pids.length) {
    const paths = pids.map((p) => `/proc/${p}`).join(" ");
    parts.push(
      `echo @@uid; if command -v stat >/dev/null 2>&1; then stat -c "%u %n" ${paths} 2>/dev/null; else ls -lnd ${paths} 2>/dev/null; fi`,
    );
  }
  // df al final: si un montaje de red se cuelga, lo anterior ya llegó.
  parts.push("echo @@df; df -kP 2>/dev/null", "echo @@end");
  return `sh -c '${parts.join("; ")}'`;
}

const num = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

function splitSections(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@")) {
      const eq = line.indexOf("=");
      const name = (eq > 0 ? line.slice(2, eq) : line.slice(2)).trim();
      cur = [];
      out.set(name, cur);
      continue;
    }
    if (cur && line.trim() !== "") cur.push(line);
  }
  return out;
}

function sectionValues(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of stdout.split("\n")) {
    const m = /^@@([a-z]+)=(.*)$/.exec(raw.replace(/\r$/, ""));
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

export function parseCpu(lines: string[]): CpuTicks | null {
  const line = lines.find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 4 || f.some((x) => !Number.isFinite(x))) return null;
  // user nice system idle iowait irq softirq steal guest guest_nice. guest ya está dentro de user.
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { total, idle: idle + iowait, iowait, steal };
}

export function parseMeminfo(lines: string[]): MemInfo | null {
  const kv = new Map<string, number>();
  for (const l of lines) {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)/.exec(l);
    if (m) kv.set(m[1], Number(m[2]));
  }
  const total = kv.get("MemTotal");
  if (!total) return null;
  const free = kv.get("MemFree") ?? 0;
  const buffers = kv.get("Buffers") ?? 0;
  const cached = (kv.get("Cached") ?? 0) + (kv.get("SReclaimable") ?? 0);
  const available = kv.get("MemAvailable") ?? Math.min(total, free + buffers + cached);
  return {
    totalKb: total,
    availableKb: available,
    freeKb: free,
    buffersKb: buffers,
    cachedKb: cached,
    swapTotalKb: kv.get("SwapTotal") ?? 0,
    swapFreeKb: kv.get("SwapFree") ?? 0,
  };
}

export function parseLoadavg(lines: string[]): { load: [number, number, number]; tasks: RawSample["tasks"] } | null {
  const f = (lines[0] ?? "").trim().split(/\s+/);
  const load: [number, number, number] = [num(f[0]), num(f[1]), num(f[2])];
  if (load.some((x) => Number.isNaN(x))) return null;
  const t = /^(\d+)\/(\d+)$/.exec(f[3] ?? "");
  return { load, tasks: t ? { running: Number(t[1]), total: Number(t[2]) } : null };
}

export function parseUptime(lines: string[]): number | null {
  const v = num((lines[0] ?? "").trim().split(/\s+/)[0]);
  return Number.isNaN(v) ? null : v;
}

export function parseNetDev(lines: string[]): NetCounter[] {
  const out: NetCounter[] = [];
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i < 0) continue;
    const iface = l.slice(0, i).trim();
    if (!iface || iface.includes("|")) continue;
    const f = l.slice(i + 1).trim().split(/\s+/);
    const rx = num(f[0]);
    const tx = num(f[8]);
    if (Number.isNaN(rx) || Number.isNaN(tx)) continue;
    out.push({ iface, rx, tx });
  }
  return out;
}

const PSEUDO_FS = new Set(["tmpfs", "devtmpfs", "shm", "udev", "none", "proc", "sysfs", "cgroup", "cgroup2", "efivarfs", "run", "devfs", "squashfs"]);
const PSEUDO_MOUNT = /^\/(proc|sys|dev|run|snap)(\/|$)/;

/**
 * `df -kP`. Deja fuera lo que no es disco de verdad: tmpfs/devtmpfs/shm, montajes de /proc, /sys, /dev, /run,
 * los squashfs de snap y `overlay` (salvo si es la raíz: en un contenedor es el único disco que hay).
 * Si el mismo sistema de archivos está montado varias veces (bind mounts), queda el montaje más corto.
 */
export function parseDf(lines: string[]): DiskUsage[] {
  const all: DiskUsage[] = [];
  for (const l of lines) {
    if (/^Filesystem\s/i.test(l) || /^S\.\s*ficheros/i.test(l)) continue;
    // El punto de montaje puede tener espacios: los 4 números + "NN%" marcan dónde empieza.
    const m = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/.exec(l);
    if (!m) continue;
    const [, fs, size, used, avail, pct, mount] = m;
    all.push({ fs, mount, sizeKb: Number(size), usedKb: Number(used), availKb: Number(avail), pct: Number(pct) });
  }
  const keep = all.filter((d) => {
    if (d.sizeKb <= 0) return false;
    if (PSEUDO_FS.has(d.fs)) return false;
    if (d.fs === "overlay" && d.mount !== "/") return false;
    if (/^\/dev\/loop/.test(d.fs) && d.mount.startsWith("/snap")) return false;
    if (PSEUDO_MOUNT.test(d.mount)) return false;
    return true;
  });
  // Mismos números → el mismo sistema de archivos montado varias veces (bind mounts, raíz de un contenedor).
  const byKey = new Map<string, DiskUsage>();
  for (const d of keep) {
    const key = `${d.sizeKb}|${d.usedKb}`;
    const prev = byKey.get(key);
    if (!prev || d.mount.length < prev.mount.length) byKey.set(key, d);
  }
  return [...byKey.values()].sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount)));
}

/** Línea completa de /proc/[pid]/stat (el nombre puede tener espacios y paréntesis). */
export function parseProcStatLine(line: string): ProcStat | null {
  const open = line.indexOf(" (");
  const close = line.lastIndexOf(") ");
  if (open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open));
  const comm = line.slice(open + 2, close);
  const f = line.slice(close + 2).trim().split(/\s+/);
  // f[0] = estado (campo 3); utime = campo 14 → f[11]; stime f[12]; starttime f[19]; rss f[21].
  const ticks = num(f[11]) + num(f[12]);
  if (!Number.isInteger(pid) || Number.isNaN(ticks)) return null;
  const rss = num(f[21]);
  return { pid, ppid: num(f[1]), comm, state: f[0] ?? "?", ticks, start: num(f[19]), rssPages: Number.isNaN(rss) ? null : rss };
}

/** Líneas de `cut -f1,2,3,4,14,15,22,24`: pid (comm) estado ppid utime stime arranque rss. */
export function parseProcCutLine(line: string): ProcStat | null {
  const f = line.trim().split(" ");
  if (f.length < 8) return null;
  if (!f[1].startsWith("(") || !f[1].endsWith(")")) return null; // nombre con espacios: viene en @@psx
  const pid = Number(f[0]);
  const ticks = num(f[4]) + num(f[5]);
  if (!Number.isInteger(pid) || Number.isNaN(ticks)) return null;
  const rss = num(f[7]);
  return {
    pid,
    ppid: num(f[3]),
    comm: f[1].slice(1, -1),
    state: f[2],
    ticks,
    start: num(f[6]),
    rssPages: Number.isNaN(rss) ? null : rss,
  };
}

function parseInfo(lines: string[]): SampleInfo {
  const kv = new Map<string, string>();
  for (const l of lines) {
    const m = /^([a-z]+)=(.*)$/.exec(l);
    if (m) kv.set(m[1], m[2].trim());
  }
  const pos = (k: string) => {
    const v = Number(kv.get(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const uid = Number(kv.get("uid"));
  return {
    nproc: pos("nproc"),
    user: kv.get("user") || null,
    uid: kv.get("uid") !== undefined && kv.get("uid") !== "" && Number.isInteger(uid) ? uid : null,
    pageSize: pos("page"),
    hz: pos("hz"),
    docker: kv.get("docker") === "1",
    podman: kv.get("podman") === "1",
  };
}

/** `stat -c "%u %n"` → "1000 /proc/123"; o `ls -lnd` → "dr-xr-xr-x 9 1000 1000 0 … /proc/123". */
function parseUids(lines: string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of lines) {
    let m = /^(\d+)\s+\/proc\/(\d+)$/.exec(l.trim());
    if (m) {
      out.set(Number(m[2]), Number(m[1]));
      continue;
    }
    m = /^\S+\s+\d+\s+(\d+)\s+\d+\s.*\/proc\/(\d+)$/.exec(l.trim());
    if (m) out.set(Number(m[2]), Number(m[1]));
  }
  return out;
}

function parsePasswd(lines: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of lines) {
    const [name, id] = l.split(":");
    const uid = Number(id);
    if (name && Number.isInteger(uid) && !out.has(uid)) out.set(uid, name);
  }
  return out;
}

export function parseSample(stdout: string, at = Date.now()): RawSample {
  const s = splitSections(stdout);
  const get = (k: string) => s.get(k) ?? [];
  const procs = new Map<number, ProcStat>();
  for (const l of get("ps")) {
    const p = parseProcCutLine(l);
    if (p) procs.set(p.pid, p);
  }
  for (const l of get("psx")) {
    const p = parseProcStatLine(l);
    if (p && p.ppid !== 2) procs.set(p.pid, p);
  }
  const selfPid = Number(sectionValues(stdout).get("self"));
  const self = Number.isInteger(selfPid) && selfPid > 0 ? selfPid : null;
  if (self !== null) {
    for (const p of [...procs.values()]) if (p.pid === self || p.ppid === self) procs.delete(p.pid);
  }
  const la = parseLoadavg(get("load"));
  return {
    at,
    uptime: parseUptime(get("up")),
    cpu: parseCpu(get("stat")),
    mem: parseMeminfo(get("mem")),
    load: la?.load ?? null,
    tasks: la?.tasks ?? null,
    net: parseNetDev(get("net")),
    disks: parseDf(get("df")),
    procs: [...procs.values()],
    uids: parseUids(get("uid")),
    users: parsePasswd(get("passwd")),
    info: s.has("info") ? parseInfo(get("info")) : null,
    complete: s.has("end"),
    noProc: s.has("noproc"),
    selfPid: self,
  };
}

// ───────── Contenedores ─────────

export interface ContainerStat {
  engine: "docker" | "podman";
  id: string;
  name: string;
  cpuPct: number | null;
  memUsage: string;
  memPct: number | null;
  netIO: string;
  blockIO: string;
}

export interface ContainersResult {
  engines: ("docker" | "podman")[];
  containers: ContainerStat[];
  /** Mensajes de error por motor (permiso denegado, demonio parado…). */
  errors: { engine: string; message: string }[];
}

export const CONTAINERS_TIMEOUT_SECS = 20;

const STATS_FORMAT = "{{.ID}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}";

export function buildContainersCommand(): string {
  const script = [
    "for c in docker podman; do if command -v $c >/dev/null 2>&1; then echo @@engine=$c",
    `$c stats --no-stream --format "${STATS_FORMAT}" 2>&1 | head -n 80; fi; done`,
    "echo @@end",
  ].join("; ");
  return `sh -c '${script}'`;
}

const pctOf = (s: string | undefined): number | null => {
  const v = parseFloat((s ?? "").replace(",", ".").replace("%", ""));
  return Number.isFinite(v) ? v : null;
};

export function parseContainers(stdout: string): ContainersResult {
  const res: ContainersResult = { engines: [], containers: [], errors: [] };
  let engine: "docker" | "podman" | null = null;
  const errLines = new Map<string, string[]>();
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    const m = /^@@engine=(docker|podman)$/.exec(line);
    if (m) {
      engine = m[1] as "docker" | "podman";
      res.engines.push(engine);
      continue;
    }
    if (!engine || !line || line.startsWith("@@")) continue;
    const f = line.split("|");
    if (f.length >= 7) {
      res.containers.push({
        engine,
        id: f[0].slice(0, 12),
        name: f[1],
        cpuPct: pctOf(f[2]),
        memUsage: f[3],
        memPct: pctOf(f[4]),
        netIO: f[5],
        blockIO: f[6],
      });
    } else {
      const arr = errLines.get(engine) ?? [];
      arr.push(line);
      errLines.set(engine, arr);
    }
  }
  // `docker` puede ser el envoltorio de podman: mismos contenedores dos veces.
  const seen = new Set<string>();
  res.containers = res.containers.filter((c) => {
    const k = `${c.id}|${c.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Errores solo si no se pudo leer nada (p. ej. sin permiso en docker pero podman va bien: no molestar).
  if (!res.containers.length) {
    for (const [eng, lines] of errLines) res.errors.push({ engine: eng, message: lines.slice(0, 3).join(" ") });
  }
  return res;
}

// ───────── Terminar procesos ─────────

/** `kill` (o `kill -9`) y, un segundo después, si sigue vivo. Salida: rc=…, alive=0|1. */
export function buildKillCommand(pid: number, force: boolean): string {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("pid no válido");
  const sig = force ? "-9 " : "";
  // Un zombi (Z) ya terminó: solo espera a que su padre lo recoja.
  return `sh -c 'kill ${sig}${pid}; echo rc=$?; sleep 1; if [ -d /proc/${pid} ] || kill -0 ${pid} 2>/dev/null; then if grep -q ") Z " /proc/${pid}/stat 2>/dev/null; then echo alive=0; else echo alive=1; fi; else echo alive=0; fi'`;
}

export interface KillResult {
  ok: boolean;
  alive: boolean;
  permission: boolean;
  message: string;
}

export function parseKillOutput(stdout: string, stderr: string): KillResult {
  const rc = /rc=(\d+)/.exec(stdout);
  const alive = /alive=1/.test(stdout);
  const permission = /not permitted|permission|denied|no permitid|EPERM/i.test(stderr);
  return {
    ok: rc?.[1] === "0",
    alive,
    permission,
    message: stderr.trim().split("\n")[0] ?? "",
  };
}
