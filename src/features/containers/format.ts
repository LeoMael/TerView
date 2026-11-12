// Textos en español para estados, tiempos y puertos.
import type { Container, ContainerState, PortMapping } from "./types";

export const STATE_LABEL: Record<ContainerState, string> = {
  running: "En marcha",
  paused: "En pausa",
  exited: "Parado",
  created: "Creado",
  restarting: "Reiniciando",
  removing: "Eliminando",
  dead: "Con fallo",
  unknown: "Desconocido",
};

/** Clase de color del punto de estado. */
export function stateTone(s: ContainerState): "ok" | "warn" | "off" | "bad" {
  if (s === "running") return "ok";
  if (s === "paused" || s === "restarting" || s === "removing") return "warn";
  if (s === "dead") return "bad";
  return "off";
}

export function stateText(c: Container): string {
  let t = STATE_LABEL[c.state];
  if (c.state === "exited" && c.exitCode !== null) t += c.exitCode === 0 ? "" : ` (código ${c.exitCode})`;
  if (c.health === "healthy") t += " · sano";
  else if (c.health === "unhealthy") t += " · con fallos";
  else if (c.health === "starting") t += " · comprobando";
  return t;
}

/** Unix segundos → «hace 5 min», «hace 3 días». */
export function ago(unixSecs: number | null, now: number = Date.now()): string {
  if (!unixSecs) return "—";
  const s = Math.max(0, Math.floor(now / 1000 - unixSecs));
  if (s < 60) return "hace un momento";
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return d === 1 ? "hace 1 día" : `hace ${d} días`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo === 1 ? "hace 1 mes" : `hace ${mo} meses`;
  const y = Math.floor(d / 365);
  return y <= 1 ? "hace 1 año" : `hace ${y} años`;
}

export function portLabel(p: PortMapping): string {
  const cont = p.range > 1 ? `${p.containerPort}-${p.containerPort + p.range - 1}` : String(p.containerPort);
  const proto = p.protocol === "tcp" ? "" : `/${p.protocol}`;
  if (p.hostPort === null) return `${cont}${proto}`;
  const host = p.range > 1 ? `${p.hostPort}-${p.hostPort + p.range - 1}` : String(p.hostPort);
  return `${p.hostIp ? `${p.hostIp}:` : ""}${host}→${cont}${proto}`;
}

export function percent(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;
}
