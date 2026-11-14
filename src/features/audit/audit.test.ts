// Pruebas de «Auditar servidor»: parseo de cada comprobación con salidas de Rocky, Debian y Alpine, notas,
// comparación, exportar y el texto para la IA (que no lleve usuarios, IP ni rutas).
// Ejecutar: npx rolldown src/features/audit/audit.test.ts -p node -f esm -o /tmp/au.mjs && node /tmp/au.mjs
import type { AuditReport, Check } from "../../api/audit";
import type { PortsResult } from "../admin/ports";
import type { WebResult } from "../admin/web";
import { buildAuditAiText } from "./aiPayload";
import { parseDf, parseFirewall, parseSshd, runChecks, sshdFixCommand, sudoUsers, type AuditInput } from "./checks";
import { toHtml, toMarkdown } from "./export";
import { ALPINE_USER, DEBIAN_CONTAINER, ROCKY_CONTAINER, ROCKY_SERVER, UBUNTU_SERVER } from "./fixtures";
import { categoryScore, checkScore, compare, grade, scoreChecks, SEVERE_CAP } from "./score";
import { splitSections } from "../admin/parse";

declare const process: { exit(code: number): never };

let failed = 0;
let passed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`✗ ${msg}`);
  }
}
function eq<T>(a: T, b: T, msg: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}

const NOW = Date.parse("2026-11-13T12:00:00Z");
const DAY = 86_400_000;

function port(proto: "tcp" | "udp", ip: string, p: number, name: string, container: string | null = null) {
  return {
    key: `${proto}|${ip}|${p}`,
    proto,
    ip,
    iface: null,
    port: p,
    family: ip.includes(":") ? 6 : 4,
    scope: ip === "127.0.0.1" || ip === "::1" ? "local" : ip === "0.0.0.0" || ip === "::" || ip === "*" ? "public" : "ip",
    procs: [{ name, pid: 1 }],
    user: "root",
    unit: null,
    container,
  } as PortsResult["ports"][number];
}

const PORTS: PortsResult = {
  tool: "ss",
  ports: [
    port("tcp", "0.0.0.0", 2222, "sshd"),
    port("tcp", "0.0.0.0", 443, "nginx"),
    port("tcp", "0.0.0.0", 80, "nginx"),
    port("tcp", "0.0.0.0", 5432, "postgres"),
    port("tcp", "127.0.0.1", 6379, "redis-server"),
    port("udp", "0.0.0.0", 68, "dhclient"),
  ],
};

const WEB: WebResult = {
  servers: [
    {
      server: "nginx",
      source: "dump",
      configPath: "/etc/nginx/nginx.conf",
      status: "active",
      warning: null,
      sites: [
        { key: "a", server: "nginx", names: ["tienda.example.com"], listens: [], https: true, isDefault: false, cert: "/c1", certExpires: NOW + 10 * DAY, routes: [], file: null, line: null },
        { key: "b", server: "nginx", names: ["blog.example.com"], listens: [], https: true, isDefault: false, cert: "/c2", certExpires: NOW + 25 * DAY, routes: [], file: null, line: null },
        { key: "c", server: "nginx", names: ["api.example.com"], listens: [], https: true, isDefault: false, cert: "/c3", certExpires: NOW + 80 * DAY, routes: [], file: null, line: null },
      ],
    },
  ],
};

function input(stdout: string, extra: Partial<AuditInput> = {}): AuditInput {
  return { stdout, elevated: false, ports: null, web: null, vuln: null, now: NOW, ...extra };
}

function byId(checks: Check[]): Map<string, Check> {
  return new Map(checks.map((c) => [c.id, c]));
}

// ───────── Rocky con sudo y muchos problemas ─────────
{
  const vuln = { createdAt: new Date(NOW - 3 * DAY).toISOString(), summary: { critical: 2, high: 5, medium: 9, low: 1, unknown: 0, total: 17, withFix: 12, unimportant: 0 } };
  const { checks, os } = runChecks(input(ROCKY_SERVER, { elevated: true, ports: PORTS, web: WEB, vuln }));
  const c = byId(checks);
  eq(os, "Rocky Linux 9.4 (Blue Onyx)", "rocky: sistema");
  eq(c.get("ssh.root")?.status, "bad", "rocky: PermitRootLogin yes = mal");
  ok(c.get("ssh.root")?.fix?.danger, "rocky: arreglar root es peligroso");
  ok(c.get("ssh.root")?.fix?.note?.includes("root"), "rocky: conectado como root → aviso de perder acceso");
  ok(c.get("ssh.root")?.fix?.command.includes("/etc/ssh/sshd_config.d/00-terview.conf"), "rocky: con Include usa un archivo aparte");
  eq(c.get("ssh.password")?.status, "warn", "rocky: contraseña por SSH = aviso");
  eq(c.get("ssh.keys")?.status, "bad", "rocky: authorized_keys 664 = mal");
  ok(c.get("ssh.keys")?.fix?.command === "chmod 600 '/home/ana/.ssh/authorized_keys'", `rocky: chmod de la clave: ${c.get("ssh.keys")?.fix?.command}`);
  eq(c.get("users.sudo")?.items, ["ana", "deploy"], "rocky: usuarios con sudo (grupo wheel + sudoers)");
  eq(c.get("users.nopasswd")?.status, "warn", "rocky: NOPASSWD");
  eq(c.get("users.empty")?.items, ["deploy"], "rocky: cuenta sin contraseña");
  eq(c.get("users.empty")?.fix?.command, "passwd -l 'deploy'", "rocky: bloquear contraseña vacía");
  eq(c.get("users.uid0")?.items, ["toor"], "rocky: UID 0 extra");
  eq(c.get("net.ports")?.status, "warn", "rocky: puertos de más");
  ok(c.get("net.ports")?.items.length === 1 && c.get("net.ports")!.items[0].includes("5432"), `rocky: solo postgres (SSH en 2222, web y DHCP no cuentan): ${c.get("net.ports")?.items}`);
  eq(c.get("net.firewall")?.status, "bad", "rocky: sin cortafuegos");
  ok(c.get("net.firewall")?.fix?.command.includes("--add-port=2222/tcp") && c.get("net.firewall")!.fix!.command.includes("--add-service=https"), `rocky: firewalld abre SSH (2222) y web: ${c.get("net.firewall")?.fix?.command}`);
  eq(c.get("updates.pending")?.status, "bad", "rocky: 7 de seguridad");
  eq(c.get("updates.pending")?.fix?.command, "dnf -y upgrade --security", "rocky: actualizar solo seguridad");
  eq(c.get("updates.reboot")?.status, "warn", "rocky: needs-restarting -r = 1");
  eq(c.get("updates.vulns")?.status, "bad", "rocky: vulnerabilidades críticas");
  ok(c.get("updates.vulns")?.detail.includes("hace 3 días"), "rocky: antigüedad del informe");
  eq(c.get("web.certs")?.status, "bad", "rocky: un certificado en < 14 días");
  eq(c.get("web.certs")?.items.length, 2, "rocky: dos certificados a menos de 30 días");
  eq(c.get("ctr.privileged")?.items, ["tools (podman)"], "rocky: --privileged");
  eq(c.get("ctr.root")?.items, ["db (podman)", "tools (podman)"], "rocky: contenedores root en motor con root");
  ok(c.get("ctr.ports")?.items.length === 1 && c.get("ctr.ports")!.items[0].startsWith("db:"), "rocky: 5432 publicado (443 y 127.0.0.1 no cuentan)");
  eq(c.get("system.failed")?.items, ["kdump.service"], "rocky: servicio caído");
  eq(c.get("system.disk")?.status, "bad", "rocky: disco al 93 %");
  eq(c.get("system.mem")?.status, "warn", "rocky: memoria al 13 %");
  eq(c.get("logins.failed")?.status, "warn", "rocky: muchos intentos sin fail2ban");
  eq(c.get("logins.fail2ban")?.status, "warn", "rocky: fail2ban falta con contraseña activa");
  ok(c.get("logins.fail2ban")?.fix?.command.startsWith("dnf -y install epel-release"), "rocky: fail2ban desde EPEL");
  eq(c.get("hard.hidepid")?.status, "warn", "rocky: sin hidepid");
  eq(c.get("hard.shadow")?.items, ["/etc/shadow (644)"], "rocky: shadow 644");
  eq(c.get("hard.wwetc")?.items, ["/etc/app/config.ini"], "rocky: escribible por todos");
  eq(c.get("hard.webconf")?.status, "bad", "rocky: llave privada legible por todos");
  eq(c.get("hard.webconf")?.fix?.command, "chmod -R o-rwx /etc/nginx", "rocky: permisos de nginx");
  eq(c.get("hard.cron")?.items, ["ana: crontab -l -u ana"], "rocky: cron de otros usuarios");

  const s = scoreChecks(checks);
  ok(s.score !== null && s.score <= SEVERE_CAP, `rocky: con problemas graves la nota no pasa de ${SEVERE_CAP} (${s.score})`);
  ok(s.categories.every((x) => x.score === null || x.score >= 25), "rocky: ninguna categoría baja de 25 aunque tenga muchos problemas");
  eq(s.grade, grade(s.score ?? 0), "rocky: letra coherente");
  ok(s.summary.includes("graves") && s.summary.includes("avisos"), `rocky: resumen: ${s.summary}`);
  eq(s.categories.length, 9, "rocky: nueve categorías");
  ok(s.categories.every((x) => x.score !== null), "rocky: con sudo todas tienen nota");

  // Privacidad: lo que va a la IA no lleva usuarios, dominios, IP, rutas de casa ni comandos.
  const report: AuditReport = { id: "a", serverId: "s", createdAt: new Date(NOW).toISOString(), durationMs: 1, elevated: true, os, ...s, checks, ai: null };
  const ai = buildAuditAiText(report, true);
  for (const secret of ["ana", "deploy", "toor", "tienda.example.com", "0.0.0.0", "/home/", "postgres", "passwd -l", "kdump"]) {
    ok(!ai.includes(secret), `IA: no envía «${secret}»`);
  }
  ok(ai.includes("[Mal] Entrada de root por SSH"), "IA: lista los problemas");
  for (const ch of checks) ok(!/\b(ana|deploy|toor)\b/.test(ch.detail), `detalle sin usuarios: ${ch.id}: ${ch.detail}`);

  const md = toMarkdown(report, "web-prod");
  ok(md.includes("# Auditoría de web-prod") && md.includes("| SSH |") && md.includes("```sh"), "markdown");
  const html = toHtml(report, "<b>x</b>");
  ok(html.includes("&lt;b&gt;x&lt;/b&gt;") && !html.includes("<b>x</b>"), "html escapa el nombre");
  ok(html.startsWith("<!doctype html>") && html.includes("prefers-color-scheme"), "html completo con tema oscuro");

  // Comparación: arreglar root mejora; un problema nuevo empeora.
  const fixed = checks.map((x) => (x.id === "ssh.root" ? { ...x, status: "ok" as const } : x));
  const next: AuditReport = { ...report, id: "b", checks: [...fixed, { ...checks[0], id: "x.new", status: "bad" }], ...scoreChecks(fixed) };
  const cmp = compare(next, report);
  eq(cmp?.changes.get("ssh.root"), "better", "comparar: mejoró");
  eq(cmp?.changes.get("x.new"), "new", "comparar: nuevo problema");
  eq([cmp?.better, cmp?.worse], [1, 1], "comparar: recuento");
  eq(compare(report, null), null, "comparar: sin anterior");
}

// ───────── Ubuntu: los arreglos son de Ubuntu (apt, ufw), no de dnf ─────────
{
  const { checks, os } = runChecks(input(UBUNTU_SERVER, { elevated: true, ports: PORTS }));
  const c = byId(checks);
  eq(os, "Ubuntu 24.04.3 LTS", "ubuntu: sistema");
  eq(c.get("updates.pending")?.status, "bad", "ubuntu: 3 de seguridad = mal");
  eq(c.get("updates.pending")?.fix?.command, "apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get -y upgrade", "ubuntu: actualizar con apt");
  eq(c.get("updates.reboot")?.status, "warn", "ubuntu: /var/run/reboot-required");
  eq(c.get("net.firewall")?.fix?.command, "ufw allow 2222/tcp\nufw allow 443/tcp\nufw allow 80/tcp\nufw --force enable", "ubuntu: cortafuegos con ufw");
  eq(c.get("logins.fail2ban")?.fix?.command.split("\n")[0], "apt-get install -y fail2ban python3-systemd", "ubuntu: fail2ban con apt");
  eq(c.get("users.sudo")?.items, ["ana", "deploy"], "ubuntu: grupo sudo");
  eq(c.get("hard.shadow")?.status, "ok", "ubuntu: shadow 640 root:shadow");
  ok(!checks.some((x) => x.fix?.command.includes("dnf")), "ubuntu: ningún arreglo usa dnf");
  // Actualizaciones que no son de seguridad: aviso, no grave.
  const plain = runChecks(input(UBUNTU_SERVER.replace("apt|12|3", "apt|12|0"), { elevated: true })).checks.find((x) => x.id === "updates.pending");
  eq([plain?.status, plain?.weight], ["warn", 2], "ubuntu: 12 sin ser de seguridad = aviso");
}

// ───────── Rocky en contenedor, como root sin sshd ni sudo ─────────
{
  const { checks } = runChecks(input(ROCKY_CONTAINER, { elevated: true }));
  const c = byId(checks);
  eq(c.get("ssh.root")?.status, "skip", "rocky-ctr: sin sshd_config no se puede saber");
  eq(c.get("users.nopasswd")?.status, "ok", "rocky-ctr: sin sudoers no hay NOPASSWD");
  eq(c.get("users.empty")?.status, "ok", "rocky-ctr: todas bloqueadas");
  eq(c.get("updates.pending")?.status, "skip", "rocky-ctr: dnf sin caché = sin comprobar");
  eq(c.get("updates.reboot")?.status, "skip", "rocky-ctr: sin needs-restarting ni módulos");
  eq(c.get("system.failed")?.status, "skip", "rocky-ctr: sin systemd");
  eq(c.get("system.disk")?.items, ["/ · 93 %"], "rocky-ctr: overlay en / sí cuenta");
  eq(c.get("hard.shadow")?.status, "ok", "rocky-ctr: shadow 000");
  eq(c.get("ctr.none")?.status, "info", "rocky-ctr: sin contenedores");
  eq(c.get("net.ports")?.status, "skip", "rocky-ctr: sin puertos leídos");
  eq(c.get("net.firewall")?.status, "bad", "rocky-ctr: sin cortafuegos");
  ok(c.get("net.firewall")?.fix?.manual && c.get("net.firewall")?.fix?.command === "dnf -y install firewalld", "rocky-ctr: instalar firewalld (a mano)");
}

// ───────── Debian en contenedor ─────────
{
  const { checks } = runChecks(input(DEBIAN_CONTAINER, { elevated: true }));
  const c = byId(checks);
  eq(c.get("updates.pending")?.status, "ok", "debian: apt al día");
  ok(c.get("updates.pending")?.detail.includes("apt update"), "debian: avisa de que depende de apt update");
  eq(c.get("hard.shadow")?.status, "ok", "debian: shadow 640 root:shadow está bien");
  eq(c.get("users.sudo")?.items, [], "debian: grupo sudo vacío");
  eq(c.get("logins.fail2ban")?.fix?.command.split("\n")[0], "apt-get install -y fail2ban python3-systemd", "debian: instalar fail2ban");
}

// ───────── Alpine (openssh-server) como usuario sin sudo ─────────
{
  const { checks } = runChecks(input(ALPINE_USER, { elevated: false }));
  const c = byId(checks);
  eq(c.get("ssh.password")?.status, "ok", "alpine: PasswordAuthentication no (de los archivos)");
  eq(c.get("ssh.root")?.status, "warn", "alpine: por defecto root entra con clave");
  ok(c.get("ssh.root")?.fix?.command.includes("sed -i '1i PermitRootLogin no' /etc/ssh/sshd_config"), "alpine: sin Include, al principio del archivo");
  eq(c.get("users.nopasswd")?.status, "skip", "alpine: sudoers sin leer = necesita sudo");
  eq(c.get("hard.shadow")?.status, "bad", "alpine: shadow legible por el grupo users");
  ok(c.get("hard.shadow")?.fix?.command.startsWith("chgrp root /etc/shadow"), "alpine: quitar el grupo");
  eq(c.get("hard.cron")?.status, "ok", "alpine: solo root");
  eq(c.get("updates.pending")?.status, "ok", "alpine: apk al día");
  eq(c.get("logins.fail2ban")?.status, "info", "alpine: sin contraseña por SSH, fail2ban es opcional");
  eq(c.get("logins.failed")?.status, "skip", "alpine: sin registros legibles");
  eq(c.get("net.firewall")?.status, "bad", "alpine: sin cortafuegos");
  const keys = c.get("ssh.keys");
  ok(keys?.items.some((i) => i.includes("necesita sudo")), "alpine: claves de otros sin leer");
  const s = scoreChecks(checks);
  ok(s.summary.includes("sin comprobar"), `alpine: resumen con lo no comprobado: ${s.summary}`);
}

// ───────── Piezas sueltas ─────────
{
  const sec = splitSections("@@sshd\n@@sshdsrc\nF\n@@sshdcfg\n/etc/ssh/sshd_config.d/50-cloud-init.conf:PasswordAuthentication yes\n/etc/ssh/sshd_config:PasswordAuthentication no\n@@sshinc\n1\n@@end\n");
  const cfg = parseSshd(sec);
  eq([cfg.source, cfg.values.passwordauthentication, cfg.include], ["files", "yes", true], "sshd: gana el primer valor (cloud-init)");
  eq(parseSshd(splitSections("@@sshdsrc\nF\n@@sshdcfg\n@noread\n@@end")).source, "none", "sshd: sin leer");
  const cmd = sshdFixCommand([["PasswordAuthentication", "no"]], true);
  ok(cmd.includes("sshd -t ||") && cmd.includes("systemctl reload sshd"), "sshd: comprueba y recarga");
  eq(parseFirewall(["firewalld running"]).active, ["firewalld"], "fw: firewalld");
  eq(parseFirewall(["ufw inactive", "nft x 1 3"]).active, ["nft"], "fw: nft con reglas de entrada");
  eq(parseFirewall(["ufw ?", "iptables ?"]).unknown, ["ufw", "iptables"], "fw: sin root");
  eq(parseFirewall(["iptables x 0 1"]).active, ["iptables"], "fw: política DROP");
  eq(sudoUsers(["sudo:x:27:ana,bob", "wheel:x:10:root"], ["Defaults env_reset", "root ALL=(ALL:ALL) ALL", "%sudo ALL=(ALL:ALL) ALL", "carl ALL=(ALL) ALL", "User_Alias ADM = x"]), ["ana", "bob", "carl"], "sudo: grupos + sudoers");
  eq(parseDf(["/dev/sda1 100 90 10 90% /", "tmpfs 1 0 1 0% /run", "/dev/loop0 1 1 0 100% /snap/core/1", "/dev/sdb1 10 1 9 10% /srv/mis datos"]), [{ mount: "/", pct: 90 }, { mount: "/srv/mis datos", pct: 10 }], "df: filtra y admite espacios");
  eq(grade(95), "A", "nota A");
  eq(grade(59), "F", "nota F");
  const cat = categoryScore("ssh", [
    { id: "1", category: "ssh", title: "", status: "warn", detail: "", items: [], fix: null, weight: 2 },
    { id: "2", category: "ssh", title: "", status: "skip", detail: "", items: [], fix: null, weight: 2 },
  ]);
  eq([cat.score, cat.grade, cat.summary], [84, "B", "1 aviso · 1 sin comprobar"], "categoría: aviso de peso 2");
  const mk = (status: Check["status"], weight: number): Check => ({ id: `${status}${weight}`, category: "updates", title: "", status, detail: "", items: [], fix: null, weight });
  eq([checkScore(mk("bad", 3)), checkScore(mk("bad", 1)), checkScore(mk("warn", 2)), checkScore(mk("ok", 3)), checkScore(mk("skip", 3))], [45, 65, 84, 100, null], "nota de cada comprobación");
  eq(categoryScore("updates", [mk("bad", 3)]).score, 45, "un solo grave deja la categoría en ~45, no en 0");
  eq(categoryScore("updates", [mk("bad", 3), mk("warn", 2), mk("warn", 3)]).score, 37, "1 grave y 2 avisos: 45 − 4 − 4");
  eq(categoryScore("updates", [mk("ok", 3), mk("ok", 2)]).score, 100, "todo bien = 100");
  eq(categoryScore("updates", Array.from({ length: 12 }, (_, i) => ({ ...mk("bad", 3), id: `b${i}` }))).score, 25, "suelo de 25");
  // General: casi todo en B con un solo grave de peso 3 → C (tope 75), no F.
  const mostlyB: Check[] = [
    { ...mk("warn", 2), category: "ssh", id: "s" },
    { ...mk("warn", 2), category: "users", id: "u" },
    { ...mk("warn", 1), category: "net", id: "n" },
    { ...mk("bad", 3), category: "updates", id: "p" },
    { ...mk("warn", 1), category: "system", id: "y" },
    { ...mk("ok", 2), category: "hardening", id: "h" },
  ];
  const g = scoreChecks(mostlyB);
  ok(g.score !== null && g.score >= 70 && g.score <= SEVERE_CAP, `general con un grave y lo demás en B: C (${g.score})`);
  eq(g.grade, "C", "general: letra C");
  eq(scoreChecks(mostlyB.filter((c) => c.status !== "bad")).score, 88, "sin el grave sube a B");
  eq(categoryScore("web", []).score, null, "categoría vacía sin nota");
}

console.log(`${passed} pruebas bien, ${failed} mal`);
if (failed) process.exit(1);
