// Pruebas de funciones puras de Contenedores: dueños (root y otros usuarios), comandos como otro
// usuario, varios usuarios en un solo script y unión de listas con su usuario.
// Ejecutar: npx rolldown src/features/containers/containers.test.ts -p node -f esm -o /tmp/ct.mjs && node /tmp/ct.mjs
import { listContainers, logsCmd, execShellCmd, composeCmd } from "./commands";
import { parseDetect } from "./detect";
import {
  groupByOwner,
  mergeOwned,
  multiOwnerScript,
  ownedBy,
  ownerKey,
  ownerLine,
  ownerName,
  ownerOptions,
  parseMultiOwner,
  perOwner,
  validOwnerUser,
  withOwner,
  type CtOwner,
  type LineCtx,
  type OwnerUser,
} from "./owner";
import { statsFor } from "./parse";
import { renderCmd } from "./shell";

// Sin @types/node en el proyecto: se carga a mano lo justo para ejecutar `sh`.
const CHILD = "node:child_process";
const { execFileSync } = (await import(/* @vite-ignore */ CHILD)) as {
  execFileSync: (cmd: string, args: string[], opts?: { encoding: "utf8" }) => string;
};

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
  passed++;
}

const ana: OwnerUser = { name: "ana", uid: 1001, home: "/home/ana", podman: true, docker: false, runtimeDir: true };
const deploy: OwnerUser = { name: "deploy", uid: 1002, home: "/srv/deploy home", podman: true, docker: true, runtimeDir: false };
const mael: OwnerUser = { name: "mael", uid: 1000, home: "/home/mael", podman: true, docker: false, runtimeDir: true };
const bad: OwnerUser = { name: "-x;rm", uid: 1003, home: "/home/x", podman: true, docker: false, runtimeDir: true };

// ───────── Opciones del selector ─────────
{
  const keys = (os: CtOwner[]) => os.map(ownerKey);
  eq(keys(ownerOptions({ engine: "podman", users: [mael, ana, deploy, bad], me: "mael", isRoot: false })), ["self", "root", "u:ana", "u:deploy"], "podman con sudo");
  eq(keys(ownerOptions({ engine: "podman", users: [ana], me: "root", isRoot: true })), ["self", "u:ana"], "podman como root: sin «root» aparte");
  // Docker rootless: solo los que tienen su demonio (y /run/user/<uid>).
  eq(keys(ownerOptions({ engine: "docker", users: [ana, deploy, { ...deploy, name: "web", runtimeDir: true }], me: "mael", isRoot: false })), ["self", "u:web"], "docker");
  ok(!validOwnerUser(bad), "usuario con caracteres raros");
  ok(!validOwnerUser({ ...ana, home: "relativo" }), "HOME relativo");
  eq(ownerName({ kind: "self" }, "mael"), "mael", "nombre de tú");
  eq(ownerName({ kind: "user", user: ana }, "mael"), "ana", "nombre de otro");
}

// ───────── Comandos como otro usuario (línea para mostrar y para la terminal) ─────────
{
  const ctx: LineCtx = { engine: "podman", elevPrefix: "sudo ", selfPrefix: "", runuser: true };
  const ps = listContainers("podman");
  eq(ownerLine(ps, { kind: "self" }, ctx), "podman ps -a --format json", "tú: sin sudo");
  eq(ownerLine(ps, { kind: "root" }, ctx), "sudo podman ps -a --format json", "root: con sudo");
  eq(
    ownerLine(ps, { kind: "user", user: ana }, ctx),
    "sudo runuser -u ana -- env HOME=/home/ana XDG_RUNTIME_DIR=/run/user/1001 podman ps -a --format json",
    "otro usuario con runuser y sesión",
  );
  // Sin sesión: se quita el XDG_RUNTIME_DIR de quien eleva (Podman usa /tmp/storage-run-<uid>).
  eq(
    ownerLine(ps, { kind: "user", user: deploy }, ctx),
    "sudo runuser -u deploy -- env -u XDG_RUNTIME_DIR HOME='/srv/deploy home' podman ps -a --format json",
    "otro usuario sin sesión (HOME citado)",
  );
  eq(
    ownerLine(ps, { kind: "user", user: ana }, { ...ctx, elevPrefix: "", runuser: true }),
    "runuser -u ana -- env HOME=/home/ana XDG_RUNTIME_DIR=/run/user/1001 podman ps -a --format json",
    "conectado como root",
  );
  eq(
    ownerLine(ps, { kind: "user", user: ana }, { ...ctx, runuser: false }),
    "sudo -u ana -H env HOME=/home/ana XDG_RUNTIME_DIR=/run/user/1001 podman ps -a --format json",
    "sin runuser: sudo -u",
  );
  eq(
    ownerLine(ps, { kind: "user", user: ana }, { ...ctx, elevPrefix: "doas ", runuser: false }),
    "doas -u ana env HOME=/home/ana XDG_RUNTIME_DIR=/run/user/1001 podman ps -a --format json",
    "sin runuser: doas -u",
  );
  eq(
    ownerLine(ps, { kind: "user", user: ana }, { ...ctx, elevPrefix: "", runuser: false }),
    "su -s /bin/sh ana -c 'env HOME=/home/ana XDG_RUNTIME_DIR=/run/user/1001 podman ps -a --format json'",
    "root sin runuser: su",
  );
  // Shell interactiva: el -it pasa tal cual (runuser deja la TTY).
  const sh = ownerLine(execShellCmd("podman", "web"), { kind: "user", user: ana }, ctx);
  ok(sh.startsWith("sudo runuser -u ana -- env ") && sh.includes("podman exec -it web sh -c"), `shell: ${sh}`);
  // Logs con 2>&1 al final.
  ok(ownerLine(logsCmd("podman", "web", 10), { kind: "user", user: ana }, ctx).endsWith("podman logs --tail 10 web 2>&1"), "logs");
  // Compose: el cd va dentro, ya como el usuario.
  const up = composeCmd("podman compose", "/home/ana/app", "compose.yml", "up");
  eq(
    ownerLine(up, { kind: "user", user: ana }, ctx),
    `sudo runuser -u ana -- env HOME=/home/ana XDG_RUNTIME_DIR=/run/user/1001 sh -c '${renderCmd(up)}'`,
    "compose con carpeta",
  );
  eq(ownerLine(up, { kind: "root" }, ctx), "cd /home/ana/app && sudo podman compose -f compose.yml up -d", "compose como root (igual que antes)");
  // Docker rootless de otro usuario: su socket.
  eq(
    ownerLine(listContainers("docker"), { kind: "user", user: deploy }, { ...ctx, engine: "docker" }),
    "sudo env DOCKER_HOST=unix:///run/user/1002/docker.sock docker ps -a --no-trunc --format '{{json .}}'",
    "docker rootless",
  );
  // Docker sin permiso sobre el socket: «tú» con sudo.
  eq(ownerLine(listContainers("docker"), { kind: "self" }, { ...ctx, engine: "docker", selfPrefix: "sudo " }), "sudo docker ps -a --no-trunc --format '{{json .}}'", "docker con sudo");
}

// ───────── Agrupar comandos y elementos por dueño ─────────
{
  const a = withOwner(listContainers("podman"), "u:ana");
  const b = listContainers("podman");
  const c = withOwner(listContainers("podman"), "root");
  eq(
    groupByOwner([a, a, b, c, c], "self").map((g) => [g.owner, g.cmds.length]),
    [
      ["u:ana", 2],
      ["self", 1],
      ["root", 2],
    ],
    "grupos seguidos",
  );
  eq(withOwner(b, undefined), b, "sin dueño no cambia");
  const items = [
    { name: "web", owner: "u:ana" },
    { name: "db", owner: "root" },
    { name: "api", owner: "u:ana" },
    { name: "mio" },
  ];
  const cmds = perOwner(items, "self", (g) => ({ bin: ["podman"], args: ["stop", ...g.map((i) => i.name)] }));
  eq(
    cmds.map((x) => [x.owner, x.args.join(" ")]),
    [
      ["u:ana", "stop web api"],
      ["root", "stop db"],
      ["self", "stop mio"],
    ],
    "un comando por dueño",
  );
  eq(ownedBy(items, "u:ana").map((i) => i.name), ["web", "api"], "solo los de ana");
  eq(ownedBy(items, undefined).map((i) => i.name), ["mio"], "sin dueño");
}

// ───────── Unir listas con su usuario ─────────
{
  const m = mergeOwned([
    { owner: "root", label: "root", data: [{ id: "a" }], error: null },
    { owner: "u:ana", label: "ana", data: [{ id: "b" }, { id: "c" }], error: null },
    { owner: "u:bob", label: "bob", data: null, error: "Podman devolvió un error: newuidmap" },
  ]);
  eq(m.data, [
    { id: "a", owner: "root" },
    { id: "b", owner: "u:ana" },
    { id: "c", owner: "u:ana" },
  ], "lista unida");
  eq(m.error, "bob: Podman devolvió un error: newuidmap", "error con el nombre del usuario");
  eq(mergeOwned([{ owner: "self", label: "mael", data: null, error: "falló" }]), { data: null, error: "falló" }, "uno solo: sin nombre");
  eq(mergeOwned([{ owner: "self", label: "mael", data: [{ id: "x" }], error: null }]).data, [{ id: "x", owner: "self" }], "uno solo: con dueño");
  // CPU/memoria: el mismo nombre en dos usuarios no se mezcla.
  const stats = [
    { id: "", name: "web", cpuPercent: 1, memUsage: null, memLimit: null, memPercent: null, owner: "root" },
    { id: "", name: "web", cpuPercent: 2, memUsage: null, memLimit: null, memPercent: null, owner: "u:ana" },
  ];
  eq(statsFor(stats, { id: "abc", name: "web", owner: "u:ana" })?.cpuPercent, 2, "stats por dueño");
}

// ───────── Varios usuarios en un solo script (se ejecuta de verdad con sh) ─────────
{
  const script = multiOwnerScript(
    [
      { owner: "root", script: `echo '[{"Id":"a"}]'\necho aviso >&2` },
      { owner: "u:ana", script: "echo 'Error: newuidmap' >&2; exit 125" },
      { owner: "u:bob", script: "printf 'sin salto final'" },
      { owner: "u:lento", script: "sleep 5; echo tarde" },
    ],
    1,
  );
  const t0 = Date.now();
  const out = execFileSync("sh", ["-c", script], { encoding: "utf8" });
  const p = parseMultiOwner(out);
  eq(p.get("root"), { out: '[{"Id":"a"}]', err: "aviso", rc: 0 }, "root bien");
  eq(p.get("u:ana"), { out: "", err: "Error: newuidmap", rc: 125 }, "ana falla sin romper al resto");
  eq(p.get("u:bob")?.out, "sin salto final", "salida sin salto de línea");
  // Con `timeout`, el que se cuelga se corta (124) y no retrasa a los demás.
  const hasTimeout = (() => {
    try {
      execFileSync("sh", ["-c", "command -v timeout"]);
      return true;
    } catch {
      return false;
    }
  })();
  if (hasTimeout) {
    eq(p.get("u:lento")?.rc, 124, "el lento se corta");
    ok(Date.now() - t0 < 4000, "en paralelo y con límite");
  }
  const tail = execFileSync("sh", ["-c", `${script}\nif [ -e "$d" ]; then echo QUEDA; else echo BORRADA; fi`], { encoding: "utf8" });
  ok(tail.trim().endsWith("BORRADA"), "borra la carpeta temporal");
}

// ───────── Detección: runuser ─────────
{
  const base = "tv_begin=1\nuid=1000\ngroups=mael wheel\n";
  eq(parseDetect(`${base}runuser=1\ntv_end=1\n`).runuser, true, "runuser");
  eq(parseDetect(`${base}tv_end=1\n`).runuser, false, "sin runuser");
}

console.log(`containers.test: ${passed} comprobaciones correctas`);
