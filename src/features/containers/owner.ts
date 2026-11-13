// Contenedores de otros usuarios (con root o sudo). Funciones puras.
//
// Cada contenedor, imagen, volumen o red lleva su dueño (`owner`), y cada comando también (`Cmd.owner`):
// - "self": el usuario conectado, como siempre (si la conexión es root, root). En Docker, el demonio de siempre.
// - "root": Podman como root, con sudo.
// - "u:<usuario>": otro usuario. Se entra como él igual que el escáner (`as_owner_script` en
//   src-tauri/src/vulnscan/scripts.rs): `runuser -u U -- env HOME=… XDG_RUNTIME_DIR=…` (o `sudo -u U -H`, o `su`).
//   Docker rootless de otro usuario: su demonio, por su socket (`DOCKER_HOST=unix:///run/user/<uid>/docker.sock`).
import { shQuote } from "../admin/shell";
import { displayPrefix, q, renderCmd, type Cmd } from "./shell";
import type { Engine } from "./types";

export const OWNER_SELF = "self";
export const OWNER_ROOT = "root";
/** Opción «Todos» del selector. */
export const OWNER_ALL = "all";

/** Usuario con contenedores propios (sale de la lista del escáner: `users_script`). */
export interface OwnerUser {
  name: string;
  uid: number;
  home: string;
  podman: boolean;
  docker: boolean;
  /** Tiene /run/user/<uid> (sesión abierta o lingering). */
  runtimeDir: boolean;
}

export type CtOwner = { kind: "self" } | { kind: "root" } | { kind: "user"; user: OwnerUser };

/** Nombre de usuario aceptado (mismas reglas que `valid_user` en Rust). */
const USER_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,31}$/;

export function validOwnerUser(u: OwnerUser): boolean {
  return USER_RE.test(u.name) && u.home.startsWith("/") && !/[\n\0]/.test(u.home) && Number.isInteger(u.uid) && u.uid > 0;
}

export function ownerKey(o: CtOwner): string {
  return o.kind === "user" ? `u:${o.user.name}` : o.kind;
}

/**
 * Dueños que se pueden elegir. `me`: usuario conectado; `isRoot`: la conexión ya es root.
 * Podman: tú, root (si no eres root) y cada usuario con almacén propio. Docker: el demonio de siempre y
 * los usuarios con Docker rootless en marcha (su socket vive en /run/user/<uid>).
 */
export function ownerOptions(o: { engine: Engine; users: OwnerUser[]; me: string | null; isRoot: boolean }): CtOwner[] {
  const out: CtOwner[] = [{ kind: "self" }];
  if (o.engine === "podman" && !o.isRoot) out.push({ kind: "root" });
  for (const u of o.users) {
    if (!validOwnerUser(u) || u.name === o.me || u.name === "root") continue;
    if (o.engine === "podman" ? u.podman : u.docker && u.runtimeDir) out.push({ kind: "user", user: u });
  }
  return out;
}

/** Busca el dueño por su clave. */
export function findOwner(options: CtOwner[], key: string | undefined): CtOwner | null {
  if (key === undefined) return null;
  return options.find((o) => ownerKey(o) === key) ?? null;
}

/** Nombre corto para la columna «Usuario». `selfLabel`: cómo se llama «tú» (tu usuario, root o «sistema»). */
export function ownerName(o: CtOwner, selfLabel: string): string {
  if (o.kind === "self") return selfLabel;
  if (o.kind === "root") return "root";
  return o.user.name;
}

/** El dueño corre como root (para avisos: puertos bajos, `loginctl enable-linger`…). */
export function ownerIsRoot(o: CtOwner, isRoot: boolean): boolean {
  return o.kind === "root" || (o.kind === "self" && isRoot);
}

// ───────── Comandos ─────────

/** El mismo comando, marcado con su dueño (sin dueño = el elegido arriba). */
export function withOwner(cmd: Cmd, owner: string | undefined): Cmd {
  return owner === undefined ? cmd : { ...cmd, owner };
}

/** Agrupa comandos seguidos del mismo dueño (se ejecutan en orden, un script por grupo). */
export function groupByOwner(cmds: Cmd[], fallback: string): { owner: string; cmds: Cmd[] }[] {
  const out: { owner: string; cmds: Cmd[] }[] = [];
  for (const c of cmds) {
    const k = c.owner ?? fallback;
    const last = out[out.length - 1];
    if (last && last.owner === k) last.cmds.push(c);
    else out.push({ owner: k, cmds: [c] });
  }
  return out;
}

/** Reparte elementos por dueño, en el orden en que aparece cada uno. */
export function splitByOwner<T extends { owner?: string }>(items: T[], fallback: string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = it.owner ?? fallback;
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return [...m.entries()];
}

/** Un comando por dueño (acciones en lote sobre elementos de varios usuarios). */
export function perOwner<T extends { owner?: string }>(items: T[], fallback: string, build: (items: T[]) => Cmd): Cmd[] {
  return splitByOwner(items, fallback).map(([k, list]) => withOwner(build(list), k));
}

/** Solo los elementos de ese dueño (con un único dueño, todos tienen el mismo). */
export function ownedBy<T extends { owner?: string }>(items: T[], owner: string | undefined): T[] {
  return items.filter((i) => (i.owner ?? "") === (owner ?? ""));
}

export interface LineCtx {
  engine: Engine;
  /** «sudo », «doas » o "" (root): cómo se eleva para root y los demás usuarios. */
  elevPrefix: string;
  /** Prefijo para «tú» ("" salvo Docker sin permiso sobre el socket). */
  selfPrefix: string;
  /** El servidor tiene `runuser` (util-linux). */
  runuser: boolean;
}

/** Variables con las que se entra como otro usuario (como `run_as` en Rust). */
function userEnv(u: OwnerUser): string {
  const home = `HOME=${q(u.home)}`;
  return u.runtimeDir ? `env ${home} XDG_RUNTIME_DIR=/run/user/${u.uid}` : `env -u XDG_RUNTIME_DIR ${home}`;
}

/**
 * Comando en una sola línea, tal y como se muestra y como se escribe en la terminal (shell interactiva
 * incluida: `runuser` y `sudo -u` dejan pasar la TTY). La ejecución desde la interfaz usa el script de
 * Rust (`as_owner_script`), que hace lo mismo y además prueba `runuser`, `sudo -u` y `su` por orden.
 */
export function ownerLine(cmd: Cmd, o: CtOwner, ctx: LineCtx): string {
  if (o.kind === "self") return displayPrefix(ctx.selfPrefix, cmd);
  if (o.kind === "root") return displayPrefix(ctx.elevPrefix, cmd);
  const u = o.user;
  // Con carpeta (Compose) el `cd` va dentro, ya como el usuario: puede que tú no puedas entrar en su HOME.
  const body = cmd.cwd ? `sh -c ${shQuote(renderCmd(cmd))}` : renderCmd(cmd);
  if (ctx.engine === "docker") return `${ctx.elevPrefix}env DOCKER_HOST=unix:///run/user/${u.uid}/docker.sock ${body}`;
  const name = q(u.name);
  if (ctx.runuser) return `${ctx.elevPrefix}runuser -u ${name} -- ${userEnv(u)} ${body}`;
  if (ctx.elevPrefix.startsWith("sudo")) return `sudo -u ${name} -H ${userEnv(u)} ${body}`;
  if (ctx.elevPrefix.startsWith("doas")) return `doas -u ${name} ${userEnv(u)} ${body}`;
  return `su -s /bin/sh ${name} -c ${shQuote(`${userEnv(u)} ${body}`)}`;
}

// ───────── Varios usuarios en un solo script ─────────

/**
 * Ejecuta los scripts de varios dueños **a la vez** en el servidor (en segundo plano, cada uno con su
 * salida aparte) y luego los imprime por secciones `@@tvo:out|err|rc <dueño>`. Un dueño que falla o se
 * cuelga (límite `timeoutSecs` si hay `timeout`) no estropea a los demás.
 */
export function multiOwnerScript(parts: { owner: string; script: string }[], timeoutSecs: number): string {
  const lines = [
    `t=; if command -v timeout >/dev/null 2>&1; then t="timeout ${Math.max(1, Math.floor(timeoutSecs))}"; fi`,
    "d=$(mktemp -d 2>/dev/null) || { echo 'No se pudo crear una carpeta temporal' >&2; exit 1; }",
  ];
  parts.forEach((p, i) => {
    lines.push(`{ $t sh -c ${shQuote(p.script)} >"$d/${i}.out" 2>"$d/${i}.err" </dev/null; echo $? >"$d/${i}.rc"; } &`);
  });
  lines.push("wait");
  parts.forEach((p, i) => {
    const k = shQuote(p.owner);
    lines.push(
      `printf '@@tvo:out %s\\n' ${k}; cat "$d/${i}.out" 2>/dev/null; echo`,
      `printf '@@tvo:err %s\\n' ${k}; cat "$d/${i}.err" 2>/dev/null; echo`,
      `printf '@@tvo:rc %s\\n' ${k}; cat "$d/${i}.rc" 2>/dev/null || echo 1`,
    );
  });
  lines.push("echo @@tvo:end", 'rm -rf "$d"');
  return lines.join("\n");
}

export interface OwnerOutput {
  out: string;
  err: string;
  /** Código de salida (124 = se agotó el tiempo; null = no llegó). */
  rc: number | null;
}

/** Lee la salida de `multiOwnerScript`. */
export function parseMultiOwner(stdout: string): Map<string, OwnerOutput> {
  const res = new Map<string, OwnerOutput>();
  let cur: { owner: string; part: "out" | "err" | "rc" } | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!cur) return;
    const o = res.get(cur.owner) ?? { out: "", err: "", rc: null };
    const text = buf.join("\n").replace(/\n+$/, "");
    if (cur.part === "rc") o.rc = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
    else o[cur.part] = text;
    res.set(cur.owner, o);
  };
  for (const line of stdout.split("\n")) {
    const m = /^@@tvo:(out|err|rc) (\S+)$/.exec(line);
    if (m || line === "@@tvo:end") {
      flush();
      cur = m ? { owner: m[2], part: m[1] as "out" | "err" | "rc" } : null;
      buf = [];
    } else if (cur) buf.push(line);
  }
  flush();
  return res;
}

/** Une las listas de varios dueños (cada elemento con su `owner`) y junta los errores con su nombre. */
export function mergeOwned<T extends object>(
  parts: { owner: string; label: string; data: T[] | null; error: string | null }[],
): { data: (T & { owner: string })[] | null; error: string | null } {
  const ok = parts.filter((p) => p.data !== null);
  const bad = parts.filter((p) => p.error);
  const data = ok.length ? ok.flatMap((p) => (p.data ?? []).map((d) => ({ ...d, owner: p.owner }))) : null;
  const error = bad.length
    ? parts.length === 1
      ? bad[0].error
      : bad.map((p) => `${p.label}: ${p.error}`).join("\n\n")
    : null;
  return { data, error };
}
