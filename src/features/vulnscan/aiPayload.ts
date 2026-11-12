// Texto EXACTO que se envía a la IA para que explique un informe (PENDIENTES 10.8). Funciones puras.
//
// Qué va: distro y versión, arquitectura y hasta 60 hallazgos ordenados por gravedad (CVE, paquete,
// versiones, gravedad, si tiene arreglo y un origen genérico: «sistema», «programas sueltos»,
// «imagen-2 (nginx:1.25)»).
// Qué NO va nunca: nombre del servidor (se llama «servidor-1»), IP, puerto, nombres de usuario, rutas
// (de $HOME o cualquier otra), nombres de contenedores, host del registro de las imágenes, contraseñas
// ni tokens.
import type { ChatMessage, Finding, Report, Severity, Target } from "../../api/vulnscan";

export const AI_MAX_FINDINGS = 60;

export const AI_SYSTEM_PROMPT = [
  "Eres un asistente de seguridad de sistemas. Responde en español y en lenguaje simple.",
  "Te paso el informe de vulnerabilidades de un servidor (servidor-1) en JSON.",
  "Explica qué es lo más urgente y por qué, y prioriza.",
  "Usa SOLO los CVE y avisos de la lista: no inventes otros ni añadas versiones que no estén.",
  "Propón los comandos para actualizar en esta distro (en bloques de código) y di si hace falta reiniciar.",
  "Para imágenes de contenedores, propone actualizar la imagen y recrear el contenedor, no instalar paquetes dentro.",
  "Si algo no tiene arreglo todavía, dilo y sugiere cómo reducir el riesgo.",
].join(" ");

export interface AiPayloadOptions {
  includeSystem: boolean;
  includeRuntimes: boolean;
  includeImages: boolean;
  /** Las imágenes se llaman solo «imagen-1», sin su nombre. */
  hideImageNames: boolean;
  /** Incluir lo que Debian marca «sin importancia». */
  includeUnimportant: boolean;
}

export const DEFAULT_AI_OPTIONS: AiPayloadOptions = {
  includeSystem: true,
  includeRuntimes: true,
  includeImages: true,
  hideImageNames: false,
  includeUnimportant: false,
};

const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "unknown"];
const SEV_ES: Record<Severity, string> = {
  critical: "crítica",
  high: "alta",
  medium: "media",
  low: "baja",
  unknown: "sin clasificar",
};

/**
 * Quita el host del registro y el prefijo «library/» de una referencia de imagen:
 * «registry.example.com:5000/equipo/app:1.2» → «equipo/app:1.2»; «docker.io/library/nginx:1.25» → «nginx:1.25».
 */
export function stripRegistry(ref: string): string {
  const parts = ref.split("/");
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) parts.shift();
  if (parts.length > 1 && parts[0] === "library") parts.shift();
  return parts.join("/");
}

/** Nombre genérico de cada objetivo: «sistema», «programas sueltos», «imagen-N (repo:tag)». */
export function genericOrigins(report: Report, hideImageNames: boolean): Map<string, string> {
  const m = new Map<string, string>();
  let n = 0;
  for (const t of report.targets) {
    if (t.kind === "system") m.set(t.key, "sistema");
    else if (t.kind === "runtime") m.set(t.key, "programas sueltos");
    else {
      n += 1;
      const tag = t.image?.tags[0];
      m.set(t.key, hideImageNames || !tag ? `imagen-${n}` : `imagen-${n} (${stripRegistry(tag)})`);
    }
  }
  return m;
}

function kindOf(report: Report, f: Finding): Target["kind"] | undefined {
  return report.targets.find((t) => t.key === f.target)?.kind;
}

/** Hallazgos que se envían, ya filtrados y ordenados (máximo 60). */
export function selectFindings(report: Report, opts: AiPayloadOptions): Finding[] {
  const ok = report.findings.filter((f) => {
    if (f.unimportant && !opts.includeUnimportant) return false;
    const k = kindOf(report, f);
    if (k === "system") return opts.includeSystem;
    if (k === "runtime") return opts.includeRuntimes;
    if (k === "image") return opts.includeImages;
    return false;
  });
  ok.sort(
    (a, b) =>
      SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) ||
      Number(b.hasFix) - Number(a.hasFix) ||
      (b.cvss ?? 0) - (a.cvss ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return ok.slice(0, AI_MAX_FINDINGS);
}

/** Recorta y deja una sola línea (los resúmenes de OSV pueden ser largos). */
function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Quita rutas absolutas que pudieran colarse en un texto. */
function noPaths(s: string): string {
  return s.replace(/(^|[\s("'])\/(?:[^\s/)"']+\/)*[^\s)"']*/g, "$1[ruta]");
}

export interface AiPayload {
  /** Objeto que se envía (como JSON legible). */
  data: Record<string, unknown>;
  /** Hallazgos incluidos (de los que había). */
  included: number;
  available: number;
}

export function buildAiPayload(report: Report, opts: AiPayloadOptions): AiPayload {
  const origins = genericOrigins(report, opts.hideImageNames);
  const all = selectFindings(report, { ...opts });
  const available = report.findings.filter((f) => opts.includeUnimportant || !f.unimportant).length;
  const os = report.host.os;
  const s = report.summary;
  const data: Record<string, unknown> = {
    servidor: "servidor-1",
    sistema: os.prettyName || [os.name, os.versionId].filter(Boolean).join(" ") || os.id,
    arquitectura: report.host.arch || null,
    kernel: report.host.inContainer ? "del anfitrión (es un contenedor)" : report.host.kernel || null,
    gestor_de_paquetes: report.host.packageManager,
    resumen: { critica: s.critical, alta: s.high, media: s.medium, baja: s.low, sin_clasificar: s.unknown, con_arreglo: s.withFix },
    hallazgos_enviados: all.length,
    hallazgos: all.map((f) => ({
      id: f.id,
      avisos: f.advisories.length ? f.advisories : undefined,
      paquete: f.package,
      instalada: f.installed || null,
      arreglada: f.fixed,
      tiene_arreglo: f.hasFix,
      gravedad: SEV_ES[f.severity],
      gravedad_distro: f.distroSeverity ?? undefined,
      cvss: f.cvss ?? undefined,
      kernel: f.kernel || undefined,
      origen: origins.get(f.target) ?? "sistema",
      resumen: f.summary ? noPaths(oneLine(f.summary, 160)) : undefined,
    })),
  };
  return { data, included: all.length, available };
}

/** Mensajes exactos para `ai.chat` (lo mismo que se enseña en la vista previa). */
export function buildAiMessages(report: Report, opts: AiPayloadOptions): ChatMessage[] {
  const p = buildAiPayload(report, opts);
  return [
    { role: "system", content: AI_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Informe de vulnerabilidades (solo lectura, sacado de OSV.dev y de las herramientas de la distro):\n\n${JSON.stringify(p.data, null, 2)}`,
    },
  ];
}
