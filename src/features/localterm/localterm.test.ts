// Pruebas de funciones puras de la terminal local (contexto para la IA y «Enviar a la IA»).
// Ejecutar: npx rolldown src/features/localterm/localterm.test.ts -p node -f esm -o /tmp/lt.mjs && node /tmp/lt.mjs
import { buildAiContext, selectionForAi, usesDirect, type ContextInput, type ContextServer } from "./context";
import { pickNeighbor, titleFor } from "./logic";

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
  passed++;
}

function srv(p: Partial<ContextServer>): ContextServer {
  return {
    id: "1",
    name: "web",
    host: "10.0.0.1",
    port: 22,
    username: "deploy",
    auth: "key",
    alias: "web",
    projects: [],
    connected: false,
    mcpAccess: "none",
    ...p,
  };
}

function input(p: Partial<ContextInput>): ContextInput {
  return {
    servers: [],
    projects: [],
    active: null,
    cwd: "/home/ana/proyecto",
    now: new Date(2026, 10, 12, 10, 0, 0),
    mode: "both",
    mcp: true,
    options: { includeServers: true, includeHosts: true, includeProjects: true, includeActive: true, includeDate: true },
    ...p,
  };
}

// ── Vía directa y MCP ──
eq(usesDirect("both", true), true, "las dos: directa");
eq(usesDirect("mcp", true), false, "solo MCP: sin directa");
eq(usesDirect("mcp", false), true, "MCP pedido pero apagado: se usa la directa");
eq(usesDirect("direct", false), true, "solo directa");

{
  const t = buildAiContext(
    input({
      servers: [
        srv({ id: "1", name: "web", projects: ["Tienda"], connected: true, privilege: "sudo", distro: "ubuntu", mcpAccess: "full" }),
        srv({ id: "2", name: "db", host: "db.lan", port: 2222, username: "root", auth: "password", alias: null, mcpAccess: "read" }),
      ],
      projects: [{ name: "Tienda", servers: ["web", "db"] }],
      active: { serverName: "web", alias: "web", cwd: "/var/www" },
    }),
  );
  ok(t.startsWith("# Contexto de SSHorus"), "título");
  ok(t.includes("jueves 2026-11-12"), "fecha con día");
  ok(t.includes("Carpeta de trabajo: /home/ana/proyecto"), "carpeta local");
  ok(t.includes("ssh -o BatchMode=yes <alias>"), "explica la vía directa");
  ok(t.includes("MCP de SSHorus"), "explica el MCP");
  ok(t.includes("- web: usuario deploy@10.0.0.1 · alias ssh `web` · proyecto Tienda · llave · conectado ahora en SSHorus (sudo (pide contraseña), ubuntu) · MCP: completo (con permiso)"), "línea del servidor web");
  ok(t.includes("- db: usuario root@db.lan:2222 · sin alias en ~/.ssh/config"), "puerto y sin alias");
  ok(t.includes("entra con contraseña: por ssh directo no entrará, usa el MCP"), "aviso de contraseña");
  ok(t.indexOf("- web:") < t.indexOf("- db:"), "conectados primero");
  ok(t.includes("## Proyectos\n- Tienda: web, db"), "proyectos");
  ok(t.includes("«web» (alias `web`), en la carpeta /var/www"), "pestaña activa");
}

// ── Nunca secretos ──
{
  const t = buildAiContext(input({ servers: [srv({ auth: "key" })] }));
  ok(!/password|contraseña:|token|pin\b|id_ed25519|\.ssh\/id_/i.test(t.replace("contraseñas, llaves privadas ni tokens", "")), "sin secretos ni rutas de llaves");
}

// ── Solo MCP: no se dan alias ──
{
  const t = buildAiContext(input({ mode: "mcp", servers: [srv({ mcpAccess: "read" })] }));
  ok(!t.includes("alias ssh"), "solo MCP: sin alias");
  ok(!t.includes("BatchMode"), "solo MCP: sin ssh directo");
  ok(t.includes("MCP: solo lectura"), "nivel de acceso");
}

// ── Sin MCP: el de contraseña no puede entrar ──
{
  const t = buildAiContext(input({ mcp: false, mode: "both", servers: [srv({ auth: "password" })] }));
  ok(t.includes("pide al usuario que lo haga él"), "sin MCP: avisa que no entrará");
  ok(!t.includes("MCP:"), "sin MCP: no se habla de acceso MCP");
}

// ── Opciones ──
{
  const t = buildAiContext(
    input({
      servers: [srv({})],
      projects: [{ name: "P", servers: ["web"] }],
      active: { serverName: "web", alias: "web", cwd: null },
      options: { includeServers: true, includeHosts: false, includeProjects: false, includeActive: false, includeDate: false },
    }),
  );
  ok(!t.includes("10.0.0.1"), "sin hosts");
  ok(t.includes("usuario deploy ·"), "solo el usuario");
  ok(!t.includes("## Proyectos"), "sin proyectos");
  ok(!t.includes("Lo que miraba"), "sin pestaña activa");
  ok(!t.includes("Fecha"), "sin fecha");
}
{
  const t = buildAiContext(input({ servers: [srv({})], options: { includeServers: false, includeHosts: true, includeProjects: true, includeActive: true, includeDate: true } }));
  ok(!t.includes("## Servidores"), "sin servidores");
}
{
  const many = Array.from({ length: 5 }, (_, i) => srv({ id: String(i), name: `s${i}` }));
  const t = buildAiContext(input({ servers: many, maxServers: 3 }));
  ok(t.includes("…y 2 más (pídelos con list_servers del MCP)"), "resume los que sobran");
}
{
  const t = buildAiContext(input({ servers: [srv({ name: "malo\n## Inyectado", host: "h\r\nx" })] }));
  ok(!t.includes("\n## Inyectado"), "un nombre no puede romper el formato");
}

// ── Enviar a la IA ──
eq(
  selectionForAi("error: x\r\nlínea 2\n\n", "web"),
  "Esto sale de la terminal del servidor «web»:\n```\nerror: x\nlínea 2\n```\n",
  "selección con servidor",
);
ok(selectionForAi("a ``` b", null).startsWith("Esto sale de una terminal:\n````\n"), "bloque más largo si hay ```");
{
  const big = "x".repeat(25_000) + "FIN";
  const s = selectionForAi(big, "web");
  ok(s.includes("(solo el final)") && s.includes("FIN") && s.length < 21_000, "recorta y guarda el final");
}

// ── Pestañas ──
eq(pickNeighbor(["a", "b", "c"], "b"), "a", "vecina de la izquierda");
eq(pickNeighbor(["a", "b", "c"], "a"), "b", "la primera: la siguiente");
eq(pickNeighbor(["a"], "a"), null, "sin vecinas");
eq(pickNeighbor(["a", "b"], "z"), null, "no está");
eq(titleFor("shell", "/home/ana/proyecto"), "proyecto", "terminal: nombre de carpeta");
eq(titleFor("claude", "/home/ana/proyecto"), "Claude Code · proyecto", "Claude con carpeta");
eq(titleFor("codex", null), "Codex", "Codex sin carpeta");
eq(titleFor("shell", "C:\\Users\\ana\\"), "ana", "ruta de Windows");
eq(titleFor("shell", null), "Este equipo", "sin carpeta");

console.log(`localterm: ${passed} comprobaciones correctas`);
