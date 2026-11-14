// Mapa de infraestructura: lectura extra del servidor (sistema, direcciones, cortafuegos, usuarios y
// conexiones TCP establecidas) y su parseo. Funciones puras, sin React ni Tauri. Solo lectura.
import { splitSections } from "../admin/parse";
import { parseAddr } from "../admin/ports";

/**
 * Script de lectura. Secciones: @@os (PRETTY_NAME) · @@host (hostname) · @@addrs (IPs del equipo) ·
 * @@fw («herramienta estado») · @@humans («usuario|uid» con uid ≥ 1000) · @@est (`ss -tnp` establecidas) ·
 * @@usvc («unidad» de `systemctl --user` del usuario conectado).
 */
export const INFRA_SCRIPT = [
  "PATH=$PATH:/usr/sbin:/sbin:/usr/local/sbin",
  "echo @@os; ( . /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" ) || uname -sr",
  "echo @@host; hostname 2>/dev/null || cat /etc/hostname 2>/dev/null",
  "echo @@addrs",
  "if command -v ip >/dev/null 2>&1; then ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1;",
  "else hostname -I 2>/dev/null | tr ' ' '\\n'; fi",
  "echo @@fw",
  "if command -v ufw >/dev/null 2>&1; then s=$(ufw status 2>/dev/null | head -n1 | awk '{print $2}'); [ -n \"$s\" ] && echo \"ufw $s\"; fi",
  "if command -v firewall-cmd >/dev/null 2>&1; then echo \"firewalld $(firewall-cmd --state 2>/dev/null || echo desconocido)\"; fi",
  "if command -v nft >/dev/null 2>&1; then n=$(nft list ruleset 2>/dev/null | grep -c 'chain '); [ \"$n\" -gt 0 ] 2>/dev/null && echo \"nftables $n\"; fi",
  "echo @@humans",
  "getent passwd 2>/dev/null | awk -F: '$3>=1000 && $3<60000 {print $1\"|\"$3\"|\"$6}' | while IFS='|' read -r n u h; do",
  "  r=0; [ -d /run/user/$u ] && r=1; echo \"$n|$u|$h|$r\"",
  "done",
  "echo @@est",
  "if command -v ss >/dev/null 2>&1; then ss -tnpH state established 2>/dev/null || ss -tnH state established 2>/dev/null; fi",
  "echo @@usvc",
  "systemctl --user list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}'",
  "echo @@end",
].join("\n");

/** Servicios `systemctl --user` en marcha (se lanza como cada usuario). */
export const USER_SERVICES_SCRIPT =
  "systemctl --user list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}'; true";

export interface Firewall {
  tool: "ufw" | "firewalld" | "nftables";
  /** active / inactive / running / not running / nº de cadenas (nftables). */
  state: string;
  active: boolean;
}

/** Conexión TCP establecida (`ss -tnp state established`). */
export interface EstConn {
  localIp: string;
  localPort: number;
  peerIp: string;
  peerPort: number;
  proc: string | null;
  pid: number | null;
}

export interface HumanUser {
  name: string;
  uid: number;
  home: string;
  /** Tiene /run/user/<uid> (sesión abierta o lingering): se pueden leer sus servicios de usuario. */
  runtimeDir: boolean;
}

export interface InfraExtra {
  os: string | null;
  hostname: string | null;
  addrs: string[];
  firewall: Firewall[];
  /** Usuarios de personas (uid ≥ 1000). */
  humans: Map<string, HumanUser>;
  established: EstConn[];
  /** Servicios de usuario del conectado. */
  userServices: string[];
}

/**
 * Una línea de `ss -tn[p]` (con o sin cabecera y columna de estado):
 * «0 0 10.0.0.5:51234 10.0.0.9:5432 users:(("node",pid=812,fd=21))».
 */
export function parseEstLine(line: string): EstConn | null {
  const t = line.trim().split(/\s+/);
  if (t.length < 4 || t[0] === "Recv-Q" || t[0] === "State") return null;
  let i = 0;
  if (!/^\d+$/.test(t[0])) i = 1; // «ESTAB 0 0 …»
  const local = t[i + 2];
  const peer = t[i + 3];
  if (!local || !peer) return null;
  const a = parseAddr(local);
  const b = parseAddr(peer);
  if (!a || !b) return null;
  const rest = t.slice(i + 4).join(" ");
  const m = /\(\("([^"]+)",pid=(\d+)/.exec(rest);
  return {
    localIp: unmap(a.ip),
    localPort: a.port,
    peerIp: unmap(b.ip),
    peerPort: b.port,
    proc: m ? m[1] : null,
    pid: m ? Number(m[2]) : null,
  };
}

/** «::ffff:10.0.0.9» → «10.0.0.9». */
export function unmap(ip: string): string {
  return ip.replace(/^::ffff:/i, "");
}

export function parseEstablished(lines: string[]): EstConn[] {
  return lines.map(parseEstLine).filter((c): c is EstConn => c !== null);
}

export function parseFirewall(lines: string[]): Firewall[] {
  const out: Firewall[] = [];
  for (const l of lines) {
    const [tool, ...r] = l.trim().split(/\s+/);
    const state = r.join(" ");
    if (tool === "ufw") out.push({ tool, state, active: state === "active" });
    else if (tool === "firewalld") out.push({ tool, state, active: state === "running" });
    else if (tool === "nftables") out.push({ tool, state: `${state} cadenas`, active: Number(state) > 0 });
  }
  return out;
}

export function parseInfra(stdout: string): InfraExtra {
  const s = splitSections(stdout);
  const humans = new Map<string, HumanUser>();
  for (const l of s.get("humans") ?? []) {
    const [n, u, home = "", r = "0"] = l.split("|");
    if (n && /^\d+$/.test(u ?? "")) humans.set(n, { name: n, uid: Number(u), home, runtimeDir: r === "1" });
  }
  const addrs = (s.get("addrs") ?? []).map((x) => x.trim()).filter((x) => x && x !== "127.0.0.1" && x !== "::1");
  return {
    os: (s.get("os") ?? [])[0]?.trim() || null,
    hostname: (s.get("host") ?? [])[0]?.trim() || null,
    addrs: [...new Set(addrs)],
    firewall: parseFirewall(s.get("fw") ?? []),
    humans,
    established: parseEstablished(s.get("est") ?? []),
    userServices: parseUnits(s.get("usvc") ?? []),
  };
}

export function parseUnits(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => /^[\w@.:-]+\.service$/.test(l));
}
