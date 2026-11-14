// Mapa de infraestructura: lectura de un servidor conectado. Reutiliza los scripts de Administración
// (Puertos y Sitios web) y de Contenedores (también los de otros usuarios con sudo). Solo lectura: nada
// se instala ni se cambia en el servidor.
import { errorMessage } from "../../api/core";
import { PORTS_SCRIPT, WEB_SCRIPT, parsePorts, parseWeb, readElevated, runScript } from "../admin";
import {
  computeElevation,
  detectPrivilege,
  getPrivilege,
  getSudoPassword,
  obtainSudoPassword,
  sudoPasswordNeeded,
  type Elevation,
} from "../privileges";
import { SYSTEM_OWNER, type OwnedContainer, type ServerSnapshot } from "./graph";
import { INFRA_SCRIPT, USER_SERVICES_SCRIPT, parseInfra, parseUnits, type HumanUser } from "./parse";

const NONE: Elevation = { kind: "none" };

export interface CollectTarget {
  profileId: string;
  name: string;
  host: string;
  sessionId: string;
}

/** Contenedores de todos los dueños que se ven (con sudo: root y cada usuario, como en Contenedores). */
async function readContainers(sessionId: string, el: Elevation | null, me: string | null, isRootConn: boolean, notes: string[]): Promise<OwnedContainer[]> {
  const c = await import("../containers");
  const det = await c.runRaw(sessionId, c.DETECT_SCRIPT, NONE, 40);
  const found = det.result ? c.parseDetect(det.result.stdout) : null;
  if (!found?.ok) return [];
  const isRoot = isRootConn || found.uid === 0;
  const out: OwnedContainer[] = [];
  let users: Awaited<ReturnType<typeof import("../vulnscan/run").loadStoreUsers>> | null = null;
  if (el) {
    try {
      const { loadStoreUsers } = await import("../vulnscan/run");
      users = await loadStoreUsers(sessionId, el);
    } catch {
      users = null;
    }
  }
  for (const st of [found.podman, found.docker]) {
    if (!st?.installed) continue;
    if (st.engine === "docker" && found.dockerIsShim) continue;
    const engine = st.engine;
    const owners = el ? c.ownerOptions({ engine, users: users?.users ?? [], me, isRoot }) : [{ kind: "self" } as const];
    const selfSudo = engine === "docker" && st.needsSudo && !isRoot;
    const usable = owners.filter((o) => o.kind !== "self" || st.accessible || (selfSudo && !!el));
    if (usable.length === 0) continue;
    const userOf = (o: (typeof owners)[number]) =>
      o.kind === "user" ? o.user.name : o.kind === "root" || isRoot || (engine === "docker" && !st.rootless) ? SYSTEM_OWNER : (me ?? SYSTEM_OWNER);
    const runner = {
      sessionId,
      engine,
      fallback: c.OWNER_SELF,
      resolve: (k: string) => c.findOwner(owners, k),
      elevationFor: (o: (typeof owners)[number]) => (o.kind === "self" ? (selfSudo ? el : NONE) : el),
      label: (o: (typeof owners)[number]) => userOf(o),
    };
    const per = await c.readOwners(runner, usable, c.scriptFor([c.listContainers(engine)]), 30);
    for (const o of usable) {
      const r = per.get(c.ownerKey(o));
      if (!r?.ok || !r.result) {
        if (r?.error && o.kind === "self") notes.push(`${engine}: ${r.error.split("\n")[0]}`);
        continue;
      }
      for (const ct of c.parseContainers(r.result.stdout)) out.push({ ...ct, engine, user: userOf(o) });
    }
  }
  return out;
}

/** Servicios `systemctl --user` de los demás usuarios (con sudo, entrando como cada uno). */
async function readUserServices(sessionId: string, el: Elevation, humans: HumanUser[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const list = humans.filter((h) => h.runtimeDir && h.home.startsWith("/"));
  if (list.length === 0) return out;
  const c = await import("../containers");
  const owners = list.map((h) => ({ kind: "user" as const, user: { name: h.name, uid: h.uid, home: h.home, podman: true, docker: false, runtimeDir: true } }));
  const runner = {
    sessionId,
    engine: "podman" as const,
    fallback: c.OWNER_SELF,
    resolve: (k: string) => c.findOwner(owners, k),
    elevationFor: () => el,
    label: (o: { kind: string; user?: { name: string } }) => o.user?.name ?? "",
  };
  const per = await c.readOwners(runner, owners, USER_SERVICES_SCRIPT, 20);
  for (const o of owners) {
    const r = per.get(c.ownerKey(o));
    const units = r?.ok && r.result ? parseUnits(r.result.stdout.split("\n")) : [];
    if (units.length) out[o.user.name] = units;
  }
  return out;
}

/**
 * Lee un servidor conectado. Con sudo (contraseña guardada o de otra pestaña, sin preguntar) se ve todo.
 * `elevate: false` (asistentes por MCP): como el usuario conectado, igual que list_ports.
 */
export async function collectServer(t: CollectTarget, opts: { elevate?: boolean } = {}): Promise<ServerSnapshot> {
  const snap: ServerSnapshot = {
    id: t.profileId,
    name: t.name,
    host: t.host,
    sessionId: t.sessionId,
    error: null,
    elevated: false,
    me: null,
    ports: null,
    web: null,
    containers: [],
    extra: null,
    userServices: {},
    notes: [],
  };
  try {
    const known = getPrivilege(t.sessionId);
    const info = known && known.level !== "unknown" ? known : await detectPrivilege(t.sessionId);
    snap.me = info.user;
    const elevate = opts.elevate !== false;
    if (elevate && sudoPasswordNeeded(info)) await obtainSudoPassword(t.sessionId, t.profileId).catch(() => null);
    const el = elevate ? computeElevation(info, getSudoPassword(t.sessionId)).elevation : null;
    const isRoot = info.level === "root";
    const [ports, web, infra] = await Promise.all([
      readElevated(t.sessionId, PORTS_SCRIPT, el, 25),
      readElevated(t.sessionId, WEB_SCRIPT, el, 40).catch(() => null),
      readElevated(t.sessionId, INFRA_SCRIPT, el, 25).catch(() => null),
    ]);
    const elevated = ports.elevated;
    snap.elevated = elevated || isRoot;
    snap.ports = parsePorts(ports.result.stdout);
    snap.web = web ? parseWeb(web.result.stdout) : null;
    snap.extra = infra ? parseInfra(infra.result.stdout) : null;
    const usedEl = elevated ? el : isRoot ? NONE : null;
    snap.containers = await readContainers(t.sessionId, usedEl, info.user, isRoot, snap.notes).catch((e) => {
      snap.notes.push(`Contenedores: ${errorMessage(e)}`);
      return [];
    });
    // Servicios de usuario: los propios siempre; los de los demás, con sudo.
    if (snap.extra) {
      let own = snap.extra.userServices;
      if (elevated && !isRoot) {
        const r = await runScript(t.sessionId, USER_SERVICES_SCRIPT, NONE, "", 15).catch(() => null);
        own = r ? parseUnits(r.stdout.split("\n")) : [];
      }
      if (info.user && own.length && !isRoot) snap.userServices[info.user] = own;
      if (usedEl) {
        const others = [...snap.extra.humans.values()].filter((h) => h.name !== info.user);
        Object.assign(snap.userServices, await readUserServices(t.sessionId, usedEl, others).catch(() => ({})));
      }
    }
    if (!snap.elevated) snap.notes.unshift("Con sudo verías los de todos los usuarios");
  } catch (e) {
    snap.error = errorMessage(e);
  }
  return snap;
}
