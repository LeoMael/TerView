// Pruebas de funciones puras del escáner (comando sugerido y texto para la IA).
// Ejecutar: npx rolldown src/features/vulnscan/vulnscan.test.ts -p node -f esm -o /tmp/vt.mjs && node /tmp/vt.mjs
import type { Finding, Report, Target } from "../../api/vulnscan";
import { buildAiMessages, buildAiPayload, DEFAULT_AI_OPTIONS, stripRegistry } from "./aiPayload";
import { fixSuggestion, kernelSuggestion } from "./fixCommand";

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
  passed++;
}

function finding(p: Partial<Finding>): Finding {
  return {
    key: `${p.id}|${p.package}|${p.target ?? "system"}`,
    id: "CVE-2024-0001",
    aliases: [],
    advisories: [],
    package: "openssl",
    binaries: [],
    installed: "1.0",
    fixed: "1.1",
    hasFix: true,
    severity: "high",
    distroSeverity: null,
    cvss: null,
    cvssVector: null,
    unimportant: false,
    status: null,
    summary: null,
    target: "system",
    sources: ["osv"],
    kernel: false,
    ecosystem: null,
    upstream: false,
    ...p,
  };
}

const targets: Target[] = [
  { key: "system", kind: "system", label: "Sistema", user: null, ecosystem: "Debian:12", packages: 100, image: null, sources: ["osv"], error: null },
  { key: "runtime", kind: "runtime", label: "Programas sueltos", user: null, ecosystem: null, packages: 1, image: null, sources: ["osv"], error: null },
  {
    key: "image:podman:maria:abcdef123456",
    kind: "image",
    label: "Imagen registry.miempresa.local:5000/equipo/app:1.2 (abcdef123456) · maria",
    user: "maria",
    ecosystem: "Alpine:v3.18",
    packages: 10,
    image: {
      engine: "podman",
      id: "abcdef123456",
      tags: ["registry.miempresa.local:5000/equipo/app:1.2"],
      containers: [{ id: "c1", name: "contenedor-secreto", state: "running" }],
      os: "Alpine Linux v3.18",
      method: "montada",
    },
    sources: ["osv"],
    error: null,
  },
];

function report(host: Partial<Report["host"]>, findings: Finding[]): Report {
  return {
    id: "r1",
    serverId: "srv-uuid-123",
    createdAt: "2026-11-12T10:00:00Z",
    durationMs: 1000,
    elevated: true,
    host: {
      os: { id: "debian", idLike: [], versionId: "12", version: "12 (bookworm)", versionCodename: "bookworm", prettyName: "Debian GNU/Linux 12 (bookworm)", name: "Debian GNU/Linux" },
      kernel: "6.1.0-9-amd64",
      arch: "x86_64",
      packageManager: "dpkg",
      ecosystem: "Debian:12",
      inContainer: false,
      tools: ["podman"],
      ...host,
    },
    sources: [],
    targets,
    programs: [{ name: "node", path: "/home/maria/.nvm/versions/node/v18.0.0/bin/node", version: "18.0.0", owner: null, thirdParty: false, upstreamEcosystem: "Bitnami" }],
    findings,
    summary: { critical: 1, high: 1, medium: 0, low: 0, unknown: 0, total: 2, withFix: 2, unimportant: 0 },
    notes: [{ phase: "images", level: "info", text: "Usuario maria en /home/maria" }],
    ai: null,
    osvSample: [],
  };
}

// ── stripRegistry ──
eq(stripRegistry("docker.io/library/nginx:1.25"), "nginx:1.25", "docker.io/library");
eq(stripRegistry("registry.miempresa.local:5000/equipo/app:1.2"), "equipo/app:1.2", "registro privado con puerto");
eq(stripRegistry("localhost/app:dev"), "app:dev", "localhost");
eq(stripRegistry("nginx:alpine"), "nginx:alpine", "sin registro");
eq(stripRegistry("equipo/app:1"), "equipo/app:1", "usuario de Docker Hub");

// ── Texto para la IA ──
{
  const fs: Finding[] = [];
  for (let i = 0; i < 80; i++) fs.push(finding({ id: `CVE-2024-${1000 + i}`, severity: i < 5 ? "low" : "medium" }));
  fs.push(finding({ id: "CVE-2025-9999", severity: "critical", summary: "Fallo en /home/maria/app/lib.so muy grave" }));
  fs.push(finding({ id: "CVE-2025-8888", package: "node", target: "runtime", upstream: true, binaries: ["/home/maria/.nvm/versions/node/v18.0.0/bin/node"] }));
  fs.push(finding({ id: "CVE-2025-7777", package: "musl", target: "image:podman:maria:abcdef123456", binaries: ["musl"] }));
  fs.push(finding({ id: "CVE-2025-6666", severity: "low", unimportant: true }));
  const r = report({}, fs);
  const msgs = buildAiMessages(r, DEFAULT_AI_OPTIONS);
  const text = msgs.map((m) => m.content).join("\n");
  eq(msgs.length, 2, "dos mensajes");
  eq(msgs[0].role, "system", "primero el de sistema");
  ok(!text.includes("srv-uuid-123"), "no va el id del servidor");
  ok(!text.includes("maria"), "no va el nombre de usuario");
  ok(!text.includes("/home"), "no van rutas de $HOME");
  ok(!text.includes("contenedor-secreto"), "no van nombres de contenedores");
  ok(!text.includes("registry.miempresa.local"), "no va el host del registro");
  ok(text.includes("imagen-1 (equipo/app:1.2)"), "la imagen va como imagen-1 con su nombre sin registro");
  ok(text.includes("servidor-1"), "el servidor se llama servidor-1");
  ok(!text.includes("CVE-2025-6666"), "lo «sin importancia» no va por defecto");
  const p = buildAiPayload(r, DEFAULT_AI_OPTIONS);
  eq(p.included, 60, "como mucho 60 hallazgos");
  const list = p.data.hallazgos as { id: string; gravedad: string }[];
  eq(list[0].id, "CVE-2025-9999", "la crítica va primera");
  ok(list.every((x, i) => i === 0 || !(x.gravedad === "media" && list[i - 1].gravedad === "baja")), "ordenadas por gravedad");

  const hidden = buildAiMessages(r, { ...DEFAULT_AI_OPTIONS, hideImageNames: true }).map((m) => m.content).join("\n");
  ok(hidden.includes('"imagen-1"') && !hidden.includes("equipo/app"), "ocultar nombres de imagen");
  const noImg = buildAiPayload(r, { ...DEFAULT_AI_OPTIONS, includeImages: false });
  ok(!(noImg.data.hallazgos as { id: string }[]).some((x) => x.id === "CVE-2025-7777"), "quitar imágenes");
  const noRt = buildAiPayload(r, { ...DEFAULT_AI_OPTIONS, includeRuntimes: false });
  ok(!(noRt.data.hallazgos as { id: string }[]).some((x) => x.id === "CVE-2025-8888"), "quitar programas sueltos");
}

// ── Comando sugerido por distro ──
{
  const deb = report({}, []);
  const f = finding({ package: "openssl", binaries: ["libssl3", "openssl"], advisories: ["DSA-5000-1"] });
  eq(fixSuggestion(deb, f).command, "sudo apt update && sudo apt install --only-upgrade libssl3 openssl", "Debian: apt --only-upgrade con los binarios");
  eq(fixSuggestion(deb, f, "").command, "apt update && apt install --only-upgrade libssl3 openssl", "como root sin sudo");
  eq(fixSuggestion(deb, finding({ hasFix: false, fixed: null })).command, null, "sin arreglo no hay comando");

  const rocky = report(
    { os: { id: "rocky", idLike: ["rhel", "centos", "fedora"], versionId: "9.0", version: "", versionCodename: "", prettyName: "Rocky Linux 9.0", name: "Rocky Linux" }, packageManager: "rpm", tools: ["dnf"] },
    [],
  );
  eq(fixSuggestion(rocky, finding({ package: "curl", binaries: ["curl", "libcurl"], advisories: ["RLSA-2022:6157"] })).command, "sudo dnf upgrade --advisory=RLSA-2022:6157", "Rocky: dnf --advisory");
  eq(fixSuggestion(rocky, finding({ package: "curl", binaries: ["libcurl"] })).command, "sudo dnf upgrade libcurl", "Rocky sin aviso: dnf upgrade paquete");
  const centos7 = report({ os: { ...rocky.host.os, id: "centos" }, packageManager: "rpm", tools: ["yum"] }, []);
  eq(fixSuggestion(centos7, finding({ package: "curl", advisories: ["RHSA-2020:1"] })).command, "sudo yum upgrade --advisory=RHSA-2020:1", "CentOS 7: yum");

  const alpine = report({ os: { id: "alpine", idLike: [], versionId: "3.18.0", version: "", versionCodename: "", prettyName: "Alpine Linux v3.18", name: "Alpine Linux" }, packageManager: "apk", tools: [] }, []);
  eq(fixSuggestion(alpine, finding({ package: "openssl", binaries: ["libcrypto3", "libssl3"] }), "doas").command, "doas apk update && doas apk upgrade libcrypto3 libssl3", "Alpine con doas");

  const suse = report({ os: { id: "opensuse-leap", idLike: ["suse", "opensuse"], versionId: "15.6", version: "", versionCodename: "", prettyName: "openSUSE Leap 15.6", name: "openSUSE Leap" }, packageManager: "rpm", tools: ["zypper"] }, []);
  eq(fixSuggestion(suse, finding({ id: "CVE-2024-1234" })).command, "sudo zypper patch --cve=CVE-2024-1234", "openSUSE: zypper patch --cve");

  const k = finding({ package: "linux", binaries: ["linux-image-6.1.0-9-amd64"], kernel: true });
  const ks = fixSuggestion(deb, k);
  ok(ks.notes.some((n) => n.includes("reiniciar")), "kernel: avisa de reiniciar");
  ok(ks.notes.some((n) => n.includes("reboot-required")), "kernel Debian: cómo comprobarlo");
  eq(kernelSuggestion(rocky, [finding({ package: "kernel", kernel: true, binaries: ["kernel-core"] })]).command, "sudo dnf upgrade 'kernel*'", "kernel RPM agrupado");

  const img = fixSuggestion(deb, finding({ package: "musl", target: "image:podman:maria:abcdef123456" }));
  eq(img.command, "podman pull registry.miempresa.local:5000/equipo/app:1.2", "imagen: podman pull");
  ok(!img.command?.includes("apt"), "nunca apt dentro de un contenedor");
  ok(img.notes.some((n) => n.includes("contenedor-secreto")), "dice qué contenedores la usan");

  const node = fixSuggestion(deb, finding({ package: "node", target: "runtime", upstream: true, fixed: "18.16.1", binaries: ["/home/maria/.nvm/versions/node/v18.0.0/bin/node"] }));
  eq(node.command, "nvm install 18.16.1", "node con nvm");
  const py = fixSuggestion(deb, finding({ package: "python3", target: "runtime", upstream: true, fixed: "3.10.14", binaries: ["/home/u/.pyenv/versions/3.10.0/bin/python3"] }));
  eq(py.command, "pyenv install 3.10.14", "python con pyenv");
  const caddy = fixSuggestion(deb, finding({ package: "caddy", target: "runtime", upstream: true, binaries: ["/usr/local/bin/caddy"] }));
  eq(caddy.command, null, "programa suelto sin instalador conocido: sin comando");
  eq(fixSuggestion(deb, finding({ package: "x; rm -rf /", binaries: [] })).command, null, "nombres raros no llegan al comando");
}

console.log(`vulnscan.test.ts: ${passed} comprobaciones correctas`);
