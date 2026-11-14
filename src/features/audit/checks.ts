// Comprobaciones de la auditoría: de la salida de AUDIT_SCRIPT (+ Puertos, Sitios web y el último informe
// del escáner) a una lista de resultados bien / aviso / mal con su explicación y su arreglo.
// Funciones puras (sin React ni Tauri): se prueban en audit.test.ts con salidas de Rocky, Debian y Alpine.
//
// Regla de privacidad: `detail` no lleva nombres de usuario, direcciones ni rutas de casa (va a la IA);
// todo eso va en `items`, que solo se ve en este equipo.
import type { Check, CheckStatus, Fix } from "../../api/audit";
import type { Summary } from "../../api/vulnscan";
import { splitSections } from "../admin/parse";
import { shQuote } from "../admin/shell";
import type { PortsResult } from "../admin/ports";
import { certStatus, type WebResult } from "../admin/web";

export interface AuditInput {
  /** Salida de AUDIT_SCRIPT. */
  stdout: string;
  /** Se leyó como root. */
  elevated: boolean;
  ports: PortsResult | null;
  web: WebResult | null;
  /** Último informe del escáner (null = nunca se analizó). */
  vuln: { createdAt: string; summary: Summary } | null;
  now: number;
}

type Family = "rhel" | "fedora" | "debian" | "alpine" | "suse" | "other";

/** Lo que varias comprobaciones necesitan saber del servidor. */
export interface AuditCtx {
  sec: Map<string, string[]>;
  uid: number | null;
  user: string;
  groups: string[];
  os: { id: string; like: string[]; name: string };
  family: Family;
  elevated: boolean;
  sshPort: number;
  passwordAuth: boolean | null;
}

const NEEDS_SUDO = "Sin comprobar: necesita sudo";

function lines(ctx: Pick<AuditCtx, "sec">, k: string): string[] {
  return ctx.sec.get(k) ?? [];
}

function noread(ctx: Pick<AuditCtx, "sec">, k: string): boolean {
  return lines(ctx, k).includes("@noread");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function check(
  id: string,
  category: Check["category"],
  title: string,
  status: CheckStatus,
  detail: string,
  extra: Partial<Pick<Check, "items" | "fix" | "weight">> = {},
): Check {
  return { id, category, title, status, detail, items: extra.items ?? [], fix: extra.fix ?? null, weight: extra.weight ?? 1 };
}

function fix(command: string, opts: Partial<Omit<Fix, "command">> = {}): Fix {
  return { command, danger: opts.danger ?? false, manual: opts.manual ?? false, note: opts.note ?? null };
}

export function familyOf(id: string, like: string[]): Family {
  const all = [id, ...like];
  if (id === "fedora") return "fedora";
  if (all.some((x) => ["rhel", "centos", "rocky", "almalinux", "ol", "amzn"].includes(x))) return "rhel";
  if (all.some((x) => ["debian", "ubuntu"].includes(x))) return "debian";
  if (id === "alpine") return "alpine";
  if (all.some((x) => x.includes("suse"))) return "suse";
  return "other";
}

// ───────── SSH ─────────

export interface SshdConfig {
  /** De dónde salió: sshd -T (efectiva), los archivos, o nada legible. */
  source: "sshd" | "files" | "none";
  values: Record<string, string>;
  /** sshd_config incluye sshd_config.d (se puede poner un archivo aparte). */
  include: boolean;
}

export function parseSshd(sec: Map<string, string[]>): SshdConfig {
  const values: Record<string, string> = {};
  const fromT = (sec.get("sshdsrc") ?? [])[0] === "T";
  if (fromT) {
    for (const l of sec.get("sshd") ?? []) {
      const m = /^(\S+)\s+(.*)$/.exec(l.trim());
      if (m) values[m[1].toLowerCase()] = m[2].trim().toLowerCase();
    }
  } else {
    // «archivo:  Clave valor». sshd usa el PRIMER valor que encuentra (los .d van antes en el orden del script).
    for (const l of sec.get("sshdcfg") ?? []) {
      if (l === "@noread") continue;
      const m = /^[^:]+:\s*(\S+)\s+(\S+)/.exec(l);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (!(k in values)) values[k] = m[2].toLowerCase();
    }
  }
  const cfgLines = sec.get("sshdcfg") ?? [];
  const unreadable = cfgLines.includes("@noread") || cfgLines.includes("@nofile");
  const source: SshdConfig["source"] = fromT ? "sshd" : Object.keys(values).length > 0 || (sec.has("sshdcfg") && !unreadable) ? "files" : "none";
  const include = Number((sec.get("sshinc") ?? [])[0] ?? "0") > 0;
  return { source, values, include };
}

/** Comando para fijar opciones de sshd con comprobación (`sshd -t`) y recarga. */
export function sshdFixCommand(settings: [string, string][], include: boolean): string {
  const reload = "systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || rc-service sshd reload";
  if (include) {
    const f = "/etc/ssh/sshd_config.d/00-sshorus.conf";
    return [
      `f=${f}`,
      'touch "$f" && chmod 600 "$f"',
      ...settings.map(([k, v]) => `sed -i '/^${k}[[:space:]]/d' "$f" && echo '${k} ${v}' >> "$f"`),
      `sshd -t || { rm -f "$f"; echo 'sshd -t falló: no se cambió nada' >&2; exit 1; }`,
      reload,
    ].join("\n");
  }
  // Sin sshd_config.d: al principio del archivo principal (gana el primer valor), con copia.
  const c = "/etc/ssh/sshd_config";
  return [
    `cp -p ${c} ${c}.sshorus.bak`,
    ...settings.map(([k, v]) => `sed -i '1i ${k} ${v}' ${c}`),
    `sshd -t || { cp -p ${c}.sshorus.bak ${c}; echo 'sshd -t falló: se dejó como estaba' >&2; exit 1; }`,
    reload,
  ].join("\n");
}

function sshChecks(ctx: AuditCtx): Check[] {
  const cfg = parseSshd(ctx.sec);
  const out: Check[] = [];
  if (cfg.source === "none") {
    out.push(check("ssh.root", "ssh", "Entrada de root por SSH", "skip", `${NEEDS_SUDO} (sshd -T)`, { weight: 3 }));
    out.push(check("ssh.password", "ssh", "Entrada con contraseña", "skip", `${NEEDS_SUDO} (sshd -T)`, { weight: 2 }));
  } else {
    const root = cfg.values.permitrootlogin ?? "prohibit-password";
    const rootFix = fix(sshdFixCommand([["PermitRootLogin", "no"]], cfg.include), {
      danger: true,
      note: ctx.uid === 0 ? "Te conectas como root: perderás el acceso por SSH" : "Antes, comprueba que entras con otro usuario con sudo",
    });
    if (root === "yes") {
      out.push(check("ssh.root", "ssh", "Entrada de root por SSH", "bad", "root puede entrar por SSH, también con contraseña", { weight: 3, fix: rootFix }));
    } else if (root === "prohibit-password" || root === "without-password") {
      out.push(check("ssh.root", "ssh", "Entrada de root por SSH", "warn", "root puede entrar por SSH con clave", { weight: 1, fix: rootFix }));
    } else {
      out.push(check("ssh.root", "ssh", "Entrada de root por SSH", "ok", "root no puede entrar por SSH", { weight: 3 }));
    }
    const pw = (cfg.values.passwordauthentication ?? "yes") === "yes";
    const empty = cfg.values.permitemptypasswords === "yes";
    ctx.passwordAuth = pw;
    const pwFix = fix(
      sshdFixCommand(
        [
          ["PasswordAuthentication", "no"],
          ["KbdInteractiveAuthentication", "no"],
          ...(empty ? ([["PermitEmptyPasswords", "no"]] as [string, string][]) : []),
        ],
        cfg.include,
      ),
      { danger: true, note: "Antes, comprueba que entras con clave: si no, perderás el acceso" },
    );
    if (empty) out.push(check("ssh.password", "ssh", "Entrada con contraseña", "bad", "Se permite entrar con contraseña vacía", { weight: 3, fix: pwFix }));
    else if (pw) out.push(check("ssh.password", "ssh", "Entrada con contraseña", "warn", "Se puede entrar con contraseña (mejor solo con clave)", { weight: 2, fix: pwFix }));
    else out.push(check("ssh.password", "ssh", "Entrada con contraseña", "ok", "Solo se entra con clave", { weight: 2 }));
    const port = Number(cfg.values.port);
    if (Number.isInteger(port) && port > 0) ctx.sshPort = port;
  }

  // Claves autorizadas: «usuario|n|modo|ruta» (n = «?» si no se pudo leer).
  const keys = lines(ctx, "keys").map((l) => l.split("|"));
  const seen = keys.filter((k) => k[1] !== "?" && Number(k[1]) > 0);
  const hidden = keys.filter((k) => k[1] === "?");
  const loose = keys.filter((k) => /^[0-7]{3,4}$/.test(k[2] ?? "") && (Number.parseInt(k[2], 8) & 0o022) !== 0);
  const total = seen.reduce((a, k) => a + Number(k[1]), 0);
  const items = seen.map((k) => `${k[0]}: ${plural(Number(k[1]), "clave", "claves")} (${k[3]})`);
  if (hidden.length && !ctx.elevated) items.push(`${plural(hidden.length, "usuario", "usuarios")} más sin poder leer (necesita sudo)`);
  if (loose.length) {
    out.push(
      check("ssh.keys", "ssh", "Claves autorizadas", "bad", "Hay archivos authorized_keys que otros pueden modificar", {
        weight: 2,
        items: [...loose.map((k) => `${k[3]} (permisos ${k[2]})`), ...items],
        fix: fix(`chmod 600 ${loose.map((k) => shQuote(k[3])).join(" ")}`),
      }),
    );
  } else {
    out.push(
      check(
        "ssh.keys",
        "ssh",
        "Claves autorizadas",
        "info",
        seen.length
          ? `${plural(seen.length, "usuario tiene", "usuarios tienen")} ${plural(total, "clave", "claves")} autorizada${total === 1 ? "" : "s"}: revisa que las reconoces`
          : hidden.length
            ? NEEDS_SUDO
            : "Ningún usuario tiene claves autorizadas",
        { items },
      ),
    );
  }
  return out;
}

// ───────── Usuarios ─────────

interface PasswdRow {
  name: string;
  uid: number;
  home: string;
  shell: string;
}

export function parsePasswdLines(ls: string[]): PasswdRow[] {
  return ls
    .map((l) => l.split(":"))
    .filter((p) => p.length >= 4 && /^\d+$/.test(p[1]))
    .map((p) => ({ name: p[0], uid: Number(p[1]), home: p[2], shell: p[3] }));
}

/** Usuarios que pueden usar sudo: grupos sudo/wheel/admin y reglas de sudoers con usuario. */
export function sudoUsers(groups: string[], sudoers: string[]): string[] {
  const out = new Set<string>();
  for (const g of groups) {
    const p = g.split(":");
    for (const m of (p[3] ?? "").split(",")) if (m.trim() && m.trim() !== "root") out.add(m.trim());
  }
  for (const l of sudoers) {
    if (l === "@noread" || l.startsWith("doas:")) continue;
    const m = /^([a-z_][a-z0-9_.-]*)\s+\S+\s*=/i.exec(l.trim());
    if (m && !["Defaults", "root"].includes(m[1]) && !/_Alias$/.test(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

function userChecks(ctx: AuditCtx): Check[] {
  const out: Check[] = [];
  const passwd = parsePasswdLines(lines(ctx, "passwd"));
  const sudoers = lines(ctx, "sudoers");
  const sudo = sudoUsers(lines(ctx, "groups"), sudoers);
  out.push(
    check("users.sudo", "users", "Usuarios con sudo", "info", sudo.length ? `${plural(sudo.length, "usuario puede", "usuarios pueden")} usar sudo` : "Nadie aparte de root usa sudo", {
      items: sudo,
    }),
  );

  if (noread(ctx, "sudoers")) {
    out.push(check("users.nopasswd", "users", "sudo sin contraseña", "skip", NEEDS_SUDO, { weight: 2 }));
  } else {
    const np = sudoers.filter((l) => /NOPASSWD\s*:/.test(l) || /^doas:\s*permit\s+nopass\b/.test(l));
    out.push(
      np.length
        ? check("users.nopasswd", "users", "sudo sin contraseña", "warn", `${plural(np.length, "regla da", "reglas dan")} root sin pedir contraseña (NOPASSWD)`, {
            weight: 2,
            items: np,
            fix: fix("visudo -f /etc/sudoers.d/<archivo>", { manual: true, note: "Quita «NOPASSWD:» de esas reglas" }),
          })
        : check("users.nopasswd", "users", "sudo sin contraseña", "ok", "sudo siempre pide contraseña", { weight: 2 }),
    );
  }

  if (noread(ctx, "shadow") || !ctx.sec.has("shadow")) {
    out.push(check("users.empty", "users", "Cuentas sin contraseña", "skip", NEEDS_SUDO, { weight: 3 }));
  } else {
    const empty = lines(ctx, "shadow")
      .map((l) => l.split(":"))
      .filter((p) => p[1] === "empty")
      .map((p) => p[0]);
    out.push(
      empty.length
        ? check("users.empty", "users", "Cuentas sin contraseña", "bad", `${plural(empty.length, "cuenta no tiene", "cuentas no tienen")} contraseña`, {
            weight: 3,
            items: empty,
            fix: fix(empty.map((u) => `passwd -l ${shQuote(u)}`).join("\n"), { note: "Bloquea la contraseña (las claves SSH siguen sirviendo)" }),
          })
        : check("users.empty", "users", "Cuentas sin contraseña", "ok", "Todas las cuentas tienen contraseña o están bloqueadas", { weight: 3 }),
    );
  }

  const uid0 = passwd.filter((u) => u.uid === 0 && u.name !== "root").map((u) => u.name);
  out.push(
    uid0.length
      ? check("users.uid0", "users", "Otras cuentas con UID 0", "bad", `${plural(uid0.length, "cuenta más es", "cuentas más son")} root (UID 0)`, {
          weight: 3,
          items: uid0,
          fix: fix(uid0.map((u) => `userdel ${shQuote(u)}`).join("\n"), { manual: true, note: "Si no la reconoces, bórrala o cámbiale el UID" }),
        })
      : check("users.uid0", "users", "Otras cuentas con UID 0", "ok", "Solo root tiene UID 0", { weight: 3 }),
  );
  return out;
}

// ───────── Red ─────────

/** Puertos que se esperan abiertos: SSH, web y el cliente DHCP. */
function expectedPort(proto: string, port: number, sshPort: number): boolean {
  if (proto === "tcp") return port === sshPort || port === 22 || port === 80 || port === 443;
  return port === 443 || port === 68 || port === 546;
}

export interface FirewallState {
  active: string[];
  inactive: string[];
  unknown: string[];
  installed: string[];
}

export function parseFirewall(ls: string[]): FirewallState {
  const st: FirewallState = { active: [], inactive: [], unknown: [], installed: [] };
  for (const l of ls) {
    const p = l.trim().split(/\s+/);
    const tool = p[0];
    if (!tool) continue;
    st.installed.push(tool);
    if (p[1] === "?") st.unknown.push(tool);
    else if (tool === "firewalld") (p[1] === "running" ? st.active : st.inactive).push(tool);
    else if (tool === "ufw") (p[1] === "active" ? st.active : st.inactive).push(tool);
    else if (tool === "nft" || tool === "iptables") (Number(p[2]) > 0 || Number(p[3]) > 0 ? st.active : st.inactive).push(tool);
  }
  return st;
}

function netChecks(ctx: AuditCtx, ports: PortsResult | null): Check[] {
  const out: Check[] = [];
  const fw = parseFirewall(lines(ctx, "fw"));
  const exposed = (ports?.ports ?? []).filter((p) => p.scope !== "local");
  const extra = exposed.filter((p) => !expectedPort(p.proto, p.port, ctx.sshPort));
  const fwOn = fw.active.length > 0;

  if (!ports) {
    out.push(check("net.ports", "net", "Puertos abiertos al exterior", "skip", "No se pudieron leer los puertos", { weight: 2 }));
  } else {
    const items = extra.map((p) => {
      const who = p.container ? `contenedor ${p.container}` : p.unit ?? p.procs[0]?.name ?? "proceso desconocido";
      return `${p.proto} ${p.ip.includes(":") ? `[${p.ip}]` : p.ip}:${p.port} · ${who}`;
    });
    out.push(
      extra.length
        ? check(
            "net.ports",
            "net",
            "Puertos abiertos al exterior",
            "warn",
            `${plural(extra.length, "puerto escucha", "puertos escuchan")} fuera de esta máquina además de SSH y web${fwOn ? " (el cortafuegos puede bloquearlos)" : ""}`,
            { weight: fwOn ? 1 : 2, items, fix: fix("# Haz que escuche en 127.0.0.1 o ciérralo en el cortafuegos", { manual: true }) },
          )
        : check("net.ports", "net", "Puertos abiertos al exterior", "ok", "Solo SSH y web escuchan fuera de esta máquina", { weight: 2 }),
    );
  }

  if (fwOn) {
    out.push(check("net.firewall", "net", "Cortafuegos", "ok", `Activo (${fw.active.join(", ")})`, { weight: 2 }));
  } else if (fw.unknown.length && !ctx.elevated) {
    out.push(check("net.firewall", "net", "Cortafuegos", "skip", `${NEEDS_SUDO} (${fw.unknown.join(", ")})`, { weight: 2 }));
  } else {
    const web = exposed.filter((p) => p.proto === "tcp" && (p.port === 80 || p.port === 443)).map((p) => p.port);
    const allow = [...new Set(web)];
    let f: Fix;
    const strong = { danger: true, note: "Solo deja pasar SSH y la web: abre antes lo que necesites" };
    if (fw.installed.includes("firewalld")) {
      const svc = [ctx.sshPort === 22 ? "--add-service=ssh" : `--add-port=${ctx.sshPort}/tcp`, ...allow.map((p) => (p === 80 ? "--add-service=http" : "--add-service=https"))];
      f = fix(["systemctl enable --now firewalld", `firewall-cmd --permanent ${svc.join(" ")}`, "firewall-cmd --reload"].join("\n"), strong);
    } else if (fw.installed.includes("ufw")) {
      f = fix([`ufw allow ${ctx.sshPort}/tcp`, ...allow.map((p) => `ufw allow ${p}/tcp`), "ufw --force enable"].join("\n"), strong);
    } else {
      const install =
        ctx.family === "debian" ? "apt-get install -y ufw" : ctx.family === "alpine" ? "apk add nftables" : ctx.family === "other" ? "# instala un cortafuegos" : "dnf -y install firewalld";
      f = fix(install, { manual: true, note: "Instálalo y vuelve a auditar para activarlo" });
    }
    out.push(check("net.firewall", "net", "Cortafuegos", "bad", "No hay ningún cortafuegos activo", { weight: 2, fix: f }));
  }
  return out;
}

// ───────── Actualizaciones ─────────

function upgradeCommand(mgr: string, securityOnly: boolean): string | null {
  switch (mgr) {
    case "dnf":
    case "yum":
      return `${mgr} -y upgrade${securityOnly ? " --security" : ""}`;
    case "apt":
      return "apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get -y upgrade";
    case "apk":
      return "apk update\napk upgrade";
    default:
      return null;
  }
}

function updateChecks(ctx: AuditCtx, vuln: AuditInput["vuln"], now: number): Check[] {
  const out: Check[] = [];
  const [mgr = "none", t = "?", s = "?"] = (lines(ctx, "updates")[0] ?? "none|?|?").split("|");
  const total = /^\d+$/.test(t) ? Number(t) : null;
  const sec = /^\d+$/.test(s) ? Number(s) : null;
  if (total === null) {
    out.push(check("updates.pending", "updates", "Actualizaciones pendientes", "skip", mgr === "none" ? "Gestor de paquetes no reconocido" : "No se pudo leer (sin caché de paquetes)", { weight: 3 }));
  } else if (sec !== null && sec > 0) {
    const c = upgradeCommand(mgr, mgr === "dnf" || mgr === "yum");
    out.push(
      check("updates.pending", "updates", "Actualizaciones pendientes", "bad", `${plural(sec, "actualización", "actualizaciones")} de seguridad (${total} en total)`, {
        weight: 3,
        fix: c ? fix(c, { note: "Puede reiniciar servicios" }) : null,
      }),
    );
  } else if (total > 0) {
    const c = upgradeCommand(mgr, false);
    out.push(
      check("updates.pending", "updates", "Actualizaciones pendientes", "warn", `${plural(total, "paquete por", "paquetes por")} actualizar`, {
        weight: 2,
        fix: c ? fix(c, { note: "Puede reiniciar servicios" }) : null,
      }),
    );
  } else {
    out.push(check("updates.pending", "updates", "Actualizaciones pendientes", "ok", mgr === "apt" ? "Al día (según el último «apt update»)" : "Al día", { weight: 3 }));
  }

  const rb = lines(ctx, "reboot");
  const nr = rb.find((l) => l.startsWith("nr "));
  const kernel = rb.find((l) => l.startsWith("kernel "))?.slice(7) ?? "";
  const mods = rb.filter((l) => l.startsWith("mod ")).map((l) => l.slice(4));
  const rebootFix = fix("command -v systemctl >/dev/null && systemctl reboot || reboot", { danger: true, note: "El servidor se reinicia ahora: se cortan las conexiones" });
  if (rb.includes("required") || nr === "nr 1") {
    out.push(check("updates.reboot", "updates", "Reinicio pendiente", "warn", "Hay que reiniciar para usar el núcleo o las bibliotecas nuevas", { weight: 2, fix: rebootFix }));
  } else if (nr === "nr 0" || (mods.length > 0 && mods.includes(kernel) && !nr)) {
    out.push(check("updates.reboot", "updates", "Reinicio pendiente", "ok", "No hace falta reiniciar", { weight: 2 }));
  } else if (mods.length > 0 && kernel && !mods.includes(kernel)) {
    out.push(check("updates.reboot", "updates", "Reinicio pendiente", "warn", "El núcleo en marcha ya no está instalado: reinicia", { weight: 2, fix: rebootFix }));
  } else {
    out.push(check("updates.reboot", "updates", "Reinicio pendiente", "skip", "No se pudo saber", { weight: 2 }));
  }

  if (!vuln) {
    out.push(check("updates.vulns", "updates", "Vulnerabilidades conocidas", "skip", "Sin analizar: usa «Analizar» en Vulnerabilidades", { weight: 3 }));
  } else {
    const days = Math.floor((now - Date.parse(vuln.createdAt)) / 86_400_000);
    const when = Number.isFinite(days) ? (days <= 0 ? "informe de hoy" : `informe de hace ${plural(days, "día", "días")}`) : "último informe";
    const v = vuln.summary;
    const text = `${plural(v.critical, "crítica", "críticas")}, ${plural(v.high, "alta", "altas")} (${when})`;
    out.push(
      check("updates.vulns", "updates", "Vulnerabilidades conocidas", v.critical > 0 ? "bad" : v.high > 0 ? "warn" : "ok", v.critical + v.high > 0 ? text : `Sin críticas ni altas (${when})`, {
        weight: 3,
      }),
    );
  }
  return out;
}

// ───────── Sitios web ─────────

function webChecks(web: WebResult | null, now: number): Check[] {
  if (!web) return [check("web.certs", "web", "Certificados de los sitios", "skip", "No se pudieron leer los sitios web", { weight: 2 })];
  const items: string[] = [];
  let worst: CheckStatus = "ok";
  let count = 0;
  let nginx = false;
  for (const srv of web.servers) {
    for (const site of srv.sites) {
      if (!site.https || site.certExpires === null) continue;
      count++;
      const st = certStatus(site.certExpires, now);
      if (!st || st.level === "ok") continue;
      if (srv.server === "nginx") nginx = true;
      items.push(`${site.names[0] ?? "(por defecto)"} · ${st.text}`);
      if (st.level === "bad") worst = "bad";
      else if (worst === "ok") worst = "warn";
    }
  }
  if (count === 0) return [check("web.certs", "web", "Certificados de los sitios", "info", "No hay sitios con certificado propio para revisar")];
  if (worst === "ok") return [check("web.certs", "web", "Certificados de los sitios", "ok", `${plural(count, "certificado vale", "certificados valen")} más de 30 días`, { weight: 2 })];
  return [
    check("web.certs", "web", "Certificados de los sitios", worst, `${plural(items.length, "certificado caduca", "certificados caducan")} en menos de 30 días`, {
      weight: worst === "bad" ? 3 : 2,
      items,
      fix: nginx ? fix("certbot renew && systemctl reload nginx", { manual: true, note: "Si usas certbot; si no, renuévalo con tu herramienta" }) : null,
    }),
  ];
}

// ───────── Contenedores ─────────

export interface ContainerRow {
  engine: string;
  rootful: boolean;
  name: string;
  privileged: boolean;
  user: string;
  ports: string[];
}

export function parseContainersAudit(ls: string[], uid: number | null): ContainerRow[] {
  const out: ContainerRow[] = [];
  let engine = "";
  let rootful = false;
  for (const l of ls) {
    const e = /^@engine (\S+) (\S*)$/.exec(l);
    if (e) {
      engine = e[1];
      const rootless = e[2] === "true";
      rootful = engine === "docker" ? !rootless : uid === 0 && !rootless;
      continue;
    }
    const p = l.split("|");
    if (!engine || p.length < 4) continue;
    out.push({
      engine,
      rootful,
      name: p[0].replace(/^\//, ""),
      privileged: p[1] === "true",
      user: p[2].trim(),
      ports: p.slice(3).join("|").trim().split(/\s+/).filter(Boolean),
    });
  }
  return out;
}

function containerChecks(ctx: AuditCtx): Check[] {
  const rows = parseContainersAudit(lines(ctx, "ctr"), ctx.uid);
  if (rows.length === 0) return [check("ctr.none", "containers", "Contenedores", "info", "No hay contenedores en marcha (de este usuario)")];
  const out: Check[] = [];
  const priv = rows.filter((r) => r.privileged);
  out.push(
    priv.length
      ? check("ctr.privileged", "containers", "Contenedores con --privileged", "bad", `${plural(priv.length, "contenedor tiene", "contenedores tienen")} acceso total al servidor`, {
          weight: 3,
          items: priv.map((r) => `${r.name} (${r.engine})`),
          fix: fix("# Vuelve a crear el contenedor sin --privileged (o solo con --cap-add necesarios)", { manual: true }),
        })
      : check("ctr.privileged", "containers", "Contenedores con --privileged", "ok", "Ninguno tiene --privileged", { weight: 3 }),
  );
  const asRoot = rows.filter((r) => r.rootful && (r.user === "" || r.user === "root" || r.user === "0" || /^(0|root):/.test(r.user)));
  out.push(
    asRoot.length
      ? check("ctr.root", "containers", "Contenedores como root", "warn", `${plural(asRoot.length, "contenedor corre", "contenedores corren")} como root en un motor con root`, {
          weight: 1,
          items: asRoot.map((r) => `${r.name} (${r.engine})`),
          fix: fix("# Usa --user con un usuario sin privilegios o Podman sin root", { manual: true }),
        })
      : check("ctr.root", "containers", "Contenedores como root", "ok", "Ninguno corre como root con un motor con root", { weight: 1 }),
  );
  const open: string[] = [];
  for (const r of rows) {
    for (const b of r.ports) {
      const m = /^(.*):(\d+)->/.exec(b);
      if (!m) continue;
      const ip = m[1];
      const port = Number(m[2]);
      if ((ip === "" || ip === "0.0.0.0" || ip === "::") && port !== 80 && port !== 443) open.push(`${r.name}: ${b}`);
    }
  }
  out.push(
    open.length
      ? check("ctr.ports", "containers", "Puertos de contenedores expuestos", "warn", `${plural(open.length, "puerto publicado", "puertos publicados")} en todas las interfaces`, {
          weight: 1,
          items: open,
          fix: fix("# Publica con -p 127.0.0.1:PUERTO:PUERTO y pon delante el proxy web", { manual: true }),
        })
      : check("ctr.ports", "containers", "Puertos de contenedores expuestos", "ok", "Solo publican la web o en 127.0.0.1", { weight: 1 }),
  );
  return out;
}

// ───────── Sistema ─────────

const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|shm|none|udev|efivarfs|cgroup.*|\/dev\/loop.*)$/;
const SKIP_MOUNT = /^\/(dev|proc|sys|run|snap)(\/|$)/;

export function parseDf(ls: string[]): { mount: string; pct: number }[] {
  const out: { mount: string; pct: number }[] = [];
  for (const l of ls) {
    const p = l.trim().split(/\s+/);
    if (p.length < 6) continue;
    const pct = Number(p[4].replace("%", ""));
    const mount = p.slice(5).join(" ");
    // overlay solo cuenta si es la raíz (servidor dentro de un contenedor).
    if (!Number.isFinite(pct) || (SKIP_FS.test(p[0]) && !(p[0] === "overlay" && mount === "/")) || SKIP_MOUNT.test(mount)) continue;
    out.push({ mount, pct });
  }
  return out;
}

export function parseMem(ls: string[]): { total: number; avail: number; swapTotal: number; swapFree: number } | null {
  const v: Record<string, number> = {};
  for (const l of ls) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) v[m[1]] = Number(m[2]);
  }
  if (!v.MemTotal) return null;
  return { total: v.MemTotal, avail: v.MemAvailable ?? v.MemFree ?? 0, swapTotal: v.SwapTotal ?? 0, swapFree: v.SwapFree ?? 0 };
}

function systemChecks(ctx: AuditCtx): Check[] {
  const out: Check[] = [];
  const failed = lines(ctx, "failed");
  if (failed.includes("@nosvc")) out.push(check("system.failed", "system", "Servicios caídos", "skip", "Sin systemd ni OpenRC"));
  else
    out.push(
      failed.length
        ? check("system.failed", "system", "Servicios caídos", "warn", `${plural(failed.length, "servicio falló", "servicios fallaron")}`, {
            weight: 1,
            items: failed,
            fix: fix(`systemctl status ${failed.map(shQuote).join(" ")} --no-pager`, { manual: true, note: "Mira por qué falló" }),
          })
        : check("system.failed", "system", "Servicios caídos", "ok", "Ningún servicio caído"),
    );

  const disks = parseDf(lines(ctx, "disk"));
  const full = disks.filter((d) => d.pct >= 80).sort((a, b) => b.pct - a.pct);
  if (!disks.length) out.push(check("system.disk", "system", "Disco", "skip", "No se pudo leer el disco"));
  else if (full.length) {
    const bad = full[0].pct >= 90;
    out.push(
      check("system.disk", "system", "Disco", bad ? "bad" : "warn", `${plural(full.length, "disco está", "discos están")} al ${full[0].pct} % o más`, {
        weight: 2,
        items: full.map((d) => `${d.mount} · ${d.pct} %`),
        fix: fix(`du -xh -d1 ${shQuote(full[0].mount)} 2>/dev/null | sort -h | tail -n 15`, { manual: true, note: "Qué ocupa más" }),
      }),
    );
  } else out.push(check("system.disk", "system", "Disco", "ok", `Todos por debajo del 80 % (máx. ${Math.max(...disks.map((d) => d.pct))} %)`, { weight: 2 }));

  const mem = parseMem(lines(ctx, "mem"));
  if (!mem) out.push(check("system.mem", "system", "Memoria", "skip", "No se pudo leer la memoria"));
  else {
    const free = Math.round((mem.avail / mem.total) * 100);
    const swapUsed = mem.swapTotal > 0 ? Math.round(((mem.swapTotal - mem.swapFree) / mem.swapTotal) * 100) : 0;
    const gb = (mem.total / 1048576).toFixed(1).replace(".", ",");
    const st: CheckStatus = free < 10 ? "bad" : free < 20 || swapUsed > 80 ? "warn" : "ok";
    out.push(check("system.mem", "system", "Memoria", st, `${free} % libre de ${gb} GB${swapUsed > 0 ? ` · swap al ${swapUsed} %` : ""}`, { weight: st === "bad" ? 2 : 1 }));
  }
  return out;
}

// ───────── Intentos de entrada ─────────

function fail2banInstall(family: Family): string | null {
  const jail = "printf '[sshd]\\nenabled = true\\nbackend = systemd\\n' > /etc/fail2ban/jail.d/sshorus.local";
  switch (family) {
    case "fedora":
      return ["dnf -y install fail2ban", jail, "systemctl enable --now fail2ban"].join("\n");
    case "rhel":
      return ["dnf -y install epel-release", "dnf -y install fail2ban", jail, "systemctl enable --now fail2ban"].join("\n");
    case "debian":
      return ["apt-get install -y fail2ban python3-systemd", jail, "systemctl enable --now fail2ban"].join("\n");
    case "alpine":
      return ["apk add fail2ban", "rc-update add fail2ban", "rc-service fail2ban start"].join("\n");
    default:
      return null;
  }
}

function loginChecks(ctx: AuditCtx): Check[] {
  const out: Check[] = [];
  const a = lines(ctx, "auth");
  const j = a.find((l) => l.startsWith("journal "));
  const f = a.find((l) => l.startsWith("file "));
  const f2b = a.find((l) => l.startsWith("f2b "))?.slice(4) ?? "none";
  const n = j ? Number(j.split(" ")[1]) : f ? Number(f.split(" ")[1]) : null;
  if (n === null || !Number.isFinite(n)) out.push(check("logins.failed", "logins", "Intentos de entrada fallidos", "skip", NEEDS_SUDO));
  else {
    const many = n > 200 && f2b !== "active";
    out.push(
      check("logins.failed", "logins", "Intentos de entrada fallidos", many ? "warn" : "info", `${n} intentos fallidos${j ? " en 24 h" : " en el registro"}`, {
        weight: 1,
      }),
    );
  }
  if (f2b === "active") out.push(check("logins.fail2ban", "logins", "fail2ban", "ok", "Activo: bloquea a quien falla muchas veces", { weight: 2 }));
  else {
    const cmd = f2b === "inactive" ? (ctx.family === "alpine" ? "rc-service fail2ban start" : "systemctl enable --now fail2ban") : fail2banInstall(ctx.family);
    const need = ctx.passwordAuth !== false;
    out.push(
      check(
        "logins.fail2ban",
        "logins",
        "fail2ban",
        need ? "warn" : "info",
        `${f2b === "inactive" ? "Instalado pero parado" : "No está instalado"}${need ? "" : " (solo se entra con clave)"}`,
        { weight: 2, fix: cmd ? fix(cmd) : null },
      ),
    );
  }
  return out;
}

// ───────── Endurecimiento ─────────

function hardeningChecks(ctx: AuditCtx): Check[] {
  const out: Check[] = [];
  const proc = lines(ctx, "proc")[0] ?? "";
  if (!proc) out.push(check("hard.hidepid", "hardening", "Procesos ocultos a otros usuarios", "skip", "No se pudo leer /proc/mounts"));
  else if (/hidepid=(1|2|noaccess|invisible)/.test(proc)) out.push(check("hard.hidepid", "hardening", "Procesos ocultos a otros usuarios", "ok", "/proc tiene hidepid"));
  else
    out.push(
      check("hard.hidepid", "hardening", "Procesos ocultos a otros usuarios", "warn", "Cualquier usuario ve los procesos de todos (/proc sin hidepid)", {
        weight: 1,
        fix: fix(
          ["mount -o remount,hidepid=2 /proc", "grep -qE '^proc[[:space:]]+/proc' /etc/fstab || echo 'proc /proc proc defaults,hidepid=2 0 0' >> /etc/fstab"].join("\n"),
          { danger: true, note: "Algunas herramientas de monitorización dejan de ver procesos ajenos" },
        ),
      }),
    );

  // Permisos de archivos clave: «ruta modo dueño grupo».
  const bad: string[] = [];
  const cmds: string[] = [];
  for (const l of lines(ctx, "perms")) {
    const [path, modeS, , group] = l.split(" ");
    const mode = Number.parseInt(modeS ?? "", 8);
    if (!Number.isFinite(mode)) continue;
    // shadow: nadie más que root y el grupo «shadow» (Debian/Alpine) puede leerlo.
    const groupReads = (mode & 0o040) !== 0 && !["root", "shadow", "auth"].includes(group ?? "");
    if ((path === "/etc/shadow" || path === "/etc/gshadow") && ((mode & 0o027) !== 0 || groupReads)) {
      bad.push(`${path} (${modeS})`);
      cmds.push(groupReads ? `chgrp root ${path} && chmod o-rwx,g-rwx ${path}` : `chmod o-rwx,g-wx ${path}`);
    } else if (path === "/etc/sudoers" && (mode & 0o022) !== 0) {
      bad.push(`${path} (${modeS})`);
      cmds.push(`chmod 440 ${path}`);
    } else if ((path === "/etc/passwd" || path === "/etc/ssh/sshd_config") && (mode & 0o022) !== 0) {
      bad.push(`${path} (${modeS})`);
      cmds.push(`chmod go-w ${path}`);
    }
  }
  out.push(
    bad.length
      ? check("hard.shadow", "hardening", "Permisos de /etc/shadow y otros", "bad", `${plural(bad.length, "archivo clave tiene", "archivos clave tienen")} permisos de más`, {
          weight: 3,
          items: bad,
          fix: fix(cmds.join("\n")),
        })
      : check("hard.shadow", "hardening", "Permisos de /etc/shadow y otros", "ok", "shadow, passwd, sudoers y sshd_config con permisos correctos", { weight: 3 }),
  );

  const ww = lines(ctx, "wwetc");
  const partial = ctx.elevated ? "" : " (sin sudo no se ve todo)";
  out.push(
    ww.length
      ? check("hard.wwetc", "hardening", "Archivos de /etc escribibles por todos", "bad", `${plural(ww.length, "archivo o carpeta", "archivos o carpetas")} de /etc que cualquiera puede cambiar`, {
          weight: 2,
          items: ww,
          fix: fix(`chmod o-w ${ww.map(shQuote).join(" ")}`),
        })
      : check("hard.wwetc", "hardening", "Archivos de /etc escribibles por todos", "ok", `Ninguno${partial}`, { weight: 2 }),
  );

  const wp = lines(ctx, "webperm");
  const dirs = wp.filter((l) => l.startsWith("@dir ")).map((l) => l.slice(5));
  const files = wp.filter((l) => !l.startsWith("@"));
  const caddyGroup = wp.includes("@group caddy");
  if (!dirs.length) out.push(check("hard.webconf", "hardening", "Configuración web legible por todos", "info", "No hay nginx, Caddy ni Apache en /etc"));
  else if (!files.length) out.push(check("hard.webconf", "hardening", "Configuración web legible por todos", "ok", "Solo la leen root y el servicio", { weight: 1 }));
  else {
    const keys = files.filter((f) => /(\.key|privkey[^/]*)$/.test(f));
    const touched = dirs.filter((d) => files.some((f) => f.startsWith(`${d}/`)));
    const cmds2 = touched.map((d) =>
      d === "/etc/caddy" ? (caddyGroup ? `chgrp -R caddy /etc/caddy && chmod -R g+rX,o-rwx /etc/caddy` : "# Caddy lee su configuración como «caddy»: dale el grupo antes de quitar permisos") : `chmod -R o-rwx ${d}`,
    );
    out.push(
      check(
        "hard.webconf",
        "hardening",
        "Configuración web legible por todos",
        keys.length ? "bad" : "warn",
        keys.length ? `${plural(keys.length, "llave privada", "llaves privadas")} de la web que cualquier usuario puede leer` : `${plural(files.length, "archivo", "archivos")} de configuración web que cualquier usuario puede leer`,
        {
          weight: keys.length ? 3 : 1,
          items: files,
          fix: fix(cmds2.join("\n"), { danger: true, manual: cmds2.some((c) => c.startsWith("#")), note: "Después, comprueba que el sitio responde" }),
        },
      ),
    );
  }

  const cron = lines(ctx, "cron");
  if (cron.includes("@noread")) out.push(check("hard.cron", "hardening", "Tareas cron de usuarios", "skip", NEEDS_SUDO));
  else {
    const others = cron.filter((u) => u !== "root");
    out.push(
      others.length
        ? check("hard.cron", "hardening", "Tareas cron de usuarios", "info", `${plural(others.length, "usuario tiene", "usuarios tienen")} tareas cron propias: revisa que las reconoces`, {
            items: others.map((u) => `${u}: crontab -l -u ${u}`),
          })
        : check("hard.cron", "hardening", "Tareas cron de usuarios", "ok", "Solo root tiene tareas cron propias"),
    );
  }
  return out;
}

// ───────── Todo junto ─────────

export function buildContext(stdout: string, elevated: boolean): AuditCtx {
  const sec = splitSections(stdout);
  const idl = (sec.get("id") ?? [])[0]?.split(" ") ?? [];
  const uid = /^\d+$/.test(idl[0] ?? "") ? Number(idl[0]) : null;
  const osl = ((sec.get("os") ?? [])[0] ?? "").split("|");
  const os = { id: osl[0] ?? "", like: (osl[1] ?? "").split(/\s+/).filter(Boolean), name: osl[2] ?? "" };
  return {
    sec,
    uid,
    user: idl[1] ?? "",
    groups: ((sec.get("id") ?? [])[1] ?? "").split(/\s+/).filter(Boolean),
    os,
    family: familyOf(os.id, os.like),
    elevated: elevated || uid === 0,
    sshPort: 22,
    passwordAuth: null,
  };
}

export function runChecks(input: AuditInput): { checks: Check[]; os: string } {
  const ctx = buildContext(input.stdout, input.elevated);
  // El orden importa: SSH fija el puerto y si se entra con contraseña (lo usan Red y fail2ban).
  const checks = [
    ...sshChecks(ctx),
    ...userChecks(ctx),
    ...netChecks(ctx, input.ports),
    ...updateChecks(ctx, input.vuln, input.now),
    ...webChecks(input.web, input.now),
    ...containerChecks(ctx),
    ...systemChecks(ctx),
    ...loginChecks(ctx),
    ...hardeningChecks(ctx),
  ];
  return { checks, os: ctx.os.name || ctx.os.id };
}
