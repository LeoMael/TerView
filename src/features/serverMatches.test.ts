// Pruebas de las sugerencias de host y el aviso de servidor repetido (funciones puras).
// Ejecutar: npx rolldown src/features/serverMatches.test.ts -p node -f esm -o /tmp/sm.mjs && node /tmp/sm.mjs
import type { ServerProfile } from "../api/types";
import { findMatches, hostSuggestions, serverAddress } from "./serverMatches";

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}

function server(id: string, host: string, username = "root", port = 22, name = id): ServerProfile {
  return { id, name, host, port, username, auth: "password", keyPath: null, defaultPath: null, color: null };
}

const servers = [
  server("a", "web.example.com", "root", 22, "Web"),
  server("b", "WEB.example.com ", "deploy", 22, "Web deploy"),
  server("c", "db.example.com", "root", 2222, "Base de datos"),
  server("d", "10.0.0.5", "admin", 22, "Router web"),
];
const ids = (l: ServerProfile[]) => l.map((s) => s.id);

// Sugerencias
eq(ids(hostSuggestions(servers, "")), ["a", "b", "c", "d"], "sin texto: todos");
eq(ids(hostSuggestions(servers, "a")), ["b", "c", "d"], "sin el que se edita");
eq(ids(hostSuggestions(servers, "", "db")), ["c"], "filtra por host");
eq(ids(hostSuggestions(servers, "", "web")), ["a", "b", "d"], "primero los que empiezan; luego por nombre");
eq(ids(hostSuggestions(servers, "", "", 2)), ["a", "b"], "máximo");

// Coincidencias
eq(findMatches(servers, "", "web.example.com", 22, "root").exact?.id, "a", "mismo host, puerto y usuario");
eq(ids(findMatches(servers, "", "web.example.com", 22, "root").sameHost), ["b"], "mismo host con otro usuario");
eq(findMatches(servers, "", " Web.Example.com ", "", "deploy").exact?.id, "b", "mayúsculas, espacios y puerto vacío = 22");
eq(findMatches(servers, "b", "web.example.com", 22, "deploy").exact, null, "no se compara consigo mismo");
eq(ids(findMatches(servers, "b", "web.example.com", 22, "deploy").sameHost), ["a"], "al editar: los demás del host");
eq(findMatches(servers, "", "db.example.com", 22, "root").exact, null, "otro puerto no es repetido");
eq(ids(findMatches(servers, "", "db.example.com", 22, "root").sameHost), ["c"], "otro puerto: aviso suave");
eq(findMatches(servers, "", "otro.com", 22, "root"), { exact: null, sameHost: [] }, "host nuevo");
eq(findMatches(servers, "", "", 22, "root"), { exact: null, sameHost: [] }, "sin host");
eq(findMatches(servers, "", "web.example.com", 22, "").exact, null, "sin usuario no hay repetido exacto");

// Dirección
eq(serverAddress(servers[0]), "root@web.example.com", "sin :22");
eq(serverAddress(servers[2]), "root@db.example.com:2222", "con puerto");

console.log(`serverMatches: ${passed} comprobaciones correctas`);
