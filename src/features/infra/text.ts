// Mapa de infraestructura como texto: Mermaid (flowchart) y un resumen JSON corto. Funciones puras.
import type { InfraGraph, MapNode } from "./graph";

function mid(id: string, ids: Map<string, string>): string {
  let v = ids.get(id);
  if (!v) {
    v = `n${ids.size}`;
    ids.set(id, v);
  }
  return v;
}

function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, "");
}

function nodeText(n: MapNode): string {
  const label = n.sub ? `${esc(n.label)}<br/><small>${esc(n.sub)}</small>` : esc(n.label);
  switch (n.kind) {
    case "internet":
      return `(("${label}"))`;
    case "db":
      return `[("${label}")]`;
    case "port":
    case "firewall":
      return `{{"${label}"}}`;
    case "site":
      return `(["${label}"])`;
    default:
      return `["${label}"]`;
  }
}

/** Diagrama Mermaid: un subgrafo por servidor y, dentro, uno por usuario. */
export function toMermaid(g: InfraGraph): string {
  const ids = new Map<string, string>();
  const out = ["flowchart LR"];
  const inet = g.nodes.find((n) => n.kind === "internet");
  if (inet) out.push(`  ${mid(inet.id, ids)}${nodeText(inet)}`);
  g.servers.forEach((s, si) => {
    out.push(`  subgraph s${si}["${esc(s.name)}${s.os ? ` · ${esc(s.os)}` : ""}"]`);
    s.owners.forEach((o, oi) => {
      const mine = g.nodes.filter((n) => n.server === s.id && n.owner === o);
      if (mine.length === 0) return;
      out.push(`    subgraph s${si}u${oi}["${esc(o)}"]`);
      for (const n of mine) out.push(`      ${mid(n.id, ids)}${nodeText(n)}`);
      out.push("    end");
    });
    const rest = g.nodes.filter((n) => n.server === s.id && (!n.owner || !s.owners.includes(n.owner)));
    for (const n of rest) out.push(`    ${mid(n.id, ids)}${nodeText(n)}`);
    out.push("  end");
  });
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const arrow = e.kind === "cross" ? "-.->" : "-->";
    out.push(`  ${ids.get(e.from)} ${arrow}${e.label ? `|"${esc(e.label)}"|` : ""} ${ids.get(e.to)}`);
  }
  return out.join("\n") + "\n";
}

/** Resumen del grafo para el asistente (sin detalles largos). */
export function graphSummary(g: InfraGraph) {
  const name = new Map(g.nodes.map((n) => [n.id, n.label]));
  return {
    servers: g.servers.map((s) => ({
      name: s.name,
      os: s.os,
      health: s.health,
      users: s.owners,
      firewall: s.firewall,
      notes: s.notes,
      nodes: g.nodes
        .filter((n) => n.server === s.id)
        .map((n) => ({ kind: n.kind, name: n.label, info: n.sub || undefined, user: n.owner, health: n.health, group: n.group ?? undefined })),
    })),
    links: g.edges.map((e) => ({ from: name.get(e.from), to: name.get(e.to), label: e.label || undefined, kind: e.kind })),
  };
}
