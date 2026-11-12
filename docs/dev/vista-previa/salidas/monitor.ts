// Salidas del Monitor (features/monitor/sample.ts): /proc/stat, meminfo, loadavg, uptime, net/dev, procesos
// y df, como un servidor de 4 CPU y 8 GB con Docker. Los contadores avanzan con el tiempo real, así
// el % de CPU y la red por segundo salen de las diferencias igual que en un servidor de verdad.
// Las mismas curvas (`modelo`) sirven para sembrar los 5 minutos anteriores de historia (escenas/monitor.ts).
import type { Rule } from "../salidas";
import { liveStats } from "./contenedores";

export const NPROC = 4;
const HZ = 100;
const PAGE = 4096;
const MEM_TOTAL_KB = 8_052_904;
const SWAP_TOTAL_KB = 2_097_148;

/** Ruido determinista en [-1, 1] para un número entero. */
function noise(k: number): number {
  let h = (k * 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

/** Ruido suave (interpolado) con periodo `ms`. */
function smooth(t: number, ms: number, seed: number): number {
  const x = t / ms;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return noise(i * 31 + seed) * (1 - s) + noise((i + 1) * 31 + seed) * s;
}

/** Curvas del servidor en el instante `t` (ms). */
export const modelo = {
  cpu(t: number): number {
    const k = Math.floor(t / 2000);
    // Un trabajo pesado cada 75 s durante ~12 s (p. ej. la API generando un informe).
    const ph = (t / 1000) % 75;
    const burst = ph < 12 ? 30 * Math.sin((ph / 12) * Math.PI) : 0;
    const v = 23 + 8 * smooth(t, 25000, 1) + 5 * smooth(t, 6000, 2) + 2.5 * noise(k) + burst;
    return Math.min(97, Math.max(3, v));
  },
  mem(t: number): number {
    const ph = (t / 1000) % 75;
    return 61 + 2.5 * smooth(t, 60000, 3) + 0.3 * noise(Math.floor(t / 2000) + 7) + (ph < 14 ? 2.4 * Math.sin((ph / 14) * Math.PI) : 0);
  },
  rx(t: number): number {
    const k = Math.floor(t / 2000);
    const ph = (t / 1000) % 47;
    const burst = ph < 6 ? 650_000 * Math.sin((ph / 6) * Math.PI) : 0;
    return Math.max(8_000, 260_000 + 140_000 * smooth(t, 18000, 4) + 45_000 * noise(k + 11) + burst);
  },
  tx(t: number): number {
    const k = Math.floor(t / 2000);
    const ph = (t / 1000) % 75;
    const burst = ph < 12 ? 1_100_000 * Math.sin((ph / 12) * Math.PI) : 0;
    return Math.max(10_000, 600_000 + 250_000 * smooth(t, 15000, 5) + 70_000 * noise(k + 23) + burst);
  },
  load(t: number): number {
    // Media exponencial de ~1 min de la CPU (aprox.).
    let acc = 0;
    let w = 0;
    for (let s = 0; s < 60; s += 4) {
      const wt = Math.exp(-s / 60);
      acc += (modelo.cpu(t - s * 1000) / 100) * NPROC * wt;
      w += wt;
    }
    return Math.max(0.05, (acc / w) * 1.15 + 0.12 * noise(Math.floor(t / 2000) + 41));
  },
};

// ───────── Procesos ─────────

interface FakeProc {
  pid: number;
  ppid: number;
  comm: string;
  uid: number;
  /** Parte del uso total de CPU que se lleva. */
  share: number;
  rssKb: number;
  /** Segundos desde el arranque del servidor en que empezó. */
  startS: number;
}

const BOOT_AGO_S = 12 * 86400 + 5 * 3600 + 17 * 60; // encendido hace 12 días
const C = BOOT_AGO_S - 3 * 86400 - 2 * 3600; // contenedores arrancados hace ~3 días

const PROCS: FakeProc[] = [
  { pid: 1, ppid: 0, comm: "systemd", uid: 0, share: 0.004, rssKb: 13_120, startS: 1 },
  { pid: 412, ppid: 1, comm: "systemd-journal", uid: 0, share: 0.003, rssKb: 48_200, startS: 3 },
  { pid: 688, ppid: 1, comm: "rsyslogd", uid: 104, share: 0.002, rssKb: 6_400, startS: 6 },
  { pid: 702, ppid: 1, comm: "cron", uid: 0, share: 0.0, rssKb: 2_800, startS: 6 },
  { pid: 731, ppid: 1, comm: "sshd", uid: 0, share: 0.001, rssKb: 9_100, startS: 7 },
  { pid: 812, ppid: 1, comm: "containerd", uid: 0, share: 0.03, rssKb: 52_300, startS: 8 },
  { pid: 958, ppid: 1, comm: "dockerd", uid: 0, share: 0.05, rssKb: 98_700, startS: 9 },
  { pid: 2210, ppid: 1, comm: "containerd-shim", uid: 0, share: 0.006, rssKb: 12_400, startS: C },
  { pid: 2244, ppid: 2210, comm: "nginx", uid: 0, share: 0.002, rssKb: 7_900, startS: C + 2 },
  { pid: 2301, ppid: 2244, comm: "nginx", uid: 101, share: 0.03, rssKb: 9_800, startS: C + 2 },
  { pid: 2302, ppid: 2244, comm: "nginx", uid: 101, share: 0.025, rssKb: 9_600, startS: C + 2 },
  { pid: 2390, ppid: 1, comm: "containerd-shim", uid: 0, share: 0.005, rssKb: 12_100, startS: C + 1 },
  { pid: 2415, ppid: 2390, comm: "postgres", uid: 70, share: 0.04, rssKb: 61_400, startS: C + 3 },
  { pid: 2502, ppid: 2415, comm: "postgres", uid: 70, share: 0.11, rssKb: 148_900, startS: C + 5 },
  { pid: 2503, ppid: 2415, comm: "postgres", uid: 70, share: 0.07, rssKb: 96_300, startS: C + 5 },
  { pid: 2504, ppid: 2415, comm: "postgres", uid: 70, share: 0.02, rssKb: 22_700, startS: C + 5 },
  { pid: 2560, ppid: 1, comm: "containerd-shim", uid: 0, share: 0.004, rssKb: 11_900, startS: C + 1 },
  { pid: 2588, ppid: 2560, comm: "redis-server", uid: 999, share: 0.045, rssKb: 21_800, startS: C + 3 },
  { pid: 2640, ppid: 1, comm: "containerd-shim", uid: 0, share: 0.005, rssKb: 12_000, startS: C + 1 },
  { pid: 2671, ppid: 2640, comm: "node", uid: 1000, share: 0.42, rssKb: 190_900, startS: C + 8 },
  { pid: 31877, ppid: 1, comm: "containerd-shim", uid: 0, share: 0.002, rssKb: 11_800, startS: BOOT_AGO_S - 5 * 3600 },
  { pid: 31902, ppid: 31877, comm: "php", uid: 1000, share: 0.003, rssKb: 10_100, startS: BOOT_AGO_S - 5 * 3600 + 2 },
  { pid: 40112, ppid: 731, comm: "sshd", uid: 1000, share: 0.006, rssKb: 7_300, startS: BOOT_AGO_S - 1500 },
  { pid: 40130, ppid: 1, comm: "tmux: server", uid: 1000, share: 0.004, rssKb: 4_600, startS: BOOT_AGO_S - 1490 },
  { pid: 40131, ppid: 40130, comm: "bash", uid: 1000, share: 0.0, rssKb: 5_200, startS: BOOT_AGO_S - 1489 },
  { pid: 40388, ppid: 40131, comm: "htop", uid: 1000, share: 0.012, rssKb: 4_900, startS: BOOT_AGO_S - 600 },
];

const PASSWD = [
  "root:0",
  "daemon:1",
  "bin:2",
  "www-data:33",
  "nobody:65534",
  "systemd-network:998",
  "syslog:104",
  "sshd:105",
  "ana:1000",
  "deploy:1001",
];

// ───────── Estado de los contadores ─────────

const st = {
  started: Date.now(),
  last: 0,
  total: 0,
  idle: 0,
  iowait: 0,
  rx: 48_211_903_112,
  tx: 131_904_552_870,
  dockerRx: 3_118_004_221,
  dockerTx: 2_901_334_870,
  ticks: new Map<number, number>(PROCS.map((p) => [p.pid, Math.round(p.share * 0.2 * NPROC * HZ * (BOOT_AGO_S - p.startS))])),
};
// Valores de arranque coherentes con 12 días encendido y ~20 % de CPU media.
st.total = BOOT_AGO_S * HZ * NPROC;
st.idle = Math.round(st.total * 0.8);
st.iowait = Math.round(st.total * 0.01);

function advance(now: number) {
  const dt = st.last ? Math.max(0.2, (now - st.last) / 1000) : 2;
  st.last = now;
  const cpu = modelo.cpu(now) / 100;
  const dTotal = dt * HZ * NPROC;
  const busy = dTotal * cpu;
  const io = dTotal * (0.006 + 0.004 * Math.abs(noise(Math.floor(now / 2000) + 77)));
  st.total += dTotal;
  st.idle += dTotal - busy;
  st.iowait += io;
  st.rx += modelo.rx(now) * dt;
  st.tx += modelo.tx(now) * dt;
  st.dockerRx += modelo.tx(now) * 0.35 * dt;
  st.dockerTx += modelo.rx(now) * 0.3 * dt;
  for (const p of PROCS) {
    const cores = busy / HZ / dt; // núcleos ocupados
    const v = p.share * cores * (1 + 0.25 * noise(Math.floor(now / 2000) + p.pid));
    st.ticks.set(p.pid, (st.ticks.get(p.pid) ?? 0) + Math.max(0, v * HZ * dt));
  }
}

function sample(): string {
  const now = Date.now();
  advance(now);
  const uptime = BOOT_AGO_S + (now - st.started) / 1000;
  const memPct = modelo.mem(now) / 100;
  const avail = Math.round(MEM_TOTAL_KB * (1 - memPct));
  const cached = 2_604_380 + Math.round(40_000 * noise(Math.floor(now / 10000)));
  const free = Math.max(120_000, avail - cached - 212_000);
  const load1 = modelo.load(now);
  const load5 = Math.max(0.1, modelo.load(now - 120_000) * 0.6 + modelo.load(now - 30_000) * 0.4);
  const load15 = 0.78;
  const i = (n: number) => Math.round(n);
  const user = i((st.total - st.idle) * 0.72);
  const system = i((st.total - st.idle) * 0.24);
  const softirq = i((st.total - st.idle) - user - system);
  const out: string[] = [
    "@@begin",
    "@@self=48211",
    "@@stat",
    `cpu  ${user} 1204 ${system} ${i(st.idle - st.iowait)} ${i(st.iowait)} 0 ${softirq} 0 0 0`,
    "@@mem",
    `MemTotal:        ${MEM_TOTAL_KB} kB`,
    `MemFree:         ${free} kB`,
    `MemAvailable:    ${avail} kB`,
    "Buffers:          212044 kB",
    `Cached:          ${cached - 180_000} kB`,
    "SwapCached:         1204 kB",
    "SReclaimable:     180000 kB",
    `SwapTotal:       ${SWAP_TOTAL_KB} kB`,
    "SwapFree:        2031612 kB",
    "@@load",
    `${load1.toFixed(2)} ${load5.toFixed(2)} ${load15.toFixed(2)} ${1 + (noise(Math.floor(now / 2000)) > 0.3 ? 1 : 0)}/412 48211`,
    "@@up",
    `${uptime.toFixed(2)} ${(uptime * NPROC * 0.8).toFixed(2)}`,
    "@@net",
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    `    lo: 912004871 2210457 0 0 0 0 0 0 912004871 2210457 0 0 0 0 0 0`,
    `  eth0: ${i(st.rx)} 61204883 0 12 0 0 0 0 ${i(st.tx)} 70211456 0 0 0 0 0 0`,
    `docker0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`,
    `br-4f1c2a9d7e11: ${i(st.dockerRx)} 8120443 0 0 0 0 0 0 ${i(st.dockerTx)} 7904112 0 0 0 0 0 0`,
    `veth3a91c2f: ${i(st.dockerTx * 0.6)} 4120044 0 0 0 0 0 0 ${i(st.dockerRx * 0.6)} 3994112 0 0 0 0 0 0`,
    "@@info",
    `nproc=${NPROC}`,
    "user=ana",
    "uid=1000",
    `page=${PAGE}`,
    `hz=${HZ}`,
    "docker=1",
    "@@passwd",
    ...PASSWD,
    "@@ps",
  ];
  const psx: string[] = [];
  for (const p of PROCS) {
    const ticks = i(st.ticks.get(p.pid) ?? 0);
    const ut = i(ticks * 0.8);
    const stt = ticks - ut;
    const rss = i((p.rssKb * (1 + 0.01 * noise(Math.floor(now / 4000) + p.pid))) / 4);
    const start = i(p.startS * HZ);
    const state = p.share > 0.1 && noise(Math.floor(now / 2000) + p.pid) > 0 ? "R" : "S";
    if (p.comm.includes(" ")) {
      // Línea completa de /proc/[pid]/stat (campos 3…24).
      const f = [state, p.ppid, p.pid, p.pid, 0, -1, 4194560, 1200, 0, 0, 0, ut, stt, 0, 0, 20, 0, 1, 0, start, 12_000_000, rss];
      psx.push(`${p.pid} (${p.comm}) ${f.join(" ")}`);
    } else {
      out.push(`${p.pid} (${p.comm}) ${state} ${p.ppid} ${ut} ${stt} ${start} ${rss}`);
    }
  }
  out.push("@@psx", ...psx);
  out.push("@@uid", ...PROCS.map((p) => `${p.uid} /proc/${p.pid}`));
  out.push(
    "@@df",
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "tmpfs               805292      1840    803452       1% /run",
    "/dev/sda2         61611820  37012044  21436720      64% /",
    "tmpfs              4026452         0   4026452       0% /dev/shm",
    "/dev/sda1           999320    262144    668364      29% /boot",
    "/dev/sdb1        103081248  87404120  10418516      90% /var/lib/docker",
    "/dev/sdc1        206293688  71004812 124787500      37% /srv",
    "overlay           103081248  87404120  10418516      90% /var/lib/docker/overlay2/9c4e1f0a/merged",
    "tmpfs               805288        12    805276       1% /run/user/1000",
    "@@end",
  );
  return out.join("\n") + "\n";
}

const STATS_FMT = /stats --no-stream --format "\{\{\.ID\}\}\|/;

function containerStats(): string {
  const lines = liveStats().map(
    (s) => `${s.id}|${s.c.name}|${s.cpu}|${s.memUsage}|${s.memPerc}|${s.c.netIO}|${s.c.blockIO}`,
  );
  return ["@@engine=docker", ...lines, "@@end", ""].join("\n");
}

export const reglas: Rule[] = [
  [/echo @@stat; grep "\^cpu " \/proc\/stat/, sample],
  [STATS_FMT, containerStats],
];
