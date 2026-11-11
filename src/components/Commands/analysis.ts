// "Analizar servidor": un único script de solo lectura con marcadores de sección, y su análisis.
// Pensado para degradar bien: busybox/Alpine, contenedores sin systemd, sin ss, sin podman…
import { distroFromOs, parseOsRelease } from "./state";
import type { Distro } from "./catalog";
import { shellQuote } from "./template";

const SCRIPT = String.raw`
export LC_ALL=C
m() { echo "@@TV:$1@@"; }
has() { command -v "$1" >/dev/null 2>&1; }
t() { if has timeout; then timeout 8 "$@"; else "$@"; fi; }
m os; cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null
m kernel; uname -s -r -m 2>/dev/null
m host; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null
m user; id -un 2>/dev/null
m uptime; cat /proc/uptime 2>/dev/null
m load; cat /proc/loadavg 2>/dev/null
m cpus; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null
m cpumodel; grep -m1 -iE '^(model name|hardware|cpu model)' /proc/cpuinfo 2>/dev/null | cut -d: -f2-
m mem; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null || free -b 2>/dev/null
m disks; df -P -B1 2>/dev/null || { echo "#K"; df -P -k 2>/dev/null; }
m pcpu; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu 2>/dev/null | head -9 || true
m pmem; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pmem 2>/dev/null | head -9 || true
m psraw; ps -eo pid,user,pcpu,pmem,rss,comm >/dev/null 2>&1 || { ps 2>/dev/null | head -20; }
m failed; if has systemctl && [ -d /run/systemd/system ]; then t systemctl --failed --no-legend --plain --no-pager 2>/dev/null; else echo "#NA"; fi
m ports; if has ss; then t ss -tulpn 2>/dev/null; elif has netstat; then echo "#NETSTAT"; t netstat -tulpn 2>/dev/null || t netstat -tuln 2>/dev/null; else echo "#NA"; fi
m containers
for e in podman docker; do
  if has $e; then echo "#ENGINE $e"; t $e ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>&1 | head -50; fi
done
m journal
if has journalctl; then echo "#SRC journal"; t journalctl -p err -n 20 --no-pager -q -o short 2>/dev/null
elif [ -r /var/log/messages ]; then echo "#SRC messages"; grep -iE 'err|fail|crit' /var/log/messages 2>/dev/null | tail -20
elif [ -r /var/log/syslog ]; then echo "#SRC syslog"; grep -iE 'err|fail|crit' /var/log/syslog 2>/dev/null | tail -20
else echo "#NA"; fi
m end
`;

/** Comando final (envuelto en sh para no depender de la shell del usuario). */
export const ANALYSIS_COMMAND = `sh -c ${shellQuote(SCRIPT.trim())}`;
export const ANALYSIS_TIMEOUT_SECS = 60;

// ───────── Tipos del informe ─────────

export interface DiskRow {
  fs: string;
  mount: string;
  size: number;
  used: number;
  avail: number;
  pct: number;
}
export interface ProcRow {
  pid: string;
  user: string;
  cpu: number;
  mem: number;
  rss: number; // bytes
  command: string;
}
export interface PortRow {
  proto: string;
  local: string;
  port: string;
  process: string;
}
export interface ContainerRow {
  engine: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
}
export interface Report {
  osName: string | null;
  osId: string | null;
  distro: Distro | null;
  kernel: string | null;
  host: string | null;
  user: string | null;
  uptimeSecs: number | null;
  load: [number, number, number] | null;
  cpus: number | null;
  cpuModel: string | null;
  mem: { total: number; available: number; swapTotal: number; swapFree: number } | null;
  disks: DiskRow[];
  topCpu: ProcRow[];
  topMem: ProcRow[];
  psRaw: string | null;
  failed: string[] | null; // null = sin systemd
  ports: PortRow[] | null; // null = sin ss/netstat
  portsNote: string | null;
  containers: { engine: string; rows: ContainerRow[]; error: string | null }[];
  journal: { source: string; lines: string[] } | null;
  /** Comando terminado antes de tiempo (salida incompleta). */
  incomplete: boolean;
}

// ───────── Análisis ─────────

function splitSections(out: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of out.split("\n")) {
    const m = /^@@TV:([a-z]+)@@$/.exec(line.trim());
    if (m) {
      cur = [];
      map.set(m[1], cur);
    } else if (cur) {
      cur.push(line.replace(/\r$/, ""));
    }
  }
  for (const v of map.values()) while (v.length && !v[v.length - 1].trim()) v.pop();
  return map;
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const PSEUDO_FS = new Set(["tmpfs", "devtmpfs", "shm", "udev", "none", "run", "efivarfs", "overlay-tmp"]);
const PSEUDO_MOUNT = /^\/(dev|proc|sys|run)(\/|$)/;

function parseDisks(lines: string[]): DiskRow[] {
  const kb = lines[0] === "#K";
  const rows: DiskRow[] = [];
  const seen = new Map<string, number>();
  for (const line of lines.slice(kb ? 1 : 0)) {
    if (/^Filesystem/i.test(line)) continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    const [fs, size, used, avail] = p;
    const mount = p.slice(5).join(" ");
    if (PSEUDO_FS.has(fs) || PSEUDO_MOUNT.test(mount)) continue;
    const mul = kb ? 1024 : 1;
    const s = num(size) * mul;
    if (s <= 0) continue;
    const u = num(used) * mul;
    const a = num(avail) * mul;
    const row = { fs, mount, size: s, used: u, avail: a, pct: u + a > 0 ? (u / (u + a)) * 100 : 0 };
    // Montajes "bind" / subvolúmenes del mismo disco (típico en contenedores y btrfs): solo el más corto.
    const key = `${size}|${used}|${avail}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      if (mount.length < rows[prev].mount.length) rows[prev] = row;
      continue;
    }
    seen.set(key, rows.length);
    rows.push(row);
  }
  return rows.sort((x, y) => x.mount.localeCompare(y.mount));
}

function parsePs(lines: string[]): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of lines) {
    if (/^\s*PID\b/.test(line)) continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 6 || !/^\d+$/.test(p[0])) continue;
    rows.push({
      pid: p[0],
      user: p[1],
      cpu: num(p[2]),
      mem: num(p[3]),
      rss: num(p[4]) * 1024,
      command: p.slice(5).join(" "),
    });
  }
  return rows.slice(0, 8);
}

function parseMem(lines: string[]): Report["mem"] {
  if (lines.some((l) => l.startsWith("MemTotal:"))) {
    const kv: Record<string, number> = {};
    for (const l of lines) {
      const m = /^(\w+):\s+(\d+)/.exec(l);
      if (m) kv[m[1]] = Number(m[2]) * 1024;
    }
    const total = kv.MemTotal ?? 0;
    const available = kv.MemAvailable ?? (kv.MemFree ?? 0) + (kv.Buffers ?? 0) + (kv.Cached ?? 0);
    return { total, available, swapTotal: kv.SwapTotal ?? 0, swapFree: kv.SwapFree ?? 0 };
  }
  // free -b
  const mem = lines.find((l) => /^Mem:/.test(l))?.trim().split(/\s+/);
  const swap = lines.find((l) => /^Swap:/.test(l))?.trim().split(/\s+/);
  if (!mem) return null;
  const total = num(mem[1]);
  const available = mem.length >= 7 ? num(mem[6]) : num(mem[3]);
  return { total, available, swapTotal: num(swap?.[1]), swapFree: num(swap?.[3]) };
}

function splitHostPort(addr: string): { host: string; port: string } {
  const i = addr.lastIndexOf(":");
  if (i < 0) return { host: addr, port: "" };
  return { host: addr.slice(0, i), port: addr.slice(i + 1) };
}

function parsePorts(lines: string[]): { rows: PortRow[] | null; note: string | null } {
  if (lines[0] === "#NA") return { rows: null, note: "No hay ss ni netstat en el servidor." };
  const netstat = lines[0] === "#NETSTAT";
  const rows: PortRow[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(netstat ? 1 : 0)) {
    const p = line.trim().split(/\s+/);
    if (netstat) {
      // Proto Recv-Q Send-Q Local Foreign [State] [PID/Program]
      if (!/^(tcp|udp)6?$/.test(p[0] ?? "")) continue;
      const isTcp = p[0].startsWith("tcp");
      if (isTcp && p[5] !== "LISTEN") continue;
      const { host, port } = splitHostPort(p[3]);
      const proc = p[isTcp ? 6 : 5] ?? "";
      const row = { proto: p[0], local: host, port, process: proc === "-" ? "" : proc.replace(/^\d+\//, "") };
      const k = `${row.proto}|${row.local}|${row.port}`;
      if (!seen.has(k)) {
        seen.add(k);
        rows.push(row);
      }
    } else {
      // Netid State Recv-Q Send-Q Local Peer [Process]
      if (!/^(tcp|udp)$/.test(p[0] ?? "")) continue;
      if (p[0] === "tcp" && p[1] !== "LISTEN") continue;
      const { host, port } = splitHostPort(p[4] ?? "");
      const procField = p.slice(6).join(" ");
      const pm = /\(\("([^"]+)"/.exec(procField);
      rows.push({ proto: p[0], local: host, port, process: pm ? pm[1] : "" });
    }
  }
  rows.sort((a, b) => a.proto.localeCompare(b.proto) || num(a.port) - num(b.port));
  const anyProc = rows.some((r) => r.process);
  return { rows, note: rows.length && !anyProc ? "Sin permisos para ver qué proceso usa cada puerto." : null };
}

function parseContainers(lines: string[]): Report["containers"] {
  const out: Report["containers"] = [];
  let cur: Report["containers"][number] | null = null;
  for (const line of lines) {
    const m = /^#ENGINE (\w+)$/.exec(line);
    if (m) {
      cur = { engine: m[1], rows: [], error: null };
      out.push(cur);
      continue;
    }
    if (!cur || !line.trim()) continue;
    const p = line.split("|");
    if (p.length >= 3) {
      const status = p.slice(2).join("|");
      cur.rows.push({ engine: cur.engine, name: p[0], image: p[1], status, running: /^up\b/i.test(status) });
    } else {
      cur.error = cur.error ? `${cur.error}\n${line}` : line;
    }
  }
  return out;
}

export function parseReport(stdout: string, incomplete: boolean): Report {
  const s = splitSections(stdout);
  const get = (k: string) => s.get(k) ?? [];
  const first = (k: string) => get(k).find((l) => l.trim())?.trim() ?? null;

  const os = parseOsRelease(get("os").join("\n"));
  const up = first("uptime");
  const loadParts = first("load")?.split(/\s+/);
  const cpus = first("cpus");
  const failedLines = get("failed");
  const ports = parsePorts(get("ports"));
  const journalLines = get("journal");
  let journal: Report["journal"] = null;
  if (journalLines.length && journalLines[0] !== "#NA") {
    const src = /^#SRC (\w+)/.exec(journalLines[0]);
    journal = {
      source: src ? src[1] : "journal",
      lines: journalLines.slice(src ? 1 : 0).filter((l) => l.trim() && !/^-- No entries --/.test(l)),
    };
  }
  const topCpu = parsePs(get("pcpu"));
  const psRawLines = get("psraw");

  return {
    osName: os.PRETTY_NAME ?? os.NAME ?? null,
    osId: os.ID ?? null,
    distro: distroFromOs(os),
    kernel: first("kernel"),
    host: first("host"),
    user: first("user"),
    uptimeSecs: up ? num(up.split(/\s+/)[0]) : null,
    load: loadParts && loadParts.length >= 3 ? [num(loadParts[0]), num(loadParts[1]), num(loadParts[2])] : null,
    cpus: cpus && /^\d+$/.test(cpus) ? Number(cpus) : null,
    cpuModel: first("cpumodel"),
    mem: parseMem(get("mem")),
    disks: parseDisks(get("disks")),
    topCpu,
    topMem: parsePs(get("pmem")),
    psRaw: topCpu.length === 0 && psRawLines.length ? psRawLines.join("\n") : null,
    failed: failedLines[0] === "#NA" ? null : failedLines.filter((l) => l.trim()).map((l) => l.trim().split(/\s+/)[0]),
    ports: ports.rows,
    portsNote: ports.note,
    containers: parseContainers(get("containers")),
    journal,
    incomplete: incomplete || !s.has("end"),
  };
}

export function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
