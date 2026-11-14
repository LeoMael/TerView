// Disposición del mapa por capas (izquierda → derecha: Internet, entrada, proxy, sitios, apps, datos).
// Cada servidor es una caja con una banda por usuario; dentro, cada nodo va en la columna de su capa y
// el orden de cada columna sigue al de sus vecinos de la izquierda (menos cruces). Funciones puras.
import type { InfraGraph, MapEdge, MapNode } from "./graph";

export const NODE_W = 178;
export const NODE_H = 44;
const COL_GAP = 64;
const ROW_H = 58;
const SERVER_HEAD = 34;
const BAND_HEAD = 24;
const BAND_PAD = 10;
const SERVER_GAP = 34;
const PAD = 14;
const MARGIN = 24;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedNode extends Box {
  node: MapNode;
}

export interface PlacedBand extends Box {
  owner: string;
}

export interface PlacedGroup extends Box {
  name: string;
}

export interface PlacedServer extends Box {
  id: string;
  bands: PlacedBand[];
}

export interface PlacedEdge {
  edge: MapEdge;
  path: string;
  /** Punto para la etiqueta (alineada a la derecha, junto a la punta). */
  lx: number;
  ly: number;
}

export interface Layout {
  nodes: Map<string, PlacedNode>;
  servers: PlacedServer[];
  groups: PlacedGroup[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  /** x de cada capa usada (para los títulos de columna). */
  columns: { layer: number; x: number }[];
}

export function layoutGraph(g: InfraGraph): Layout {
  const layers = [...new Set(g.nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const colX = new Map<number, number>();
  layers.forEach((l, i) => colX.set(l, MARGIN + PAD + i * (NODE_W + COL_GAP)));
  const firstInner = layers.find((l) => l > 0) ?? 1;
  const lastLayer = layers[layers.length - 1] ?? 1;
  const boxX = (colX.get(firstInner) ?? MARGIN + PAD) - PAD;
  const boxW = (colX.get(lastLayer) ?? 0) + NODE_W + PAD - boxX;

  const placed = new Map<string, PlacedNode>();
  const incoming = new Map<string, string[]>();
  for (const e of g.edges) {
    const l = incoming.get(e.to) ?? [];
    l.push(e.from);
    incoming.set(e.to, l);
  }
  const servers: PlacedServer[] = [];
  const groups: PlacedGroup[] = [];
  let y = MARGIN + 22; // títulos de columna

  for (const srv of g.servers) {
    const own = g.nodes.filter((n) => n.server === srv.id);
    const top = y;
    let by = y + SERVER_HEAD;
    const bands: PlacedBand[] = [];
    const owners = srv.owners.filter((o) => own.some((n) => n.owner === o));
    // Nodos sin dueño conocido (no debería pasar) en la primera banda.
    const ownerOf = (n: MapNode) => (n.owner && owners.includes(n.owner) ? n.owner : owners[0]);
    for (const owner of owners) {
      const mine = own.filter((n) => ownerOf(n) === owner);
      const cols = new Map<number, MapNode[]>();
      for (const n of mine) {
        const c = cols.get(n.layer) ?? [];
        c.push(n);
        cols.set(n.layer, c);
      }
      const rows = Math.max(1, ...[...cols.values()].map((c) => c.length));
      const bandTop = by;
      const nodesTop = bandTop + BAND_HEAD;
      // Columnas de izquierda a derecha: orden por la media de la altura de sus vecinos de entrada.
      for (const layer of [...cols.keys()].sort((a, b) => a - b)) {
        const col = cols.get(layer)!;
        const bary = (n: MapNode) => {
          const ys = (incoming.get(n.id) ?? []).map((id) => placed.get(id)?.y).filter((v): v is number => v !== undefined);
          return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
        };
        const b = new Map(col.map((n, i) => [n.id, { v: bary(n), i }]));
        // Grupos (Compose/pod) juntos: se ordenan por el mejor de sus miembros.
        const gBest = new Map<string, number>();
        for (const n of col) if (n.group) gBest.set(n.group, Math.min(gBest.get(n.group) ?? Infinity, b.get(n.id)!.v));
        const key = (n: MapNode) => (n.group ? gBest.get(n.group)! : b.get(n.id)!.v);
        col.sort((p, q) => key(p) - key(q) || (p.group ?? "").localeCompare(q.group ?? "") || b.get(p.id)!.v - b.get(q.id)!.v || b.get(p.id)!.i - b.get(q.id)!.i);
        // Cada nodo, en la fila más cercana a la de sus vecinos de entrada (líneas rectas, sin cruzar
        // otros nodos), sin salirse de la banda y sin repetir fila.
        let last = -1;
        const want = col.map((n) => {
          const v = b.get(n.id)!.v;
          last = Number.isFinite(v) ? (v - nodesTop) / ROW_H : last + 1;
          return last;
        });
        const row = spreadRows(want, rows);
        col.forEach((n, i) => {
          placed.set(n.id, { node: n, x: colX.get(layer)!, y: nodesTop + row[i] * ROW_H, w: NODE_W, h: NODE_H });
        });
        // Cajas de grupo.
        let i = 0;
        while (i < col.length) {
          const gname = col[i].group;
          let j = i;
          while (j + 1 < col.length && gname && col[j + 1].group === gname) j++;
          if (gname) {
            const a = placed.get(col[i].id)!;
            const z = placed.get(col[j].id)!;
            groups.push({ name: gname, x: a.x - 6, y: a.y - 14, w: NODE_W + 12, h: z.y + NODE_H - a.y + 20 });
          }
          i = j + 1;
        }
      }
      const h = BAND_HEAD + rows * ROW_H + BAND_PAD - (ROW_H - NODE_H);
      bands.push({ owner, x: boxX + 6, y: bandTop, w: boxW - 12, h });
      by = bandTop + h + 8;
    }
    if (owners.length === 0) by += 40;
    const height = by - top + 4;
    servers.push({ id: srv.id, x: boxX, y: top, w: boxW, h: height, bands });
    y = top + height + SERVER_GAP;
  }

  // Internet: a la izquierda, a la altura media de lo que alimenta.
  const inet = g.nodes.find((n) => n.kind === "internet");
  if (inet) {
    const targets = g.edges.filter((e) => e.from === inet.id).map((e) => placed.get(e.to)).filter((p): p is PlacedNode => !!p);
    const cy = targets.length ? targets.reduce((a, p) => a + p.y, 0) / targets.length : MARGIN + 40;
    placed.set(inet.id, { node: inet, x: colX.get(0)!, y: cy, w: NODE_W - 40, h: NODE_H });
  }

  const edges = g.edges
    .map((e) => {
      const a = placed.get(e.from);
      const b = placed.get(e.to);
      return a && b ? routeEdge(e, a, b) : null;
    })
    .filter((x): x is PlacedEdge => x !== null);

  const width = Math.max(boxX + boxW, ...[...placed.values()].map((p) => p.x + p.w)) + MARGIN;
  const height = Math.max(y - SERVER_GAP, ...[...placed.values()].map((p) => p.y + p.h)) + MARGIN;
  return { nodes: placed, servers, groups, edges, width, height, columns: layers.map((l) => ({ layer: l, x: colX.get(l)! })) };
}

/**
 * Filas (enteras, distintas, en orden y dentro de 0..rows-1) lo más cerca posible de las deseadas: varios
 * nodos que quieren la misma fila se reparten alrededor de ella (regresión isotónica, PAVA).
 */
export function spreadRows(want: number[], rows: number): number[] {
  const n = want.length;
  const blocks: { sum: number; count: number }[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: want[i] - i, count: 1 });
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2];
      const b = blocks[blocks.length - 1];
      if (a.sum / a.count <= b.sum / b.count) break;
      a.sum += b.sum;
      a.count += b.count;
      blocks.pop();
    }
  }
  const out: number[] = [];
  const max = Math.max(0, rows - n);
  for (const b of blocks) {
    const z = Math.min(max, Math.max(0, Math.ceil(b.sum / b.count - 0.5)));
    for (let k = 0; k < b.count; k++) out.push(z + out.length);
  }
  return out;
}

/** Curva de un nodo al otro: de la derecha del origen a la izquierda del destino (o por fuera si van hacia atrás). */
export function routeEdge(edge: MapEdge, a: Box, b: Box): PlacedEdge {
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  if (b.x > a.x + a.w / 2) {
    const sx = a.x + a.w;
    const tx = b.x;
    const dx = Math.max(30, (tx - sx) / 2);
    return {
      edge,
      path: `M${sx},${ay} C${sx + dx},${ay} ${tx - dx},${by} ${tx},${by}`,
      lx: tx - 9,
      ly: by - 3,
    };
  }
  // Misma columna o hacia la izquierda: sale y entra por la derecha.
  const sx = a.x + a.w;
  const tx = b.x + b.w;
  const out = Math.max(sx, tx) + 46;
  return {
    edge,
    path: `M${sx},${ay} C${out},${ay} ${out},${by} ${tx},${by}`,
    lx: out - 12,
    ly: (ay + by) / 2,
  };
}
