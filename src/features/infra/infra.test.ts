// Pruebas del mapa de infraestructura: parseo (ss -tn, cortafuegos, usuarios), constructor del grafo
// (puertos, sitios con proxy_pass, contenedores publicados, varios usuarios, conexiones entre dos
// servidores), filtros, disposición y texto Mermaid.
// Ejecutar: npx rolldown src/features/infra/infra.test.ts -p node -f esm -o /tmp/infra.mjs && node /tmp/infra.mjs
import { buildGraph, filterGraph, graphOwners, SYSTEM_OWNER, type InfraGraph } from "./graph";
import { layoutGraph, spreadRows } from "./layout";
import { parseEstLine, parseInfra } from "./parse";
import { sampleSnapshots } from "./sample";
import { graphSummary, toMermaid } from "./text";
import { parseUpstreamUrl } from "../admin/web";

let fails = 0;
let n = 0;
function eq(a: unknown, b: unknown, msg: string) {
  n++;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    fails++;
    console.error(`FALLO: ${msg}\n  obtenido: ${sa}\n  esperado: ${sb}`);
  }
}
function ok(c: boolean, msg: string) {
  eq(c, true, msg);
}

// ───────── Parseo ─────────
eq(
  parseEstLine('0      0      10.0.0.5:51234    10.0.0.9:5432   users:(("node",pid=812,fd=21))'),
  { localIp: "10.0.0.5", localPort: 51234, peerIp: "10.0.0.9", peerPort: 5432, proc: "node", pid: 812 },
  "ss -tnpH: conexión con proceso",
);
eq(
  parseEstLine("ESTAB 0 0 [::ffff:10.0.0.5]:40000 [::ffff:10.0.0.9]:6379"),
  { localIp: "10.0.0.5", localPort: 40000, peerIp: "10.0.0.9", peerPort: 6379, proc: null, pid: null },
  "ss -tn con estado e IPv4 mapeada en IPv6",
);
eq(parseEstLine("Recv-Q Send-Q Local Address:Port Peer Address:Port Process"), null, "cabecera fuera");
eq(parseEstLine("0 0 [2001:db8::1]:22 [2001:db8::2]:50000")?.peerIp, "2001:db8::2", "IPv6 con corchetes");

const infra = parseInfra(
  [
    "@@os",
    "Ubuntu 24.04.1 LTS",
    "@@host",
    "web-prod",
    "@@addrs",
    "127.0.0.1",
    "10.0.0.5",
    "::1",
    "10.0.0.5",
    "@@fw",
    "ufw active",
    "nftables 0",
    "@@humans",
    "deploy|1000|/home/deploy|1",
    "ana|1001|/home/ana|0",
    "@@est",
    '0 0 10.0.0.5:51234 10.0.0.9:5432 users:(("node",pid=812,fd=21))',
    "@@usvc",
    "api.service",
    "basura",
    "@@end",
  ].join("\n"),
);
eq(infra.os, "Ubuntu 24.04.1 LTS", "SO");
eq(infra.addrs, ["10.0.0.5"], "direcciones sin loopback ni repetidas");
eq(infra.firewall.map((f) => [f.tool, f.active]), [["ufw", true], ["nftables", false]], "cortafuegos");
eq(infra.humans.get("ana"), { name: "ana", uid: 1001, home: "/home/ana", runtimeDir: false }, "usuarios de personas");
eq(infra.established.length, 1, "conexiones");
eq(infra.userServices, ["api.service"], "servicios de usuario");

// Upstreams de nginx (proxy_pass) que usa el mapa.
eq(parseUpstreamUrl("http://127.0.0.1:8080"), { host: "127.0.0.1", port: 8080, socket: null }, "upstream con puerto");
eq(parseUpstreamUrl("http://app:3000/api"), { host: "app", port: 3000, socket: null }, "upstream por nombre de contenedor");
eq(parseUpstreamUrl("unix:/run/php/php8.3-fpm.sock"), { host: null, port: null, socket: "/run/php/php8.3-fpm.sock" }, "socket unix");

// ───────── Grafo ─────────
const NOW = Date.UTC(2026, 10, 13);
const g = buildGraph(sampleSnapshots(NOW), NOW);
const byLabel = (s: string, srv?: string) => g.nodes.find((x) => x.label === s && (!srv || x.server === srv));
const edge = (a: string | undefined, b: string | undefined) => g.edges.find((e) => e.from === a && e.to === b);

ok(!!byLabel("Internet"), "Internet");
eq(g.servers.map((s) => s.name), ["web-prod", "db-01"], "servidores");
eq(g.servers[0].os, "Ubuntu 24.04.1 LTS", "SO del servidor");
const fw = g.nodes.find((x) => x.kind === "firewall" && x.server === "srv-web");
eq(fw?.label, "ufw", "cortafuegos activo");
ok(!!edge("internet", fw?.id), "Internet → cortafuegos");
const p443 = g.nodes.find((x) => x.id === "srv-web|port:tcp:443");
ok(!!p443 && !!edge(fw?.id, p443.id), "cortafuegos → :443");
ok(!g.nodes.some((x) => x.id === "srv-web|port:tcp:8080"), ":8080 solo local: sin nodo de puerto");
ok(!g.nodes.some((x) => x.id === "srv-web|port:tcp:53"), ":53 de systemd-resolved (127.0.0.53) solo local");

const nginx = g.nodes.find((x) => x.server === "srv-web" && x.kind === "proxy");
eq(nginx?.label, "nginx", "nginx como proxy (el servicio que escucha en 80/443)");
eq(nginx?.layer, 3, "proxy en su columna");
ok(!!edge(p443?.id, nginx?.id), ":443 → nginx");
const tienda = byLabel("tienda.example.com +1");
const api = byLabel("api.example.com");
ok(!!tienda && !!api, "dos sitios");
eq(tienda?.health, "ok", "certificado con 64 días: bien");
eq(api?.health, "warn", "certificado con 20 días: aviso");
ok(!!edge(nginx?.id, tienda?.id), "nginx → sitio");

const app = byLabel("tienda-app");
eq(app?.owner, "ana", "contenedor rootless de ana");
eq(app?.group, "tienda", "agrupado por Compose");
eq(edge(tienda?.id, app?.id)?.label, ":8080", "sitio → contenedor por proxy_pass 127.0.0.1:8080 (rootlessport)");
const node = byLabel("api");
eq(node?.owner, "deploy", "servicio de deploy");
eq(edge(api?.id, node?.id)?.label, ":3000", "sitio → app por localhost:3000");
ok(!g.edges.some((e) => e.from === api?.id && e.label.includes("static")), "las rutas de archivos no generan aristas");

const portainer = byLabel("portainer");
eq(portainer?.owner, SYSTEM_OWNER, "Docker con root: sistema");
eq(edge("srv-web|port:tcp:9443", portainer?.id)?.kind, "publish", "puerto publicado → contenedor (docker-proxy)");
eq(byLabel("backup-viejo")?.health, "bad", "contenedor que falló");
eq(byLabel("tienda-redis")?.kind, "db", "redis en contenedor: datos");
eq(byLabel("sync-fotos")?.owner, "ana", "servicio systemctl --user de ana");
eq(g.nodes.filter((x) => x.label === "api" && x.server === "srv-web").length, 1, "servicio de usuario que escucha: un solo nodo");
eq(g.servers[0].owners, [SYSTEM_OWNER, "deploy", "ana"], "usuarios de web-prod: sistema, el conectado, los demás");

const pg = g.nodes.find((x) => x.server === "srv-db" && x.kind === "db");
eq(pg?.label, "postgresql@16-main", "postgres en db-01");
eq(pg?.owner, SYSTEM_OWNER, "postgres (usuario del sistema) en «sistema»");
const cross = g.edges.filter((e) => e.kind === "cross");
eq(cross.map((e) => [e.from, e.to, e.label]), [[node?.id, pg?.id, ":5432"]], "web-prod (app) → db-01 (postgres): una sola, la saliente");
eq(byLabel("node_exporter")?.kind, "system", "node_exporter: servicio del sistema");
eq(g.servers[1].health, "ok", "db-01 bien");
eq(g.servers[0].health, "warn", "web-prod con algo caído: aviso");

// Upstream a otro servidor del proyecto por su IP y a un destino externo.
{
  const s = sampleSnapshots(NOW);
  s[0].web!.servers[0].sites[1].routes.push(
    { path: "/db/", target: { kind: "proxy", url: "http://10.0.0.9:5432", host: "10.0.0.9", port: 5432, socket: null } },
    { path: "/ext/", target: { kind: "proxy", url: "https://api.stripe.com", host: "api.stripe.com", port: 443, socket: null } },
    { path: "/nada/", target: { kind: "proxy", url: "http://127.0.0.1:7777", host: "127.0.0.1", port: 7777, socket: null } },
  );
  const g2 = buildGraph(s, NOW);
  const apiN = g2.nodes.find((x) => x.label === "api.example.com")!;
  const pg2 = g2.nodes.find((x) => x.server === "srv-db" && x.kind === "db")!;
  eq(g2.edges.find((e) => e.from === apiN.id && e.to === pg2.id)?.kind, "cross", "proxy_pass a la IP de otro servidor del proyecto");
  eq(g2.nodes.find((x) => x.label === "api.stripe.com:443")?.kind, "external", "destino externo");
  eq(g2.nodes.find((x) => x.label === "127.0.0.1:7777")?.health, "bad", "upstream local donde no escucha nadie: caído");
}

// Sin sudo: solo lo del conectado; los procesos de otros sin nombre.
{
  const s = sampleSnapshots(NOW).slice(0, 1);
  s[0].elevated = false;
  s[0].containers = s[0].containers.filter((c) => c.user === "deploy");
  s[0].ports!.ports = s[0].ports!.ports.map((p) => (p.user === "deploy" ? p : { ...p, procs: [], user: null, unit: null }));
  s[0].userServices = { deploy: ["api.service"] };
  const g3 = buildGraph(s, NOW);
  eq(g3.servers[0].owners, [SYSTEM_OWNER, "deploy"], "sin sudo: sistema y el conectado");
  ok(g3.nodes.some((x) => x.label === "HTTPS" || x.sub === "sin permiso para ver el proceso"), "procesos sin permiso");
}

// ───────── Filtros ─────────
const onlyAna = filterGraph(g, { hideLocal: false, hideSystem: false, owners: new Set(["ana"]) });
ok(onlyAna.nodes.every((x) => x.kind === "internet" || x.owner === "ana"), "filtro por usuario: solo ana");
ok(onlyAna.nodes.some((x) => x.label === "tienda-app"), "filtro ana: su contenedor");
eq(onlyAna.servers[0].owners, ["ana"], "filtro ana: una banda");
ok(!onlyAna.nodes.some((x) => x.kind === "internet"), "sin puertos expuestos de ana: sin Internet");
const noSys = filterGraph(g, { hideLocal: true, hideSystem: true, owners: null });
ok(!noSys.nodes.some((x) => x.kind === "system"), "ocultar servicios del sistema");
ok(!noSys.nodes.some((x) => x.id === "srv-web|port:tcp:22"), "su puerto también se oculta");
ok(!noSys.nodes.some((x) => x.label === "sync-fotos"), "ocultar solo locales sin conexiones");
ok(noSys.nodes.some((x) => x.label === "tienda-app"), "pero no los que atienden un sitio");
eq(graphOwners(g), [SYSTEM_OWNER, "ana", "deploy"], "usuarios del grafo");

// ───────── Disposición ─────────
function overlaps(gr: InfraGraph) {
  const L = layoutGraph(gr);
  const list = [...L.nodes.values()];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return `${a.node.id} / ${b.node.id}`;
    }
  for (const p of list) {
    if (!p.node.server) continue;
    const s = L.servers.find((x) => x.id === p.node.server)!;
    const band = s.bands.find((b) => b.owner === p.node.owner);
    if (!band || p.y < band.y || p.y + p.h > band.y + band.h || p.x < band.x || p.x + p.w > band.x + band.w) return `${p.node.id} fuera de su banda`;
  }
  return null;
}
eq(spreadRows([1, 1], 3), [0, 1], "dos hijos de la fila 1: alrededor de ella");
eq(spreadRows([2, 2, 2], 5), [1, 2, 3], "tres hijos centrados");
eq(spreadRows([5], 3), [2], "sin salirse de la banda");
eq(spreadRows([0, 0, 0], 3), [0, 1, 2], "llenando la banda");
eq(spreadRows([0, 2], 3), [0, 2], "cada uno en su fila si cabe");
eq(overlaps(g), null, "disposición sin solapes y cada nodo dentro de su banda");
eq(overlaps(noSys), null, "disposición filtrada");
{
  const L = layoutGraph(g);
  const x = (id: string | undefined) => L.nodes.get(id ?? "")!.x;
  ok(x("internet") < x(p443?.id) && x(p443?.id) < x(nginx?.id) && x(nginx?.id) < x(tienda?.id) && x(tienda?.id) < x(app?.id) && x(app?.id) < x(pg?.id), "capas de izquierda a derecha");
  eq(L.servers.length, 2, "una caja por servidor");
  ok(L.servers[0].y + L.servers[0].h < L.servers[1].y, "cajas una debajo de otra");
  eq(L.edges.length, g.edges.length, "todas las aristas dibujadas");
  ok(L.groups.some((gr) => gr.name === "tienda"), "caja del grupo de Compose");
}

// ───────── Texto ─────────
const mm = toMermaid(g);
ok(mm.startsWith("flowchart LR\n"), "Mermaid: cabecera");
ok(mm.includes('subgraph s0["web-prod · Ubuntu 24.04.1 LTS"]') && mm.includes('["ana"]'), "Mermaid: servidor y usuario");
ok(/-\.->\|":5432"\|/.test(mm), "Mermaid: conexión entre servidores");
const sum = graphSummary(g);
eq(sum.servers[1].nodes.find((x) => x.kind === "db")?.name, "postgresql@16-main", "resumen JSON");

console.log(fails ? `${fails} de ${n} pruebas FALLARON` : `OK: ${n} pruebas`);
if (fails) throw new Error("pruebas fallidas");
