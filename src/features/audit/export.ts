// Exportar una auditoría a Markdown o HTML (un solo archivo, sin recursos externos). Funciones puras.
import type { AuditReport, CheckStatus } from "../../api/audit";
import { CATEGORIES, statusOrder, type Comparison } from "./score";

export const STATUS_TEXT: Record<CheckStatus, string> = { ok: "Bien", warn: "Aviso", bad: "Mal", info: "Dato", skip: "Sin comprobar" };
const CHANGE_TEXT = { better: "mejoró", worse: "empeoró", new: "nuevo" } as const;

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });
}

function sortedChecks(r: AuditReport) {
  const order = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  return [...r.checks].sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || statusOrder(a.status) - statusOrder(b.status));
}

function compareLine(cmp: Comparison | null): string | null {
  if (!cmp) return null;
  const delta = cmp.scoreDelta === null ? "" : `${cmp.scoreDelta > 0 ? "+" : ""}${cmp.scoreDelta} puntos · `;
  return `Respecto al ${dateText(cmp.previousAt)}: ${delta}${cmp.better} mejoras, ${cmp.worse} empeoran`;
}

export function toMarkdown(r: AuditReport, serverName: string | null, cmp: Comparison | null = null): string {
  const out: string[] = [];
  out.push(`# Auditoría de ${serverName ?? "servidor"}`, "");
  out.push(`- Fecha: ${dateText(r.createdAt)}`);
  if (r.os) out.push(`- Sistema: ${r.os}`);
  out.push(`- Con sudo: ${r.elevated ? "sí" : "no (lo que lo necesita queda sin comprobar)"}`);
  out.push(`- **Nota: ${r.score ?? "—"}/100 (${r.grade ?? "—"})** · ${r.summary}`);
  const c = compareLine(cmp);
  if (c) out.push(`- ${c}`);
  out.push("", "| Categoría | Nota | Resumen |", "|---|---|---|");
  for (const cat of r.categories) out.push(`| ${cat.label} | ${cat.score === null ? "—" : `${cat.score} (${cat.grade})`} | ${cat.summary} |`);
  out.push("");
  let last = "";
  for (const ch of sortedChecks(r)) {
    if (ch.category !== last) {
      last = ch.category;
      out.push(`## ${CATEGORIES.find((x) => x.id === ch.category)?.label ?? ch.category}`, "");
    }
    const change = cmp?.changes.get(ch.id);
    out.push(`- **${STATUS_TEXT[ch.status]}** · ${ch.title}: ${ch.detail}${change ? ` _(${CHANGE_TEXT[change]})_` : ""}`);
    for (const i of ch.items.slice(0, 30)) out.push(`  - ${i}`);
    if (ch.items.length > 30) out.push(`  - … y ${ch.items.length - 30} más`);
    if (ch.fix && (ch.status === "bad" || ch.status === "warn")) {
      out.push(`  - ${ch.fix.manual ? "Para revisar a mano" : "Arreglo"}${ch.fix.note ? ` (${ch.fix.note})` : ""}:`, "", "    ```sh");
      for (const l of ch.fix.command.split("\n")) out.push(`    ${l}`);
      out.push("    ```", "");
    }
  }
  out.push("", "_Generado por SSHorus. Comprobaciones fijas, sin IA._");
  if (r.ai) out.push("", "## Explicación de la IA", "", `_Texto generado por IA (${r.ai.model}): revísalo._`, "", r.ai.text);
  return `${out.join("\n")}\n`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const COLORS: Record<CheckStatus, string> = { ok: "#2e9d5b", warn: "#c98a00", bad: "#d64545", info: "#5b7fa8", skip: "#888" };

export function toHtml(r: AuditReport, serverName: string | null, cmp: Comparison | null = null): string {
  const name = esc(serverName ?? "servidor");
  const rows = r.categories
    .map((c) => `<tr><td>${esc(c.label)}</td><td class="n">${c.score === null ? "—" : `${c.score} <b>${esc(c.grade ?? "")}</b>`}</td><td>${esc(c.summary)}</td></tr>`)
    .join("");
  let last = "";
  const body: string[] = [];
  for (const ch of sortedChecks(r)) {
    if (ch.category !== last) {
      if (last) body.push("</ul>");
      last = ch.category;
      body.push(`<h2>${esc(CATEGORIES.find((x) => x.id === ch.category)?.label ?? ch.category)}</h2><ul>`);
    }
    const change = cmp?.changes.get(ch.id);
    const items = ch.items.length ? `<ul class="it">${ch.items.slice(0, 50).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
    const fx =
      ch.fix && (ch.status === "bad" || ch.status === "warn")
        ? `<div class="fx">${ch.fix.manual ? "Para revisar a mano" : "Arreglo"}${ch.fix.note ? ` · ${esc(ch.fix.note)}` : ""}<pre>${esc(ch.fix.command)}</pre></div>`
        : "";
    body.push(
      `<li><span class="st" style="background:${COLORS[ch.status]}">${STATUS_TEXT[ch.status]}</span> <b>${esc(ch.title)}</b>: ${esc(ch.detail)}${change ? ` <i>(${CHANGE_TEXT[change]})</i>` : ""}${items}${fx}</li>`,
    );
  }
  if (last) body.push("</ul>");
  const c = compareLine(cmp);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auditoría de ${name}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 6px;border-bottom:1px solid #ddd}
.meta{color:#666}.score{font-size:28px;font-weight:700}table{border-collapse:collapse;width:100%;margin:12px 0}
td{border-bottom:1px solid #eee;padding:4px 8px}.n{white-space:nowrap}ul{padding-left:18px}li{margin:4px 0}
.st{color:#fff;border-radius:4px;padding:0 6px;font-size:12px}.it{color:#555;font-size:13px}
.fx{font-size:13px;color:#555}pre{background:#f4f4f4;padding:8px;border-radius:4px;overflow:auto;white-space:pre-wrap}
@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#ddd}pre{background:#2a2a2a}td{border-color:#333}.meta,.it,.fx{color:#aaa}}
</style></head><body>
<h1>Auditoría de ${name}</h1>
<div class="meta">${esc(dateText(r.createdAt))}${r.os ? ` · ${esc(r.os)}` : ""} · ${r.elevated ? "con sudo" : "sin sudo"}</div>
<p><span class="score">${r.score ?? "—"}/100 · ${esc(r.grade ?? "—")}</span><br>${esc(r.summary)}${c ? `<br><span class="meta">${esc(c)}</span>` : ""}</p>
<table>${rows}</table>
${body.join("\n")}
${r.ai ? `<h2>Explicación de la IA</h2><p class="meta">Texto generado por IA (${esc(r.ai.model)}): revísalo.</p><pre>${esc(r.ai.text)}</pre>` : ""}
<p class="meta">Generado por SSHorus. Comprobaciones fijas, sin IA.</p>
</body></html>
`;
}
