// «Explicar con IA» de la auditoría: el texto EXACTO que se envía. Solo notas, títulos y la explicación
// de una línea de cada comprobación (que no llevan usuarios, IP, rutas ni secretos). Nunca `items` ni
// los comandos de arreglo.
import type { AuditReport } from "../../api/audit";
import type { ChatMessage } from "../../api/vulnscan";
import { STATUS_TEXT } from "./export";
import { statusOrder } from "./score";

export const AUDIT_AI_SYSTEM = [
  "Eres un administrador de sistemas Linux que explica auditorías de seguridad a alguien que no es experto.",
  "Responde en español, en Markdown, breve y claro.",
  "1) Resume en 2 o 3 frases cómo está el servidor.",
  "2) Ordena qué arreglar primero y por qué (máximo 5 puntos).",
  "3) Para cada punto, da el paso concreto. Si das comandos, ponlos en bloques ```sh``` y avisa si pueden cortar el acceso.",
  "No inventes problemas que no estén en la lista.",
].join("\n");

export function buildAuditAiText(r: AuditReport, includeOk: boolean): string {
  const out: string[] = [];
  out.push(`Auditoría de un servidor (servidor-1)${r.os ? `, ${r.os}` : ""}, ${r.elevated ? "con sudo" : "sin sudo"}.`);
  out.push(`Nota general: ${r.score ?? "?"}/100 (${r.grade ?? "?"}). ${r.summary}.`, "", "Notas por categoría:");
  for (const c of r.categories) out.push(`- ${c.label}: ${c.score === null ? "sin nota" : `${c.score} (${c.grade})`} · ${c.summary}`);
  out.push("", "Comprobaciones:");
  const list = r.checks
    .filter((c) => includeOk || (c.status !== "ok" && c.status !== "info"))
    .sort((a, b) => statusOrder(a.status) - statusOrder(b.status));
  for (const c of list) out.push(`- [${STATUS_TEXT[c.status]}] ${c.title}: ${c.detail}`);
  return out.join("\n");
}

export function buildAuditAiMessages(r: AuditReport, includeOk: boolean): ChatMessage[] {
  return [
    { role: "system", content: AUDIT_AI_SYSTEM },
    { role: "user", content: buildAuditAiText(r, includeOk) },
  ];
}
