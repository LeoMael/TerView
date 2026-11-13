// Pruebas de la relación proyecto ↔ servidor (funciones puras).
// Ejecutar: npx rolldown src/features/projectServers.test.ts -p node -f esm -o /tmp/ps.mjs && node /tmp/ps.mjs
import type { Project, ServerProfile } from "../api/types";
import { initialProjectFor, projectChanges, serversNotInProject } from "./projectServers";

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}

function server(id: string): ServerProfile {
  return {
    id,
    name: id,
    host: `${id}.example`,
    port: 22,
    username: "root",
    auth: "password",
    keyPath: null,
    defaultPath: null,
    color: null,
  };
}

function project(id: string, serverIds: string[]): Project {
  return {
    id,
    name: id,
    serverIds,
    bookmarks: serverIds.map((s) => ({ serverId: s, path: `/srv/${s}`, label: null })),
    color: null,
  };
}

const servers = [server("a"), server("b"), server("c")];
const pA = project("pA", ["a"]);
const pB = project("pB", ["a", "b"]);
const projects = [pA, pB];

// ── serversNotInProject ──
eq(serversNotInProject(servers, pB).map((s) => s.id), ["c"], "fuera de pB");
eq(serversNotInProject(servers, project("vacío", [])).map((s) => s.id), ["a", "b", "c"], "proyecto vacío");
eq(serversNotInProject(servers, project("todos", ["a", "b", "c"])), [], "ya están todos");

// ── initialProjectFor ──
eq(initialProjectFor(projects, "", "pB"), "pB", "nuevo desde un proyecto");
eq(initialProjectFor(projects, "", null), "", "nuevo desde «Servidores»");
eq(initialProjectFor(projects, "", "borrado"), "", "nuevo desde un proyecto que ya no existe");
eq(initialProjectFor(projects, "a", null), "pA", "existente: su primer proyecto");
eq(initialProjectFor(projects, "a", "pB"), "pB", "existente abierto desde otro de sus proyectos");
eq(initialProjectFor(projects, "c", "pB"), "", "existente que no está en el proyecto de origen");
eq(initialProjectFor(projects, "c", null), "", "existente sin proyecto");

// ── projectChanges ──
eq(projectChanges(projects, "x", "", ""), [], "sin proyecto: nada");
eq(projectChanges(projects, "a", "pA", "pA"), [], "mismo proyecto: nada");
eq(
  projectChanges(projects, "x", "", "pA"),
  [{ ...pA, serverIds: ["a", "x"] }],
  "servidor nuevo dentro de pA",
);
eq(
  projectChanges(projects, "b", "pB", ""),
  [{ ...pB, serverIds: ["a"], bookmarks: [{ serverId: "a", path: "/srv/a", label: null }] }],
  "sacar de pB quita también sus marcadores",
);
eq(
  projectChanges(projects, "b", "pB", "pA").map((p) => [p.id, p.serverIds]),
  [
    ["pB", ["a"]],
    ["pA", ["a", "b"]],
  ],
  "mover de pB a pA",
);
eq(projectChanges(projects, "a", "", "pB"), [], "ya estaba en el destino: nada");
eq(projectChanges(projects, "x", "", "borrado"), [], "destino que ya no existe: nada");

console.log(`projectServers: ${passed} comprobaciones correctas`);
