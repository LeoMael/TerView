// Lectura del estado del servidor (usuarios, grupos, sesiones): scripts de solo lectura y su parseo.
// Funciones puras: sin React ni Tauri.

/** Herramientas que se buscan en el servidor. */
export const PROBED_TOOLS = [
  "useradd",
  "usermod",
  "userdel",
  "groupadd",
  "groupdel",
  "groupmod",
  "gpasswd",
  "chpasswd",
  "chage",
  "passwd",
  "adduser",
  "deluser",
  "addgroup",
  "delgroup",
  "pkill",
  "loginctl",
  "lastlog",
  "lastlog2",
  "sudo",
  "doas",
] as const;

/**
 * Script de lectura como usuario normal (sin privilegios). Secciones `@@nombre` seguidas de su salida.
 * Se ejecuta con `sh` (ver run.ts), no con el shell de login.
 */
export const READ_SCRIPT = [
  "echo @@me; id -un 2>/dev/null",
  "echo @@passwd; getent passwd 2>/dev/null || cat /etc/passwd",
  "echo @@group; getent group 2>/dev/null || cat /etc/group",
  "echo @@shells; cat /etc/shells 2>/dev/null",
  "echo @@who; LC_ALL=C who 2>/dev/null",
  `echo @@tools; for t in ${PROBED_TOOLS.join(" ")}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done`,
  // pkill de procps entiende -t (terminal); el de busybox no.
  "pkill -V >/dev/null 2>&1 && echo pkill-procps",
  "ps --help 2>&1 | grep -qi busybox && echo busybox-ps",
  "echo @@lastlog; { LC_ALL=C lastlog2 2>/dev/null || LC_ALL=C lastlog 2>/dev/null; } | head -n 5000",
  "echo @@end",
].join("\n");

/**
 * Script con privilegios: estado de las contraseñas desde /etc/shadow SIN sacar los hashes
 * (solo L = bloqueada, NP = sin contraseña, NL = sin acceso por contraseña, P = normal) y fechas.
 */
export const SHADOW_SCRIPT = [
  "echo @@shadow",
  `awk -F: '{ s = "P"; if ($2 ~ /^!/) s = "L"; else if ($2 == "") s = "NP"; else if ($2 ~ /^[*]/) s = "NL"; print $1 ":" s ":" $3 ":" $5 ":" $8 }' /etc/shadow`,
  "echo @@end",
].join("\n");

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  /** Nombre completo (primer subcampo de GECOS). */
  fullName: string;
  home: string;
  shell: string;
}

export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
}

export type ShadowStatus = "P" | "L" | "NP" | "NL";

export interface ShadowEntry {
  name: string;
  status: ShadowStatus;
  /** Días desde 1970 del último cambio; 0 = debe cambiarla en el próximo inicio. null si vacío. */
  lastChange: number | null;
  maxDays: number | null;
  /** Días desde 1970 en que caduca la cuenta. null = nunca. */
  expireDays: number | null;
}

export interface WhoEntry {
  user: string;
  tty: string;
  /** Inicio de la sesión, tal como lo da `who`. */
  since: string;
  /** Origen (IP o nombre), si lo hay. */
  from: string;
}

export interface ReadResult {
  me: string | null;
  passwd: PasswdEntry[];
  groups: GroupEntry[];
  shells: string[];
  who: WhoEntry[];
  tools: Set<string>;
  /** Último acceso por usuario (texto ya legible), si lastlog existe. */
  lastLogin: Map<string, string>;
}

/** Separa la salida en secciones `@@nombre`. */
export function splitSections(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^@@([a-z]+)$/.exec(line);
    if (m) {
      cur = [];
      out.set(m[1], cur);
      continue;
    }
    if (cur && line !== "") cur.push(line);
  }
  return out;
}

function int(s: string | undefined): number | null {
  return s !== undefined && /^-?\d+$/.test(s) ? Number(s) : null;
}

export function parsePasswd(lines: string[]): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const f = l.split(":");
    if (f.length < 7) continue;
    const uid = int(f[2]);
    const gid = int(f[3]);
    if (uid === null || gid === null || !f[0] || seen.has(f[0])) continue;
    seen.add(f[0]);
    out.push({
      name: f[0],
      uid,
      gid,
      gecos: f[4],
      fullName: f[4].split(",")[0] ?? "",
      home: f[5],
      shell: f.slice(6).join(":"),
    });
  }
  return out;
}

export function parseGroups(lines: string[]): GroupEntry[] {
  const out: GroupEntry[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const f = l.split(":");
    if (f.length < 4) continue;
    const gid = int(f[2]);
    if (gid === null || !f[0] || seen.has(f[0])) continue;
    seen.add(f[0]);
    out.push({ name: f[0], gid, members: f[3].split(",").map((m) => m.trim()).filter(Boolean) });
  }
  return out;
}

export function parseShadow(lines: string[]): Map<string, ShadowEntry> {
  const out = new Map<string, ShadowEntry>();
  for (const l of lines) {
    const f = l.split(":");
    if (f.length < 5 || !["P", "L", "NP", "NL"].includes(f[1])) continue;
    const exp = int(f[4]);
    out.set(f[0], {
      name: f[0],
      status: f[1] as ShadowStatus,
      lastChange: int(f[2]),
      maxDays: int(f[3]),
      expireDays: exp !== null && exp >= 0 ? exp : null,
    });
  }
  return out;
}

export function parseShells(lines: string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("/") && !/\s/.test(t)) out.add(t);
  }
  return [...out];
}

/** `who` de coreutils («user pts/0 2026-11-11 20:22 (10.0.0.1)») o de busybox (con cabecera USER TTY …). */
export function parseWho(lines: string[]): WhoEntry[] {
  const out: WhoEntry[] = [];
  // busybox: cabecera «USER TTY IDLE TIME HOST» y columnas user tty idle «Mmm dd hh:mm:ss» host.
  const busybox = lines.some((l) => /^USER\s+TTY\s+IDLE\b/.test(l));
  for (const l of lines) {
    if (/^USER\s+TTY\b/.test(l)) continue;
    const t = l.trim().split(/\s+/);
    if (t.length < 2) continue;
    const tty = t[1].replace(/^\/dev\//, "");
    if (busybox) {
      out.push({ user: t[0], tty, since: t.slice(3, 6).join(" "), from: t.slice(6).join(" ") });
      continue;
    }
    let rest = t.slice(2).join(" ");
    let from = "";
    const m = /\(([^)]*)\)\s*$/.exec(rest);
    if (m) {
      from = m[1];
      rest = rest.slice(0, m.index).trim();
    }
    out.push({ user: t[0], tty, since: rest, from });
  }
  return out;
}

const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

/** «Tue Nov 11 20:22:00 +0000 2025» → «11/11/2025 20:22» (hora local). Si no se entiende, devuelve el texto. */
export function formatLastlogDate(s: string): string {
  const m = /^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d) (\d{4})$/.exec(s.trim());
  if (!m || !MONTHS[m[1]]) return s.trim();
  const iso = `${m[9]}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}T${m[3]}:${m[4]}:${m[5]}${m[6]}${m[7]}:${m[8]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return s.trim();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Salida de `lastlog`/`lastlog2` (LC_ALL=C): la columna «Latest» empieza donde dice la cabecera. */
export function parseLastlog(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const header = lines[0] ?? "";
  const col = header.indexOf("Latest");
  if (!/^Username\b/.test(header) || col < 0) return out;
  for (const l of lines.slice(1)) {
    const name = l.split(/\s+/)[0];
    if (!name) continue;
    const latest = l.length > col ? l.slice(col).trim() : "";
    if (!latest) continue;
    out.set(name, /never/i.test(latest) ? "Nunca" : formatLastlogDate(latest));
  }
  return out;
}

export function parseRead(stdout: string): ReadResult {
  const s = splitSections(stdout);
  if (!s.has("end")) throw new Error("La lectura del servidor quedó incompleta");
  const tools = new Set(s.get("tools") ?? []);
  return {
    me: s.get("me")?.[0]?.trim() || null,
    passwd: parsePasswd(s.get("passwd") ?? []),
    groups: parseGroups(s.get("group") ?? []),
    shells: parseShells(s.get("shells") ?? []),
    who: parseWho(s.get("who") ?? []),
    tools,
    lastLogin: parseLastlog(s.get("lastlog") ?? []),
  };
}

export function parseShadowOutput(stdout: string): Map<string, ShadowEntry> {
  const s = splitSections(stdout);
  if (!s.has("end")) throw new Error("No se pudo leer /etc/shadow");
  return parseShadow(s.get("shadow") ?? []);
}

/** Días desde 1970 → «AAAA-MM-DD». */
export function daysToDate(days: number): string {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

// ───────── Vista combinada ─────────

/** Grupos que dan permisos de administración (sudo/doas) por convención. */
export const ADMIN_GROUP_NAMES = ["wheel", "sudo", "admin"];

export interface UserRow extends PasswdEntry {
  /** Grupo principal + suplementarios (nombres). */
  groups: string[];
  /** Solo los suplementarios (los que se pueden quitar). */
  extraGroups: string[];
  primaryGroup: string | null;
  isSystem: boolean;
  isAdmin: boolean;
  /** null = no se sabe (sin privilegios para leer /etc/shadow). */
  locked: boolean | null;
  shadow: ShadowEntry | null;
  lastLogin: string | null;
}

/** Límite UID de cuentas de personas (UID_MIN por defecto en login.defs). */
export const UID_MIN = 1000;

export function isSystemUid(uid: number): boolean {
  // 65534 = nobody (UID ≥ 1000 pero es del sistema).
  return (uid !== 0 && uid < UID_MIN) || uid === 65534;
}

export function buildUserRows(read: ReadResult, shadow: Map<string, ShadowEntry> | null): UserRow[] {
  const byGid = new Map(read.groups.map((g) => [g.gid, g.name]));
  const memberOf = new Map<string, string[]>();
  for (const g of read.groups) {
    for (const m of g.members) {
      const list = memberOf.get(m) ?? [];
      list.push(g.name);
      memberOf.set(m, list);
    }
  }
  return read.passwd.map((p) => {
    const primaryGroup = byGid.get(p.gid) ?? null;
    const extra = (memberOf.get(p.name) ?? []).filter((g) => g !== primaryGroup);
    const groups = primaryGroup ? [primaryGroup, ...extra] : extra;
    const sh = shadow?.get(p.name) ?? null;
    return {
      ...p,
      groups,
      extraGroups: extra,
      primaryGroup,
      isSystem: isSystemUid(p.uid),
      isAdmin: p.uid === 0 || groups.some((g) => ADMIN_GROUP_NAMES.includes(g)),
      locked: shadow ? (sh ? sh.status === "L" : null) : null,
      shadow: sh,
      lastLogin: read.lastLogin.get(p.name) ?? null,
    };
  });
}

/** Grupos del sistema: GID < 1000 (salvo los de administración, que interesan siempre) o nogroup. */
export function isSystemGroup(g: GroupEntry): boolean {
  if (ADMIN_GROUP_NAMES.includes(g.name)) return false;
  return g.gid < UID_MIN || g.gid === 65534;
}
