// Resultados: resumen, comparación de salidas y exportación a texto (funciones puras).
import type { TargetState, TargetStatus } from "./types";

export const STATUS_LABEL: Record<TargetStatus, string> = {
  queued: "En cola",
  connecting: "Conectando",
  attention: "Requiere atención",
  running: "Ejecutando",
  ok: "Correcto",
  error: "Error",
  timeout: "Tiempo agotado",
  canceled: "Cancelado",
};

/** Primera línea no vacía de la salida (stdout; si no hay, stderr; si no, el detalle). */
export function firstLine(t: TargetState): string {
  const pick = (s: string | undefined | null) =>
    (s ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return pick(t.result?.stdout) || pick(t.result?.stderr) || (t.detail ?? "");
}

/** Duración en ms: de la ejecución si la hubo; si no, desde que empezó a conectar. */
export function targetDuration(t: TargetState, now: number = Date.now()): number | null {
  if (t.result) return t.result.durationMs;
  const start = t.execStartedAt ?? t.connectStartedAt;
  if (start === null) return null;
  return (t.finishedAt ?? now) - start;
}

/** "850 ms", "3,2 s", "1 min 05 s". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(".", ",")} s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m} min ${String(r).padStart(2, "0")} s`;
}

function normOut(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

export interface OutputGroup {
  /** Clave de agrupación. */
  key: string;
  targets: TargetState[];
  status: TargetStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Sin resultado (no llegó a ejecutarse): el texto es el detalle. */
  noResult: boolean;
}

/**
 * Agrupa los servidores con salida idéntica (código + stdout + stderr, ignorando espacios al final).
 * Los que no tienen resultado se agrupan por estado y detalle. Mayor grupo primero.
 */
export function groupIdentical(targets: TargetState[], opts: { ignoreStderr?: boolean } = {}): OutputGroup[] {
  const map = new Map<string, OutputGroup>();
  for (const t of targets) {
    const r = t.result;
    let key: string;
    let g: Omit<OutputGroup, "targets" | "key">;
    if (r) {
      const stdout = normOut(r.stdout);
      const stderr = opts.ignoreStderr ? "" : normOut(r.stderr);
      key = `r\u0000${t.status}\u0000${r.exitCode ?? "null"}\u0000${stdout}\u0000${stderr}`;
      g = { status: t.status, exitCode: r.exitCode, stdout, stderr, noResult: false };
    } else {
      key = `s\u0000${t.status}\u0000${t.detail ?? ""}`;
      g = { status: t.status, exitCode: null, stdout: "", stderr: t.detail ?? "", noResult: true };
    }
    const prev = map.get(key);
    if (prev) prev.targets.push(t);
    else map.set(key, { key, targets: [t], ...g });
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.noResult !== b.noResult) return a.noResult ? 1 : -1;
    return b.targets.length - a.targets.length;
  });
}

export interface RunSummary {
  total: number;
  done: number;
  counts: Record<TargetStatus, number>;
}

export function summarize(targets: TargetState[]): RunSummary {
  const counts: Record<TargetStatus, number> = {
    queued: 0,
    connecting: 0,
    attention: 0,
    running: 0,
    ok: 0,
    error: 0,
    timeout: 0,
    canceled: 0,
  };
  for (const t of targets) counts[t.status]++;
  return {
    total: targets.length,
    done: counts.ok + counts.error + counts.timeout + counts.canceled,
    counts,
  };
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((l) => (l ? prefix + l : l))
    .join("\n");
}

/** Informe en texto plano de toda la ejecución (para el portapapeles). */
export function formatReport(command: string, targets: TargetState[], now: Date = new Date()): string {
  const s = summarize(targets);
  const lines: string[] = [];
  lines.push(`Comando: ${command}`);
  lines.push(`Fecha: ${now.toLocaleString("es")}`);
  const parts = [`${s.counts.ok} correctos`];
  if (s.counts.error) parts.push(`${s.counts.error} con error`);
  if (s.counts.timeout) parts.push(`${s.counts.timeout} sin tiempo`);
  if (s.counts.canceled) parts.push(`${s.counts.canceled} cancelados`);
  if (s.counts.attention) parts.push(`${s.counts.attention} requieren atención`);
  lines.push(`Servidores: ${s.total} (${parts.join(", ")})`);
  for (const t of targets) {
    lines.push("");
    const code = t.result?.exitCode;
    const head = [`== ${t.name} (${t.address})`, STATUS_LABEL[t.status]];
    if (code !== undefined && code !== null) head.push(`código ${code}`);
    const d = targetDuration(t);
    if (d !== null && t.result) head.push(formatDuration(d));
    lines.push(`${head.join(" · ")} ==`);
    if (t.result) {
      const out = normOut(t.result.stdout);
      const err = normOut(t.result.stderr);
      if (out) lines.push(out);
      if (err) {
        lines.push("-- stderr --");
        lines.push(err);
      }
      if (!out && !err) lines.push("(sin salida)");
      if (t.result.truncated) lines.push("(salida recortada)");
    } else if (t.detail) {
      lines.push(t.detail);
    }
  }
  return lines.join("\n") + "\n";
}

/** Resumen en tabla (separado por tabuladores, se pega bien en una hoja de cálculo). */
export function formatTable(targets: TargetState[]): string {
  const rows = [["Servidor", "Dirección", "Estado", "Código", "Duración", "Primera línea"]];
  for (const t of targets) {
    rows.push([
      t.name,
      t.address,
      STATUS_LABEL[t.status],
      t.result?.exitCode === null || t.result?.exitCode === undefined ? "" : String(t.result.exitCode),
      t.result ? formatDuration(t.result.durationMs) : "",
      firstLine(t).replace(/\t/g, " "),
    ]);
  }
  return rows.map((r) => r.join("\t")).join("\n") + "\n";
}

/** Informe de un grupo de "Comparar salidas". */
export function formatGroups(command: string, groups: OutputGroup[]): string {
  const lines = [`Comando: ${command}`, `${groups.length} salidas distintas`];
  groups.forEach((g, i) => {
    lines.push("");
    lines.push(`== Grupo ${i + 1}: ${g.targets.length} servidor${g.targets.length === 1 ? "" : "es"} ==`);
    lines.push(g.targets.map((t) => t.name).join(", "));
    if (g.noResult) lines.push(`(${STATUS_LABEL[g.status]}) ${g.stderr}`);
    else {
      if (g.exitCode !== null) lines.push(`código ${g.exitCode}`);
      if (g.stdout) lines.push(indent(g.stdout, ""));
      if (g.stderr) lines.push("-- stderr --", g.stderr);
      if (!g.stdout && !g.stderr) lines.push("(sin salida)");
    }
  });
  return lines.join("\n") + "\n";
}
