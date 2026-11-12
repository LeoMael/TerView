// Respuestas de la pestaña «Administración» → Vulnerabilidades: un informe ya hecho de web-prod
// (Ubuntu 24.04) y el anterior del historial. (Los scripts por stdin los resuelve motor.ts con salidas/admin.ts.)
import type { Finding, Report, ReportMeta, Severity, SourceId, Summary, Target } from "../../../../src/api/vulnscan";

type Args = Record<string, unknown> | undefined;

// ───────── Informe de vulnerabilidades ─────────

const SYSTEM = "system";
const RUNTIME = "runtime";
const IMAGE = "image:docker::3f9a1c0d7e21";

interface F {
  id: string;
  pkg: string;
  bin?: string[];
  installed: string;
  fixed: string | null;
  severity: Severity;
  distroSeverity?: string;
  cvss: number | null;
  summary: string;
  advisories?: string[];
  target?: string;
  sources?: SourceId[];
  kernel?: boolean;
  ecosystem?: string;
  upstream?: boolean;
  status?: string;
}

function finding(x: F): Finding {
  const target = x.target ?? SYSTEM;
  return {
    key: `${x.id}|${x.pkg}|${target}`,
    id: x.id,
    aliases: [],
    advisories: x.advisories ?? [],
    package: x.pkg,
    binaries: x.bin ?? [x.pkg],
    installed: x.installed,
    fixed: x.fixed,
    hasFix: x.fixed !== null,
    severity: x.severity,
    distroSeverity: x.distroSeverity ?? null,
    cvss: x.cvss,
    cvssVector: null,
    unimportant: false,
    status: x.status ?? (x.fixed ? "fixed" : "deferred"),
    summary: x.summary,
    target,
    sources: x.sources ?? ["osv", "distro"],
    kernel: x.kernel ?? false,
    ecosystem: x.ecosystem ?? "Ubuntu:24.04:LTS",
    upstream: x.upstream ?? false,
  };
}

const KERNEL = "6.8.0-49.49";
const KERNEL_FIX = "6.8.0-63.66";

const FINDINGS: Finding[] = [
  finding({
    id: "CVE-2025-32463",
    pkg: "sudo",
    installed: "1.9.15p5-3ubuntu5",
    fixed: "1.9.15p5-3ubuntu5.24.04.1",
    severity: "critical",
    distroSeverity: "high",
    cvss: 9.3,
    summary: "sudo: la opción --chroot permite a un usuario local cargar una biblioteca propia y ejecutar código como root.",
    advisories: ["USN-7604-1"],
  }),
  finding({
    id: "CVE-2024-45337",
    pkg: "golang.org/x/crypto",
    installed: "0.21.0",
    fixed: "0.31.0",
    severity: "critical",
    distroSeverity: "CRITICAL",
    cvss: 9.1,
    summary: "x/crypto/ssh: un uso incorrecto de PublicKeyCallback puede saltarse la autorización.",
    target: IMAGE,
    sources: ["trivy"],
    ecosystem: "Go",
  }),
  finding({
    id: "CVE-2024-6387",
    pkg: "openssh",
    bin: ["openssh-server", "openssh-client", "openssh-sftp-server"],
    installed: "1:9.6p1-3ubuntu13",
    fixed: "1:9.6p1-3ubuntu13.3",
    severity: "high",
    distroSeverity: "high",
    cvss: 8.1,
    summary: "OpenSSH (regreSSHion): condición de carrera en el manejador de señales de sshd que permite ejecutar código remoto.",
    advisories: ["USN-6859-1"],
  }),
  finding({
    id: "CVE-2024-2961",
    pkg: "glibc",
    bin: ["libc6", "libc-bin", "locales"],
    installed: "2.39-0ubuntu8",
    fixed: "2.39-0ubuntu8.1",
    severity: "high",
    distroSeverity: "medium",
    cvss: 7.3,
    summary: "glibc: desbordamiento al convertir a ISO-2022-CN-EXT con iconv().",
    advisories: ["USN-6737-1"],
  }),
  finding({
    id: "CVE-2025-6020",
    pkg: "pam",
    bin: ["libpam-modules", "libpam-modules-bin", "libpam-runtime", "libpam0g"],
    installed: "1.5.3-5ubuntu5.1",
    fixed: "1.5.3-5ubuntu5.4",
    severity: "high",
    distroSeverity: "medium",
    cvss: 7.8,
    summary: "linux-pam: pam_namespace sigue enlaces simbólicos de rutas controladas por el usuario y permite subir a root.",
  }),
  finding({
    id: "CVE-2024-27983",
    pkg: "node",
    installed: "20.11.1",
    fixed: "20.12.1",
    severity: "high",
    distroSeverity: "HIGH",
    cvss: 8.2,
    summary: "Node.js: condición de carrera en HTTP/2 que puede tumbar el proceso con unas pocas conexiones.",
    target: RUNTIME,
    sources: ["osv"],
    ecosystem: "npm",
    upstream: true,
  }),
  finding({
    id: "CVE-2024-53104",
    pkg: "linux",
    bin: [`linux-image-${KERNEL.replace(/\.\d+$/, "")}-generic`],
    installed: KERNEL,
    fixed: KERNEL_FIX,
    severity: "high",
    distroSeverity: "high",
    cvss: 7.8,
    summary: "Kernel: escritura fuera de límites en el controlador uvcvideo.",
    kernel: true,
  }),
  finding({
    id: "CVE-2025-21756",
    pkg: "linux",
    bin: [`linux-image-${KERNEL.replace(/\.\d+$/, "")}-generic`],
    installed: KERNEL,
    fixed: KERNEL_FIX,
    severity: "high",
    distroSeverity: "high",
    cvss: 7.8,
    summary: "Kernel: uso tras liberar en vsock al reasignar un socket.",
    kernel: true,
  }),
  finding({
    id: "CVE-2024-50264",
    pkg: "linux",
    bin: [`linux-image-${KERNEL.replace(/\.\d+$/, "")}-generic`],
    installed: KERNEL,
    fixed: KERNEL_FIX,
    severity: "medium",
    distroSeverity: "medium",
    cvss: 7.8,
    summary: "Kernel: uso tras liberar en virtio_vsock.",
    kernel: true,
  }),
  finding({
    id: "CVE-2025-23419",
    pkg: "nginx",
    bin: ["nginx", "nginx-common"],
    installed: "1.24.0-2ubuntu7.1",
    fixed: "1.24.0-2ubuntu7.3",
    severity: "medium",
    distroSeverity: "medium",
    cvss: 5.3,
    summary: "nginx: la reanudación de sesiones TLS puede saltarse la verificación de certificados de cliente entre sitios.",
  }),
  finding({
    id: "CVE-2024-7347",
    pkg: "nginx",
    bin: ["nginx", "nginx-common"],
    installed: "1.24.0-2ubuntu7",
    fixed: "1.24.0-2ubuntu7.1",
    severity: "medium",
    distroSeverity: "medium",
    cvss: 4.7,
    summary: "nginx: lectura fuera de límites en el módulo mp4 con archivos manipulados.",
  }),
  finding({
    id: "CVE-2025-9230",
    pkg: "openssl",
    bin: ["openssl", "libssl3t64"],
    installed: "3.0.13-0ubuntu3.4",
    fixed: "3.0.13-0ubuntu3.6",
    severity: "medium",
    distroSeverity: "medium",
    cvss: 5.6,
    summary: "OpenSSL: lectura y escritura fuera de límites al descifrar mensajes CMS cifrados con contraseña.",
  }),
  finding({
    id: "CVE-2025-32462",
    pkg: "sudo",
    installed: "1.9.15p5-3ubuntu5",
    fixed: "1.9.15p5-3ubuntu5.24.04.1",
    severity: "low",
    distroSeverity: "low",
    cvss: 2.8,
    summary: "sudo: la opción -h/--host aplica reglas de otro equipo al listar o ejecutar comandos.",
    advisories: ["USN-7604-1"],
  }),
  finding({
    id: "CVE-2024-9143",
    pkg: "openssl",
    bin: ["openssl", "libssl3t64"],
    installed: "3.0.13-0ubuntu3.4",
    fixed: "3.0.13-0ubuntu3.5",
    severity: "low",
    distroSeverity: "low",
    cvss: 4.3,
    summary: "OpenSSL: acceso fuera de límites con parámetros de curva elíptica GF(2^m) poco habituales.",
  }),
  finding({
    id: "CVE-2025-6170",
    pkg: "libxml2",
    bin: ["libxml2"],
    installed: "2.9.14+dfsg-1.3ubuntu3.3",
    fixed: null,
    severity: "low",
    distroSeverity: "low",
    cvss: 2.5,
    summary: "libxml2: desbordamiento de pila en el intérprete interactivo de xmllint.",
  }),
];
// La de nginx mp4 ya se arregló al actualizar: solo sale en el informe anterior.
const CURRENT = FINDINGS.filter((f) => f.id !== "CVE-2024-7347");

function summarize(fs: Finding[]): Summary {
  const s: Summary = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: fs.length, withFix: 0, unimportant: 0 };
  for (const f of fs) {
    s[f.severity] += 1;
    if (f.hasFix) s.withFix += 1;
  }
  return s;
}

const TARGETS: Target[] = [
  {
    key: SYSTEM,
    kind: "system",
    label: "Sistema",
    user: null,
    ecosystem: "Ubuntu:24.04:LTS",
    packages: 742,
    image: null,
    sources: ["osv", "distro"],
    error: null,
  },
  {
    key: RUNTIME,
    kind: "runtime",
    label: "Programas sueltos",
    user: null,
    ecosystem: null,
    packages: 3,
    image: null,
    sources: ["osv"],
    error: null,
  },
  {
    key: IMAGE,
    kind: "image",
    label: "tienda-api:2.3",
    user: null,
    ecosystem: "Debian:12",
    packages: 118,
    image: {
      engine: "docker",
      id: "3f9a1c0d7e21",
      tags: ["tienda-api:2.3"],
      containers: [{ id: "a81c3e5f9d20", name: "tienda-api", state: "running" }],
      os: "debian 12.8",
      method: "trivy",
    },
    sources: ["trivy"],
    error: null,
  },
];

function report(id: string, createdAt: string, findings: Finding[], durationMs: number): Report {
  return {
    id,
    serverId: "s-web",
    createdAt,
    durationMs,
    elevated: true,
    host: {
      os: {
        id: "ubuntu",
        idLike: ["debian"],
        versionId: "24.04",
        version: "24.04.3 LTS (Noble Numbat)",
        versionCodename: "noble",
        prettyName: "Ubuntu 24.04.3 LTS",
        name: "Ubuntu",
      },
      kernel: `${KERNEL.replace(/\.\d+$/, "")}-generic`,
      arch: "x86_64",
      packageManager: "dpkg",
      ecosystem: "Ubuntu:24.04:LTS",
      inContainer: false,
      tools: ["pro", "docker", "trivy"],
    },
    sources: [
      { id: "osv", label: "OSV.dev", used: true, note: null },
      { id: "distro", label: "Ubuntu (pro)", used: true, note: null },
      { id: "trivy", label: "Trivy", used: true, note: "0.58.1" },
    ],
    targets: TARGETS,
    programs: [
      { name: "node", path: "/usr/local/bin/node", version: "20.11.1", owner: null, thirdParty: true, upstreamEcosystem: "npm" },
      { name: "docker-compose", path: "/usr/local/bin/docker-compose", version: "2.29.7", owner: null, thirdParty: true, upstreamEcosystem: "Go" },
      { name: "node_exporter", path: "/usr/local/bin/node_exporter", version: "1.8.2", owner: null, thirdParty: true, upstreamEcosystem: "Go" },
    ],
    findings,
    summary: summarize(findings),
    notes: [],
    ai: null,
    osvSample: [
      { ecosystem: "Ubuntu:24.04:LTS", name: "openssh", version: "1:9.6p1-3ubuntu13" },
      { ecosystem: "Ubuntu:24.04:LTS", name: "sudo", version: "1.9.15p5-3ubuntu5" },
      { ecosystem: "Ubuntu:24.04:LTS", name: "nginx", version: "1.24.0-2ubuntu7.1" },
      { ecosystem: "npm", name: "node", version: "20.11.1" },
    ],
  };
}

const LATEST = report("r-20261112-0912", "2026-11-12T23:58:40Z", CURRENT, 48_210);
// El anterior: sin las dos de sudo (aún no publicadas) y con dos que ya se arreglaron desde entonces.
const PREVIOUS = report(
  "r-20261029-1840",
  "2026-10-29T23:40:05Z",
  [...FINDINGS.filter((f) => f.package !== "sudo"), finding({
    id: "CVE-2024-6119",
    pkg: "openssl",
    bin: ["openssl", "libssl3t64"],
    installed: "3.0.13-0ubuntu3.1",
    fixed: "3.0.13-0ubuntu3.4",
    severity: "medium",
    cvss: 7.5,
    summary: "OpenSSL: lectura no válida al comprobar nombres otherName de un certificado.",
  })],
  51_870,
);

function meta(r: Report): ReportMeta {
  return {
    id: r.id,
    createdAt: r.createdAt,
    durationMs: r.durationMs,
    elevated: r.elevated,
    summary: r.summary,
    sources: r.sources.filter((s) => s.used).map((s) => s.label),
    distro: r.host.os.prettyName,
    hasAi: !!r.ai,
  };
}

const REPORTS = [LATEST, PREVIOUS];

export const respuestas: Record<string, (a: Args) => unknown> = {
  vulnscan_latest: (a) => (a?.serverId === "s-web" ? LATEST : null),
  vulnscan_history_list: (a) => (a?.serverId === "s-web" ? REPORTS.map(meta) : []),
  vulnscan_history_get: (a) => REPORTS.find((r) => r.id === a?.reportId) ?? LATEST,
  vulnscan_vuln_detail: (a) => {
    const f = FINDINGS.find((x) => x.id === a?.id);
    return {
      id: String(a?.id ?? ""),
      summary: f?.summary ?? null,
      details: f?.summary ?? null,
      aliases: [],
      published: "2025-06-30T00:00:00Z",
      modified: "2025-07-15T00:00:00Z",
      references: [],
    };
  },
};
