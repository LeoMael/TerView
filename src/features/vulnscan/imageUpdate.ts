// «Actualizar imagen» (escáner → hallazgo de una imagen de Podman o Docker). Funciones puras, sin React
// ni Tauri: elegir el camino de cada contenedor que usa la imagen, construir los comandos y rellenar el
// formulario «Nuevo contenedor» a partir de `inspect`.
//
// Caminos (se leen en el momento con `inspect`, no del informe):
//  1. Compose (etiquetas com.docker.compose.*): `compose pull` + `compose up -d` en su carpeta, con sus
//     archivos, su nombre de proyecto y solo sus servicios. Una vez por proyecto.
//  2. systemd / Quadlet (Podman, etiqueta PODMAN_SYSTEMD_UNIT): `pull` + reiniciar la unidad (de sistema
//     si el dueño es root; de usuario si no). Una vez por unidad.
//  3. Creado con `run` a mano: `pull` y después el formulario «Nuevo contenedor» relleno, en modo
//     «reemplazar»: el viejo se renombra a <nombre>-viejo y se para; si el nuevo arranca bien se borra el
//     viejo, y si no, se borra el nuevo y vuelve el viejo (`replaceScript`).
//  4. Imagen local o sin etiqueta: no hay botón (`updatableTag` → null).
//  5. Sin contenedores: solo el `pull`.
// Lo que no se puede hacer solo (pods, Swarm, Compose sin la herramienta…) queda como «a mano».
import type { Engine, Target } from "../../api/vulnscan";
import { composeCmd, composeFor, emptyRunForm, pullImage, runCmd, type RestartPolicy, type RunForm } from "../containers/commands";
import { parseJsonList, splitMarked } from "../containers/parse";
import { engineCmd, q, renderCmd, OBJ_NAME_RE, type Cmd } from "../containers/shell";
import type { ComposeTool } from "../containers/types";
import { SAFE, updatableTag } from "./fixCommand";

// ───────── Dueño de la imagen ─────────

/** Con quién se ejecuta: el usuario conectado, root (elevando) u otro usuario (elevando y entrando como él). */
export type Owner = { kind: "self" } | { kind: "root" } | { kind: "user"; name: string };

/**
 * Dueño de la imagen del informe. `target.user`: null = el usuario conectado; "root"; u otro usuario.
 * `me`: usuario conectado; `connectedAsRoot`: la conexión ya es root.
 */
export function ownerOf(t: Target, me: string | null, connectedAsRoot: boolean): Owner {
  const u = t.user;
  if (!u || u === me) return { kind: "self" };
  if (u === "root") return connectedAsRoot ? { kind: "self" } : { kind: "root" };
  return { kind: "user", name: u };
}

/** El dueño es root (para elegir `systemctl` o `systemctl --user`). */
export function ownerIsRoot(o: Owner, connectedAsRoot: boolean): boolean {
  return o.kind === "root" || (o.kind === "self" && connectedAsRoot);
}

export function ownerLabel(o: Owner, me: string | null): string {
  if (o.kind === "root") return "root";
  if (o.kind === "user") return o.name;
  return me ?? "tu usuario";
}

/** Se puede actualizar: imagen con etiqueta descargable y motor conocido. */
export function canUpdateImage(t: Target | undefined): boolean {
  return t?.kind === "image" && !!t.image?.engine && !!updatableTag(t) && /^[0-9a-f]{12,64}$/.test(t.image.id);
}

// ───────── Lectura (inspect) ─────────

/**
 * Script de lectura (se ejecuta como el dueño): herramientas de Compose, `image inspect` y `inspect` de
 * los contenedores cuya imagen es esta. Secciones `@@tv:…`.
 */
export function readScript(engine: Engine, imageId: string): string {
  const id = imageId.replace(/[^0-9a-f]/g, "");
  const e = engine;
  const compose =
    e === "podman"
      ? [
          'if podman compose version >/dev/null 2>&1; then echo "podman compose"; fi',
          "if command -v podman-compose >/dev/null 2>&1; then echo podman-compose; fi",
        ]
      : [
          'if docker compose version >/dev/null 2>&1; then echo "docker compose"; fi',
          "if command -v docker-compose >/dev/null 2>&1; then echo docker-compose; fi",
        ];
  return [
    "echo @@tv:compose",
    ...compose,
    "echo @@tv:image",
    `${e} image inspect ${id} 2>/dev/null`,
    "echo @@tv:containers",
    // Contenedores cuya imagen empieza por este id (Podman: sin «sha256:»; Docker: con él).
    `ids=$(${e} ps -aq --no-trunc 2>/dev/null | xargs -r ${e} inspect --format '{{.Id}} {{.Image}}' 2>/dev/null | ` +
      `awk -v i=${id} 'index($2, i) == 1 || index($2, "sha256:" i) == 1 { print $1 }')`,
    `if [ -n "$ids" ]; then ${e} inspect $ids 2>/dev/null; fi`,
    "echo @@tv:end",
  ].join("\n");
}

/** Configuración de la imagen (para no copiar al formulario lo que ya trae la imagen). */
export interface ImageConfig {
  env: string[];
  cmd: string[];
  entrypoint: string[];
  user: string;
  workdir: string;
  labels: Record<string, string>;
}

export interface PortBinding {
  /** "80/tcp" */
  container: string;
  hostIp: string;
  hostPort: string;
}

export interface MountInfo {
  type: string;
  source: string;
  name: string;
  destination: string;
  rw: boolean;
}

/** Lo que hace falta de `inspect` de un contenedor. */
export interface ContainerDetail {
  id: string;
  name: string;
  /** Id completo de su imagen. */
  imageId: string;
  /** Referencia con la que se creó (nginx:1.25, docker.io/library/nginx:1.25…). */
  imageRef: string;
  running: boolean;
  labels: Record<string, string>;
  pod: string;
  env: string[];
  cmd: string[];
  entrypoint: string[];
  user: string;
  workdir: string;
  ports: PortBinding[];
  mounts: MountInfo[];
  /** HostConfig.Binds (para ver si llevan «:Z»). */
  binds: string[];
  restart: string;
  restartRetries: number;
  networkMode: string;
  networks: string[];
  privileged: boolean;
  capAdd: string[];
  devices: number;
  memory: number;
  cpus: number;
  autoRemove: boolean;
  extraHosts: string[];
  dns: string[];
}

export interface ReadResult {
  complete: boolean;
  composeTools: ComposeTool[];
  image: ImageConfig | null;
  containers: ContainerDetail[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function obj(v: unknown): Obj {
  return isObj(v) ? v : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str);
  if (typeof v === "string" && v) return [v];
  return [];
}
function labelsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) out[k] = str(val);
  return out;
}

function imageConfig(o: Obj): ImageConfig {
  const c = obj(o.Config);
  return { env: list(c.Env), cmd: list(c.Cmd), entrypoint: list(c.Entrypoint), user: str(c.User), workdir: str(c.WorkingDir), labels: labelsOf(c.Labels) };
}

function portBindings(o: Obj): PortBinding[] {
  const host = obj(o.HostConfig);
  let src = obj(host.PortBindings);
  if (!Object.keys(src).length) src = obj(obj(o.NetworkSettings).Ports);
  const out: PortBinding[] = [];
  for (const [cport, binds] of Object.entries(src)) {
    if (!Array.isArray(binds)) continue;
    for (const b of binds) if (isObj(b)) out.push({ container: cport, hostIp: str(b.HostIp), hostPort: str(b.HostPort) });
  }
  return out;
}

function containerDetail(o: Obj): ContainerDetail {
  const c = obj(o.Config);
  const h = obj(o.HostConfig);
  const st = obj(o.State);
  const rp = obj(h.RestartPolicy);
  return {
    id: str(o.Id),
    name: str(o.Name).replace(/^\//, ""),
    imageId: str(o.Image),
    imageRef: str(o.ImageName) || str(c.Image),
    running: st.Running === true,
    labels: labelsOf(c.Labels),
    pod: str(o.Pod),
    env: list(c.Env),
    cmd: list(c.Cmd),
    entrypoint: list(c.Entrypoint),
    user: str(c.User),
    workdir: str(c.WorkingDir),
    ports: portBindings(o),
    mounts: (Array.isArray(o.Mounts) ? o.Mounts : []).filter(isObj).map((m) => ({
      type: str(m.Type),
      source: str(m.Source),
      name: str(m.Name),
      destination: str(m.Destination),
      rw: m.RW !== false,
    })),
    binds: list(h.Binds),
    restart: str(rp.Name),
    restartRetries: num(rp.MaximumRetryCount),
    networkMode: str(h.NetworkMode),
    networks: Object.keys(obj(obj(o.NetworkSettings).Networks)),
    privileged: h.Privileged === true,
    capAdd: list(h.CapAdd),
    devices: Array.isArray(h.Devices) ? h.Devices.length : 0,
    memory: num(h.Memory),
    cpus: num(h.NanoCpus),
    autoRemove: h.AutoRemove === true,
    extraHosts: list(h.ExtraHosts),
    dns: list(h.Dns),
  };
}

const COMPOSE_TOOLS: ComposeTool[] = ["docker compose", "docker-compose", "podman compose", "podman-compose"];

/** Lee la salida de `readScript`. Solo deja los contenedores cuya imagen es `imageId`. */
export function parseRead(stdout: string, imageId: string): ReadResult {
  const s = splitMarked(stdout);
  const tools = (s.get("compose") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l): l is ComposeTool => (COMPOSE_TOOLS as string[]).includes(l));
  const img = parseJsonList(s.get("image") ?? "")[0];
  const id = imageId.replace(/^sha256:/, "");
  const containers = parseJsonList(s.get("containers") ?? "")
    .map(containerDetail)
    .filter((c) => c.name && c.imageId.replace(/^sha256:/, "").startsWith(id));
  return { complete: s.has("end"), composeTools: [...new Set(tools)], image: img ? imageConfig(img) : null, containers };
}

// ───────── Plan ─────────

export type Group =
  | { kind: "compose"; project: string; dir: string; files: string[]; services: string[]; tool: ComposeTool; containers: string[] }
  | { kind: "systemd"; unit: string; user: boolean; containers: string[] }
  /** `ref`: imagen con la que se vuelve a crear. */
  | { kind: "run"; container: ContainerDetail; ref: string }
  | { kind: "manual"; containers: string[]; reason: string };

export interface Step {
  /** Texto corto («Descargar nginx:1.27», «Compose «web»: descargar y recrear»…). */
  label: string;
  cmds: Cmd[];
}

export interface UpdatePlan {
  engine: Engine;
  tag: string;
  groups: Group[];
  /** Pasos automáticos, en orden (descarga, Compose, systemd). Los «run» van después, uno a uno. */
  steps: Step[];
  /** Contenedores que se recrean (Compose, systemd y los «run» si se confirman). */
  recreated: string[];
  /** Avisos generales (sin contenedores, etc.). */
  notes: string[];
}

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:-]*\.service$/;

function okPath(p: string): boolean {
  return p.startsWith("/") && !/[\n\r\0]/.test(p);
}

/** Herramienta de Compose para estos contenedores (null = no hay una que sirva). */
export function composeToolFor(engine: Engine, labels: Record<string, string>, tools: ComposeTool[]): ComposeTool | null {
  if (engine === "podman") {
    // Creado con podman-compose: otra herramienta pondría otros nombres y duplicaría los contenedores.
    if (labels["io.podman.compose.project"]) return tools.includes("podman-compose") ? "podman-compose" : null;
    return tools.includes("podman compose") ? "podman compose" : null;
  }
  return composeFor("docker", tools);
}

interface ComposeInfo {
  project: string;
  dir: string;
  files: string[];
  service: string;
}

function composeInfo(c: ContainerDetail): ComposeInfo | null {
  const l = c.labels;
  const project = l["com.docker.compose.project"] ?? l["io.podman.compose.project"] ?? "";
  if (!project) return null;
  const dir = l["com.docker.compose.project.working_dir"] ?? "";
  const files = (l["com.docker.compose.project.config_files"] ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  return { project, dir, files, service: l["com.docker.compose.service"] ?? "" };
}

/** Referencia que se descarga para un contenedor: con la que se creó si es de esta imagen, si no la etiqueta. */
function refFor(c: ContainerDetail, tags: string[], tag: string): string {
  const r = c.imageRef;
  const norm = (x: string) => x.replace(/^docker\.io\/(library\/)?/, "");
  const known = tags.some((t) => t === r || norm(t) === norm(r) || norm(t) === `${norm(r)}:latest`);
  return r && known && SAFE.test(r) && !r.startsWith("localhost/") ? r : tag;
}

export interface PlanInput {
  engine: Engine;
  /** Etiqueta a descargar (`updatableTag`). */
  tag: string;
  /** Todas las etiquetas de la imagen. */
  tags: string[];
  read: ReadResult;
  ownerIsRoot: boolean;
}

/** Decide qué hacer con cada contenedor y arma los pasos automáticos. */
export function planUpdate(i: PlanInput): UpdatePlan {
  const { engine, tag, read } = i;
  const groups: Group[] = [];
  const compose = new Map<string, Extract<Group, { kind: "compose" }>>();
  const units = new Map<string, Extract<Group, { kind: "systemd" }>>();
  const manual = new Map<string, Extract<Group, { kind: "manual" }>>();
  const addManual = (name: string, reason: string) => {
    const g = manual.get(reason) ?? { kind: "manual" as const, containers: [], reason };
    g.containers.push(name);
    if (!manual.has(reason)) {
      manual.set(reason, g);
      groups.push(g);
    }
  };
  const pulls: string[] = [tag];

  for (const c of read.containers) {
    const ci = composeInfo(c);
    if (ci) {
      const tool = composeToolFor(engine, c.labels, read.composeTools);
      if (!ci.dir || !okPath(ci.dir) || !PROJECT_RE.test(ci.project) || ci.files.some((f) => /[\n\r\0]/.test(f))) {
        addManual(c.name, "Es de Compose pero no se sabe su carpeta: entra en ella y ejecuta «compose pull» y «compose up -d»");
        continue;
      }
      if (!tool) {
        addManual(
          c.name,
          c.labels["io.podman.compose.project"]
            ? "Se creó con podman-compose, que no está instalado para este usuario"
            : `No se encontró ${engine === "podman" ? "«podman compose»" : "Docker Compose"} en el servidor`,
        );
        continue;
      }
      const key = `${ci.project}\n${ci.dir}`;
      let g = compose.get(key);
      if (!g) {
        g = { kind: "compose", project: ci.project, dir: ci.dir, files: ci.files, services: [], tool, containers: [] };
        compose.set(key, g);
        groups.push(g);
      }
      g.containers.push(c.name);
      if (ci.service && OBJ_NAME_RE.test(ci.service) && !g.services.includes(ci.service)) g.services.push(ci.service);
      continue;
    }
    const unit = c.labels.PODMAN_SYSTEMD_UNIT ?? "";
    if (engine === "podman" && unit) {
      if (!UNIT_RE.test(unit)) {
        addManual(c.name, `Lo arranca systemd («${unit}»): reinicia esa unidad a mano`);
        continue;
      }
      let g = units.get(unit);
      if (!g) {
        g = { kind: "systemd", unit, user: !i.ownerIsRoot, containers: [] };
        units.set(unit, g);
        groups.push(g);
      }
      g.containers.push(c.name);
      const ref = refFor(c, i.tags, tag);
      if (!pulls.includes(ref)) pulls.push(ref);
      continue;
    }
    if (c.labels["com.docker.swarm.service.name"]) {
      addManual(c.name, "Es de un servicio de Docker Swarm: usa «docker service update --image»");
      continue;
    }
    if (c.pod) {
      addManual(c.name, `Está dentro de un pod: vuelve a crear el pod con el archivo con que lo creaste`);
      continue;
    }
    if (!OBJ_NAME_RE.test(c.name)) {
      addManual(c.name, "Su nombre tiene caracteres raros: vuelve a crearlo a mano");
      continue;
    }
    const ref = refFor(c, i.tags, tag);
    groups.push({ kind: "run", container: c, ref });
    if (!pulls.includes(ref)) pulls.push(ref);
  }

  const steps: Step[] = pulls.map((r) => ({ label: `Descargar ${r}`, cmds: [pullImage(engine, r)] }));
  for (const g of groups) {
    if (g.kind === "compose") {
      const o = { project: g.project, services: g.services };
      steps.push({
        label: `Compose «${g.project}»: descargar y recrear (${g.containers.join(", ")})`,
        cmds: [composeCmd(g.tool, g.dir, g.files, "pull", o), composeCmd(g.tool, g.dir, g.files, "up", o)],
      });
    } else if (g.kind === "systemd") {
      steps.push({ label: `Reiniciar ${g.unit} (${g.containers.join(", ")})`, cmds: [systemctlRestart(g.unit, g.user)] });
    }
  }
  const recreated = groups.flatMap((g) => (g.kind === "compose" || g.kind === "systemd" ? g.containers : g.kind === "run" ? [g.container.name] : []));
  const notes: string[] = [];
  if (!read.containers.length) notes.push("Ningún contenedor la usa: solo se descarga la versión nueva. Quizá basta con borrarla.");
  return { engine, tag, groups, steps, recreated, notes };
}

export function systemctlRestart(unit: string, user: boolean): Cmd {
  return { bin: ["systemctl"], args: [...(user ? ["--user"] : []), "restart", unit] };
}

/** Script de un paso: se para en el primer comando que falle. */
export function stepScript(s: Step): string {
  return ["set -e", ...s.cmds.map(renderCmd)].join("\n");
}

// ───────── Formulario «Nuevo contenedor» desde inspect ─────────

const DEFAULT_NETS = new Set(["", "default", "bridge", "podman", "slirp4netns", "pasta", "private"]);
const AUTO_ENV = new Set(["HOSTNAME", "container"]);
const IGNORED_LABEL = /^(io\.(podman|containers|buildah|k8s)|org\.opencontainers|com\.docker\.compose|PODMAN_SYSTEMD_UNIT|maintainer$|description$|summary$|vendor$|version$|release$|name$|architecture$|build-date$|vcs-|url$|license$|distribution-scope$|com\.redhat|io\.openshift)/;

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function restartOf(name: string): RestartPolicy {
  return name === "always" || name === "unless-stopped" || name === "on-failure" ? name : "no";
}

/**
 * Rellena el formulario con lo que tenía el contenedor. Devuelve también lo que NO se copia (para
 * avisar antes de confirmar).
 */
export function runFormFrom(c: ContainerDetail, image: ImageConfig | null, ref: string, engine: Engine): { form: RunForm; warnings: string[] } {
  const warnings: string[] = [];
  const form = emptyRunForm();
  form.image = ref;
  form.name = c.name;

  for (const p of c.ports) {
    const [port, proto] = p.container.split("/");
    const ip = p.hostIp;
    const localOnly = ip === "127.0.0.1" || ip === "::1";
    if (ip && !localOnly && ip !== "0.0.0.0" && ip !== "::") warnings.push(`El puerto ${p.hostPort || port} solo escuchaba en ${ip}: ahora escuchará en todas las direcciones`);
    form.ports.push({ host: p.hostPort, container: port, protocol: proto === "udp" ? "udp" : "tcp", localOnly });
  }
  const seenPort = new Set<string>();
  form.ports = form.ports.filter((p) => {
    const k = `${p.host}|${p.container}|${p.protocol}|${p.localOnly}`;
    if (seenPort.has(k)) return false;
    seenPort.add(k);
    return true;
  });

  for (const m of c.mounts) {
    if (m.type === "bind") form.volumes.push({ source: m.source, target: m.destination, readOnly: !m.rw });
    else if (m.type === "volume" && m.name) form.volumes.push({ source: m.name, target: m.destination, readOnly: !m.rw });
    else warnings.push(`El montaje «${m.destination}» (${m.type || "desconocido"}) no se copia`);
  }
  if (engine === "podman" && c.binds.some((b) => /[:,][zZ](,|$)/.test(b))) form.selinuxLabel = true;
  if (c.binds.some((b) => /[:,]z(,|$)/.test(b))) warnings.push("Alguna carpeta usaba «:z» (compartida): se pondrá «:Z» (solo para este contenedor)");

  const imgEnv = new Set(image?.env ?? []);
  const imgKeys = new Set((image?.env ?? []).map((e) => e.split("=")[0]));
  for (const e of c.env) {
    if (imgEnv.has(e)) continue;
    const i = e.indexOf("=");
    const key = i < 0 ? e : e.slice(0, i);
    const value = i < 0 ? "" : e.slice(i + 1);
    if (AUTO_ENV.has(key)) continue;
    // Podman pone HOME y TERM aunque no se pidan.
    if (!imgKeys.has(key) && ((key === "HOME" && value === "/root") || (key === "TERM" && value === "xterm"))) continue;
    form.env.push({ key, value });
  }

  form.restart = restartOf(c.restart);
  if (c.restart === "on-failure" && c.restartRetries > 0) warnings.push(`Reinicio «solo si falla» tenía un máximo de ${c.restartRetries} intentos: ahora sin máximo`);

  const mode = c.networkMode;
  if (mode.startsWith("container:") || mode.startsWith("ns:") || mode.startsWith("service:")) {
    warnings.push(`Usaba la red de otro contenedor («${mode}»): no se copia`);
  } else if (mode === "host" || mode === "none") {
    form.network = mode;
  } else if (!DEFAULT_NETS.has(mode)) {
    form.network = mode;
  } else {
    const custom = c.networks.filter((n) => !DEFAULT_NETS.has(n));
    if (custom.length) form.network = custom[0];
  }
  const extraNets = c.networks.filter((n) => !DEFAULT_NETS.has(n) && n !== form.network);
  if (extraNets.length) warnings.push(`También estaba en ${extraNets.join(", ")}: solo se copia una red`);

  if (image && !sameList(c.cmd, image.cmd)) form.command = c.cmd.map(q).join(" ");
  if (image && !sameList(c.entrypoint, image.entrypoint)) warnings.push("Usaba otro punto de entrada (--entrypoint): no se copia");
  if (!image && c.cmd.length) warnings.push("No se pudo leer la imagen: el comando se deja el de la imagen");
  if (image && c.user && c.user !== image.user) warnings.push(`Se ejecutaba como «${c.user}» (--user): no se copia`);
  if (image && c.workdir && c.workdir !== image.workdir) warnings.push(`Carpeta de trabajo «${c.workdir}» (--workdir): no se copia`);
  if (c.privileged) warnings.push("Era privilegiado (--privileged): no se copia");
  if (c.capAdd.length) warnings.push(`Permisos extra (--cap-add ${c.capAdd.join(", ")}): no se copian`);
  if (c.devices) warnings.push("Tenía dispositivos (--device): no se copian");
  if (c.memory || c.cpus) warnings.push("Tenía límites de memoria o CPU: no se copian");
  if (c.extraHosts.length || c.dns.length) warnings.push("Tenía hosts o DNS propios (--add-host, --dns): no se copian");
  const labels = Object.keys(c.labels).filter((k) => !IGNORED_LABEL.test(k) && !(image && k in image.labels));
  if (labels.length) warnings.push(`Etiquetas propias (${labels.slice(0, 4).join(", ")}${labels.length > 4 ? "…" : ""}): no se copian`);
  if (c.autoRemove) warnings.push("Se creó con --rm: al pararlo se borra, así que si el nuevo falla no se podrá volver al viejo");
  return { form, warnings };
}

/** Nombre temporal del contenedor viejo mientras se prueba el nuevo. */
export function oldNameOf(name: string): string {
  return `${name}-viejo`;
}

/**
 * Reemplaza un contenedor por otro creado con `form` (mismo nombre):
 * renombra el viejo a <nombre>-viejo y lo para; crea el nuevo; si arranca bien (y sigue en marcha a los
 * 5 s sin reiniciarse, si el viejo estaba en marcha) borra el viejo; si no, borra el nuevo, devuelve el nombre al viejo y
 * lo arranca. Sale con 0 solo si quedó el nuevo.
 */
export function replaceScript(engine: Engine, name: string, wasRunning: boolean, form: RunForm): string {
  const old = oldNameOf(name);
  const e = (...a: string[]) => renderCmd(engineCmd(engine, ...a));
  const run = renderCmd(runCmd(engine, { ...form, name }));
  const lines = [
    `if ${e("inspect", "--type", "container", old)} >/dev/null 2>&1; then`,
    `  echo ${q(`Ya existe un contenedor «${old}»: bórralo o cámbiale el nombre y vuelve a intentarlo`)} >&2`,
    "  exit 1",
    "fi",
    `${e("rename", name, old)} || exit 1`,
    `if ! ${e("stop", old)} >/dev/null; then`,
    `  ${e("rename", old, name)}`,
    `  echo ${q("No se pudo parar el contenedor viejo: no se cambió nada")} >&2`,
    "  exit 1",
    "fi",
    "ok=0",
    `if ${run}; then`,
    "  ok=1",
  ];
  if (wasRunning) {
    lines.push(
      "  sleep 5",
      // En marcha y sin reinicios (con «--restart» un contenedor que falla puede verse en marcha un momento).
      `  if [ "$(${e("inspect", "--format", "{{.State.Running}} {{.RestartCount}}", name)} 2>/dev/null)" != "true 0" ]; then`,
      "    ok=0",
      `    echo ${q("El contenedor nuevo se paró al arrancar. Sus últimos mensajes:")} >&2`,
      `    ${e("logs", "--tail", "30", name)} >&2 2>&1`,
      "  fi",
    );
  }
  lines.push(
    "fi",
    'if [ "$ok" = 1 ]; then',
    `  ${e("rm", old)} >/dev/null || echo ${q(`No se pudo borrar «${old}»: bórralo a mano`)} >&2`,
    `  echo ${q(`Listo: «${name}» ya usa la imagen nueva.`)}`,
    "  exit 0",
    "fi",
    `echo ${q("No salió bien: se vuelve al contenedor viejo.")} >&2`,
    `${e("rm", "-f", name)} >/dev/null 2>&1`,
    `${e("rename", old, name)}`,
  );
  if (wasRunning) lines.push(`${e("start", name)} >/dev/null`);
  lines.push("exit 1");
  return lines.join("\n");
}

// ───────── Después ─────────

/** Clave del informe para la imagen nueva (como la pone el motor). */
export function imageKey(engine: Engine, user: string | null, id: string): string {
  return `image:${engine}:${user ?? ""}:${id.replace(/^sha256:/, "").slice(0, 12)}`;
}

/** Mensaje tras volver a analizar. `n` = vulnerabilidades (sin las «sin importancia») de la imagen nueva. */
export function rescanMessage(n: number): string {
  if (n === 0) return "La imagen nueva no tiene vulnerabilidades conocidas.";
  return `La imagen nueva todavía tiene ${n} ${n === 1 ? "vulnerabilidad" : "vulnerabilidades"}: el autor aún no la ha actualizado o la etiqueta es vieja (prueba una más nueva).`;
}
