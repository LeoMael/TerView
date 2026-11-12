// Formatos del Monitor (números cortos y legibles).
import { formatBytes } from "../../lib/format";

export const fmtPct = (v: number) => `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)} %`;

export const fmtLoad = (v: number) => v.toFixed(2);

export const fmtRate = (bps: number) => `${formatBytes(Math.round(bps))}/s`;

/** Segundos → "3 d 4 h", "5 h 12 min", "8 min". `short` = una sola unidad grande con la siguiente. */
export function fmtUptime(secs: number, short = false): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return short ? `${d} d` : `${d} d ${h} h`;
  if (h > 0) return short ? `${h} h` : `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${Math.floor(secs)} s`;
}
