// Respuestas de Administración → Auditoría: dos auditorías de web-prod hechas con la lógica REAL
// (`src/features/audit`) sobre una salida de ejemplo de Ubuntu 24.04 (como web-prod), la última con dos cosas
// ya arregladas. Sistema, comandos de arreglo (apt, ufw) y nota salen de esa misma lógica.
import type { AuditReport, Check } from "../../../../src/api/audit";
import { runChecks, scoreChecks } from "../../../../src/features/audit";
import { UBUNTU_SERVER } from "../../../../src/features/audit/fixtures";
import type { PortsResult } from "../../../../src/features/admin/ports";

type Args = Record<string, unknown> | undefined;

const NOW = Date.now();
const DAY = 86_400_000;

const PORTS: PortsResult = {
  tool: "ss",
  ports: [22, 80, 443, 5432].map((port) => ({
    key: `tcp|0.0.0.0|${port}`,
    proto: "tcp" as const,
    ip: "0.0.0.0",
    iface: null,
    port,
    family: 4 as const,
    scope: "public" as const,
    procs: [{ name: port === 5432 ? "postgres" : port === 22 ? "sshd" : "nginx", pid: port }],
    user: "root",
    unit: null,
    container: null,
  })),
};

function report(id: string, at: number, tweak: (c: Check) => Check): AuditReport {
  const vuln = { createdAt: new Date(at - 2 * DAY).toISOString(), summary: { critical: 0, high: 3, medium: 8, low: 2, unknown: 0, total: 13, withFix: 9, unimportant: 0 } };
  const { checks: raw, os } = runChecks({ stdout: UBUNTU_SERVER, elevated: true, ports: PORTS, web: null, vuln, now: at });
  // Menos problemas que la salida de ejemplo (que los tiene casi todos), para que se vea un servidor real.
  const calm = new Set(["users.uid0", "users.empty", "hard.shadow", "hard.wwetc", "ctr.privileged", "ssh.keys", "system.disk"]);
  const checks = raw.map((c) => (calm.has(c.id) ? { ...c, status: "ok" as const, items: [], fix: null, detail: okText(c.id) } : c)).map(tweak);
  const s = scoreChecks(checks);
  return { id, serverId: "s-web", createdAt: new Date(at).toISOString(), durationMs: 6400, elevated: true, os, ...s, checks, ai: null };
}

function okText(id: string): string {
  return (
    {
      "users.uid0": "Solo root tiene UID 0",
      "users.empty": "Todas las cuentas tienen contraseña o están bloqueadas",
      "hard.shadow": "shadow, passwd, sudoers y sshd_config con permisos correctos",
      "hard.wwetc": "Ninguno",
      "ctr.privileged": "Ninguno tiene --privileged",
      "ssh.keys": "2 usuarios tienen 3 claves autorizadas: revisa que las reconoces",
      "system.disk": "Todos por debajo del 80 % (máx. 64 %)",
    }[id] ?? ""
  );
}

const PREVIOUS = report("aud-prev", NOW - 6 * DAY, (c) => c);
const LATEST = report("aud-last", NOW - 20 * 60_000, (c) =>
  c.id === "ssh.root" ? { ...c, status: "ok", detail: "root no puede entrar por SSH", fix: null } : c.id === "net.firewall" ? { ...c, status: "ok", detail: "Activo (ufw)", fix: null } : c,
);

const REPORTS = [LATEST, PREVIOUS];

function meta(r: AuditReport) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    elevated: r.elevated,
    score: r.score,
    grade: r.grade,
    bad: r.checks.filter((c) => c.status === "bad").length,
    warn: r.checks.filter((c) => c.status === "warn").length,
    hasAi: false,
  };
}

export const respuestas: Record<string, (a: Args) => unknown> = {
  audit_latest: (a) => (a?.serverId === "s-web" ? LATEST : null),
  audit_history_list: (a) => (a?.serverId === "s-web" ? REPORTS.map(meta) : []),
  audit_history_get: (a) => REPORTS.find((r) => r.id === a?.reportId) ?? LATEST,
  audit_save: (a) => a?.report,
};
