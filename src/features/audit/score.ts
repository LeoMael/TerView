// Notas de la auditoría (0–100 y A–F), resumen en una línea y comparación con la auditoría anterior.
// Funciones puras.
import type { AuditReport, CategoryId, CategoryScore, Check, CheckStatus } from "../../api/audit";

export const CATEGORIES: { id: CategoryId; label: string; weight: number }[] = [
  { id: "ssh", label: "SSH", weight: 3 },
  { id: "users", label: "Usuarios", weight: 2 },
  { id: "net", label: "Red", weight: 3 },
  { id: "updates", label: "Actualizaciones", weight: 3 },
  { id: "web", label: "Certificados", weight: 1 },
  { id: "containers", label: "Contenedores", weight: 1 },
  { id: "system", label: "Sistema", weight: 1 },
  { id: "logins", label: "Intentos de entrada", weight: 1 },
  { id: "hardening", label: "Endurecimiento", weight: 2 },
];

// Criterio de la nota (pensado para que se lea bien, no para castigar):
// - Cada comprobación da su propia nota según su peso (1 leve, 2 medio, 3 grave):
//     «mal»   → 75 − 10·peso  (peso 3: 45 · peso 2: 55 · peso 1: 65)
//     «aviso» → 90 − 3·peso   (peso 3: 81 · peso 2: 84 · peso 1: 87)
//     «bien» → 100; «dato» y «sin comprobar» no cuentan.
// - La categoría toma la PEOR de sus comprobaciones y resta 4 por cada otro problema, sin bajar de 25.
//   Así un solo grave la deja en ~45 (nunca en 0) y varios avisos no la hunden.
// - La general es la media de las categorías con nota, ponderada por `CATEGORIES.weight`.
// - Con algún «mal» de peso 3 la general no pasa de SEVERE_CAP (75, una C): un problema grave se nota
//   aunque lo demás esté bien.
// Las actualizaciones que no son de seguridad son «aviso» (checks.ts); solo las de seguridad son «mal».
const CHECK_SCORE: Partial<Record<CheckStatus, (weight: number) => number>> = {
  bad: (w) => 75 - 10 * w,
  warn: (w) => 90 - 3 * w,
  ok: () => 100,
};
/** Lo que resta cada problema además del peor, y el suelo de una categoría. */
const EXTRA_PROBLEM = 4;
const CATEGORY_FLOOR = 25;
/** Con un problema grave (peso 3) la nota general no pasa de C. */
export const SEVERE_CAP = 75;

/** Nota de una sola comprobación (null si no puntúa). */
export function checkScore(c: Pick<Check, "status" | "weight">): number | null {
  const f = CHECK_SCORE[c.status];
  return f ? f(Math.min(3, Math.max(1, c.weight))) : null;
}

export function grade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function scored(c: Check): boolean {
  return c.status === "ok" || c.status === "warn" || c.status === "bad";
}

function countText(checks: Check[]): string {
  const bad = checks.filter((c) => c.status === "bad").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const parts: string[] = [];
  if (bad) parts.push(`${bad} ${bad === 1 ? "grave" : "graves"}`);
  if (warn) parts.push(`${warn} ${warn === 1 ? "aviso" : "avisos"}`);
  return parts.join(", ");
}

export function categoryScore(id: CategoryId, checks: Check[]): CategoryScore {
  const cat = CATEGORIES.find((c) => c.id === id);
  const mine = checks.filter((c) => c.category === id);
  const label = cat?.label ?? id;
  if (!mine.some(scored)) {
    const skip = mine.some((c) => c.status === "skip");
    return { id, label, score: null, grade: null, summary: skip ? "Sin comprobar" : mine.length ? "Solo información" : "Nada que revisar" };
  }
  const scores = mine.map(checkScore).filter((x): x is number => x !== null);
  const problems = mine.filter((c) => c.status === "bad" || c.status === "warn").length;
  const worst = Math.min(...scores);
  const score = worst === 100 ? 100 : Math.max(CATEGORY_FLOOR, worst - EXTRA_PROBLEM * Math.max(0, problems - 1));
  const skipped = mine.filter((c) => c.status === "skip").length;
  const text = countText(mine) || "Todo bien";
  return { id, label, score, grade: grade(score), summary: skipped ? `${text} · ${skipped} sin comprobar` : text };
}

export interface Scores {
  score: number | null;
  grade: string | null;
  summary: string;
  categories: CategoryScore[];
}

export function scoreChecks(checks: Check[]): Scores {
  const categories = CATEGORIES.map((c) => categoryScore(c.id, checks));
  let sum = 0;
  let weights = 0;
  for (const c of categories) {
    if (c.score === null) continue;
    const w = CATEGORIES.find((x) => x.id === c.id)?.weight ?? 1;
    sum += c.score * w;
    weights += w;
  }
  if (!weights) return { score: null, grade: null, summary: "No se pudo comprobar nada", categories };
  let score = Math.round(sum / weights);
  if (checks.some((c) => c.status === "bad" && c.weight >= 3)) score = Math.min(score, SEVERE_CAP);
  const skipped = checks.filter((c) => c.status === "skip").length;
  const text = countText(checks);
  const summary = `${text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Sin problemas"}${skipped ? ` · ${skipped} sin comprobar` : ""}`;
  return { score, grade: grade(score), summary, categories };
}

// ───────── Comparación ─────────

export type Change = "better" | "worse" | "new";

const RANK: Partial<Record<CheckStatus, number>> = { ok: 0, warn: 1, bad: 2 };

export interface Comparison {
  previousAt: string;
  scoreDelta: number | null;
  changes: Map<string, Change>;
  better: number;
  worse: number;
}

/** Qué mejoró o empeoró respecto a la auditoría anterior (solo lo que se comprobó en las dos). */
export function compare(cur: AuditReport, prev: AuditReport | null): Comparison | null {
  if (!prev) return null;
  const before = new Map(prev.checks.map((c) => [c.id, c]));
  const changes = new Map<string, Change>();
  for (const c of cur.checks) {
    const r = RANK[c.status];
    if (r === undefined) continue;
    const old = before.get(c.id);
    const o = old ? RANK[old.status] : undefined;
    if (o === undefined) {
      if (!old && r > 0) changes.set(c.id, "new");
      continue;
    }
    if (r < o) changes.set(c.id, "better");
    else if (r > o) changes.set(c.id, "worse");
  }
  const vals = [...changes.values()];
  return {
    previousAt: prev.createdAt,
    scoreDelta: cur.score !== null && prev.score !== null ? cur.score - prev.score : null,
    changes,
    better: vals.filter((v) => v === "better").length,
    worse: vals.filter((v) => v === "worse" || v === "new").length,
  };
}

/** Orden para mostrar: lo grave primero, luego avisos, sin comprobar, información y lo que está bien. */
export function statusOrder(s: CheckStatus): number {
  return { bad: 0, warn: 1, skip: 2, info: 3, ok: 4 }[s];
}
