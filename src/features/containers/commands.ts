// Comandos del motor (Podman / Docker) y del formulario «Nuevo contenedor». Funciones puras.
import { generatePassword } from "../admin/shell";
import { composeBin, engineCmd, splitArgs, type Cmd } from "./shell";
import type { ComposeTool, Engine } from "./types";

/** Formato JSON de listados: Podman da un array, Docker una línea por elemento. */
function jsonFmt(engine: Engine): string[] {
  return engine === "podman" ? ["--format", "json"] : ["--format", "{{json .}}"];
}

export const listContainers = (e: Engine): Cmd =>
  engineCmd(e, "ps", "-a", ...(e === "docker" ? ["--no-trunc"] : []), ...jsonFmt(e));
export const listImages = (e: Engine): Cmd => engineCmd(e, "images", ...(e === "docker" ? ["--no-trunc"] : []), ...jsonFmt(e));
export const listVolumes = (e: Engine): Cmd => engineCmd(e, "volume", "ls", ...jsonFmt(e));
export const listUnusedVolumes = (e: Engine): Cmd => engineCmd(e, "volume", "ls", "-q", "--filter", "dangling=true");
export const listNetworks = (e: Engine): Cmd => engineCmd(e, "network", "ls", ...jsonFmt(e));
export const systemDf = (e: Engine): Cmd => engineCmd(e, "system", "df", ...jsonFmt(e));
export const statsOnce = (e: Engine): Cmd => engineCmd(e, "stats", "--no-stream", ...jsonFmt(e));
export const inspect = (e: Engine, id: string): Cmd => engineCmd(e, "inspect", id);

export type ContainerAction = "start" | "stop" | "restart" | "pause" | "unpause";

export const containerAction = (e: Engine, action: ContainerAction, ids: string[]): Cmd => engineCmd(e, action, ...ids);

export const removeContainers = (e: Engine, ids: string[], opts: { force: boolean; volumes: boolean }): Cmd =>
  engineCmd(e, "rm", ...(opts.force ? ["-f"] : []), ...(opts.volumes ? ["-v"] : []), ...ids);

export const renameContainer = (e: Engine, id: string, name: string): Cmd => engineCmd(e, "rename", id, name);

export function logsCmd(e: Engine, id: string, tail: number, opts: { timestamps?: boolean; follow?: boolean } = {}): Cmd {
  return {
    ...engineCmd(e, "logs", "--tail", String(tail), ...(opts.timestamps ? ["-t"] : []), ...(opts.follow ? ["-f"] : []), id),
    mergeStderr: !opts.follow,
  };
}

/** Shell interactiva dentro del contenedor: bash si existe, si no sh. */
export function execShellCmd(e: Engine, id: string): Cmd {
  return engineCmd(e, "exec", "-it", id, "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh");
}

export const pullImage = (e: Engine, ref: string): Cmd => engineCmd(e, "pull", ref);
export const removeImages = (e: Engine, ids: string[], force: boolean): Cmd => engineCmd(e, "rmi", ...(force ? ["-f"] : []), ...ids);
export const pruneImages = (e: Engine, all: boolean): Cmd => engineCmd(e, "image", "prune", "-f", ...(all ? ["-a"] : []));
export const pruneContainers = (e: Engine): Cmd => engineCmd(e, "container", "prune", "-f");

export const createVolume = (e: Engine, name: string): Cmd => engineCmd(e, "volume", "create", name);
export const removeVolumes = (e: Engine, names: string[], force = false): Cmd => engineCmd(e, "volume", "rm", ...(force ? ["-f"] : []), ...names);
/** Docker 23+ solo borra volúmenes anónimos salvo con `-a`; Podman borra todos los que no se usan. */
export const pruneVolumes = (e: Engine, all: boolean): Cmd => engineCmd(e, "volume", "prune", "-f", ...(e === "docker" && all ? ["-a"] : []));

export const createNetwork = (e: Engine, name: string): Cmd => engineCmd(e, "network", "create", name);
export const removeNetworks = (e: Engine, names: string[]): Cmd => engineCmd(e, "network", "rm", ...names);
export const pruneNetworks = (e: Engine): Cmd => engineCmd(e, "network", "prune", "-f");

export const systemPrune = (e: Engine, opts: { all: boolean; volumes: boolean }): Cmd =>
  engineCmd(e, "system", "prune", "-f", ...(opts.all ? ["-a"] : []), ...(opts.volumes ? ["--volumes"] : []));

// ───────── Compose ─────────

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export type ComposeAction = "up" | "down" | "restart" | "pull" | "logs" | "services" | "ps" | "stop" | "start";

export function composeCmd(tool: ComposeTool, dir: string, file: string, action: ComposeAction, opts: { volumes?: boolean; tail?: number } = {}): Cmd {
  const base = file ? ["-f", file] : [];
  const args: Record<ComposeAction, string[]> = {
    up: ["up", "-d"],
    down: ["down", ...(opts.volumes ? ["-v"] : [])],
    restart: ["restart"],
    stop: ["stop"],
    start: ["start"],
    pull: ["pull"],
    logs: ["logs", "--no-color", "--tail", String(opts.tail ?? 200)],
    services: ["config", "--services"],
    ps: ["ps"],
  };
  return { bin: composeBin(tool), args: [...base, ...args[action]], cwd: dir, mergeStderr: action === "logs" };
}

/** Compose preferido para el motor (el primero disponible). */
export function composeFor(engine: Engine, tools: ComposeTool[]): ComposeTool | null {
  const pref: ComposeTool[] = engine === "podman" ? ["podman compose", "podman-compose"] : ["docker compose", "docker-compose"];
  return pref.find((t) => tools.includes(t)) ?? null;
}

// ───────── Nuevo contenedor ─────────

export type RestartPolicy = "no" | "always" | "unless-stopped" | "on-failure";

export const RESTART_LABELS: Record<RestartPolicy, string> = {
  no: "No reiniciar",
  always: "Siempre",
  "unless-stopped": "Siempre, salvo si lo paro yo",
  "on-failure": "Solo si falla",
};

export interface PortRow {
  host: string;
  container: string;
  protocol: "tcp" | "udp";
  /** Publicar solo en 127.0.0.1 (no accesible desde fuera del servidor). */
  localOnly: boolean;
}

export interface VolumeRow {
  /** Carpeta del servidor (ruta absoluta) o nombre de volumen. */
  source: string;
  target: string;
  readOnly: boolean;
}

export interface EnvRow {
  key: string;
  value: string;
}

export interface RunForm {
  image: string;
  name: string;
  ports: PortRow[];
  volumes: VolumeRow[];
  env: EnvRow[];
  restart: RestartPolicy;
  network: string;
  command: string;
  /** Podman + SELinux: añade «:Z» a las carpetas del servidor. */
  selinuxLabel: boolean;
}

export function emptyRunForm(): RunForm {
  return { image: "", name: "", ports: [], volumes: [], env: [], restart: "unless-stopped", network: "", command: "", selinuxLabel: false };
}

const PORT_RE = /^\d{1,5}(-\d{1,5})?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validPort(p: string): boolean {
  if (!PORT_RE.test(p)) return false;
  return p.split("-").every((x) => Number(x) >= 1 && Number(x) <= 65535);
}

/** Errores del formulario por campo (vacío = válido). */
export function validateRunForm(f: RunForm): Record<string, string> {
  const err: Record<string, string> = {};
  if (!f.image.trim()) err.image = "Elige o escribe una imagen";
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/.test(f.image.trim())) err.image = "La imagen no puede tener espacios ni caracteres especiales";
  if (f.name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.name)) err.name = "Solo letras, números, «_», «.» y «-»";
  f.ports.forEach((p, i) => {
    if (!p.host && !p.container) return;
    if (!validPort(p.container)) err[`port${i}`] = "Puerto del contenedor no válido (1-65535)";
    else if (p.host && !validPort(p.host)) err[`port${i}`] = "Puerto del servidor no válido (1-65535)";
  });
  f.volumes.forEach((v, i) => {
    if (!v.source && !v.target) return;
    if (!v.target.startsWith("/")) err[`vol${i}`] = "La ruta dentro del contenedor debe ser absoluta (/datos)";
    else if (!v.source) err[`vol${i}`] = "Escribe la carpeta del servidor o el nombre del volumen";
    else if (!v.source.startsWith("/") && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v.source))
      err[`vol${i}`] = "Usa una ruta absoluta (/srv/datos) o un nombre de volumen (datos_app)";
    else if (/[:,\n]/.test(v.source + v.target)) err[`vol${i}`] = "Las rutas no pueden contener «:» ni «,»";
  });
  f.env.forEach((e, i) => {
    if (!e.key && !e.value) return;
    if (!ENV_KEY_RE.test(e.key)) err[`env${i}`] = "Nombre de variable no válido (LETRAS_Y_NUMEROS)";
    else if (/[\n\r]/.test(e.value)) err[`env${i}`] = "El valor no puede tener saltos de línea";
  });
  if (f.network && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.network)) err.network = "Red no válida";
  if (f.command.trim() && splitArgs(f.command) === null) err.command = "Hay comillas sin cerrar";
  return err;
}

/** `run -d …` a partir del formulario (sin validar: llama antes a validateRunForm). */
export function runCmd(e: Engine, f: RunForm): Cmd {
  const args: string[] = ["run", "-d"];
  if (f.name.trim()) args.push("--name", f.name.trim());
  for (const p of f.ports) {
    if (!p.container) continue;
    const cont = `${p.container}${p.protocol === "udp" ? "/udp" : ""}`;
    const host = p.host ? `${p.localOnly ? "127.0.0.1:" : ""}${p.host}:` : p.localOnly ? "127.0.0.1::" : "";
    args.push("-p", `${host}${cont}`);
  }
  for (const v of f.volumes) {
    if (!v.source || !v.target) continue;
    const opts = [v.readOnly ? "ro" : "", e === "podman" && f.selinuxLabel && v.source.startsWith("/") ? "Z" : ""].filter(Boolean);
    args.push("-v", `${v.source}:${v.target}${opts.length ? `:${opts.join(",")}` : ""}`);
  }
  for (const env of f.env) {
    if (!env.key) continue;
    args.push("-e", `${env.key}=${env.value}`);
  }
  if (f.restart !== "no") args.push("--restart", f.restart);
  if (f.network) args.push("--network", f.network);
  args.push(f.image.trim());
  const extra = f.command.trim() ? (splitArgs(f.command) ?? []) : [];
  args.push(...extra);
  return engineCmd(e, ...args);
}

export interface Template {
  id: string;
  label: string;
  description: string;
  /** Solo para Docker (p. ej. Portainer necesita el socket de Docker). */
  dockerOnly?: boolean;
  build: () => RunForm;
}

function form(p: Partial<RunForm> & Pick<RunForm, "image" | "name">): RunForm {
  return { ...emptyRunForm(), ...p };
}

export const TEMPLATES: Template[] = [
  {
    id: "nginx",
    label: "Nginx",
    description: "Servidor web en el puerto 8080",
    build: () =>
      form({
        image: "docker.io/library/nginx:alpine",
        name: "nginx",
        ports: [{ host: "8080", container: "80", protocol: "tcp", localOnly: false }],
        volumes: [{ source: "", target: "/usr/share/nginx/html", readOnly: true }],
      }),
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    description: "Base de datos con contraseña generada y volumen de datos",
    build: () =>
      form({
        image: "docker.io/library/postgres:17",
        name: "postgres",
        ports: [{ host: "5432", container: "5432", protocol: "tcp", localOnly: true }],
        volumes: [{ source: "pgdata", target: "/var/lib/postgresql/data", readOnly: false }],
        env: [
          { key: "POSTGRES_USER", value: "app" },
          { key: "POSTGRES_PASSWORD", value: generatePassword(20) },
          { key: "POSTGRES_DB", value: "app" },
        ],
      }),
  },
  {
    id: "mysql",
    label: "MySQL",
    description: "MySQL 8.4 con contraseña de root generada",
    build: () =>
      form({
        image: "docker.io/library/mysql:8.4",
        name: "mysql",
        ports: [{ host: "3306", container: "3306", protocol: "tcp", localOnly: true }],
        volumes: [{ source: "mysqldata", target: "/var/lib/mysql", readOnly: false }],
        env: [
          { key: "MYSQL_ROOT_PASSWORD", value: generatePassword(20) },
          { key: "MYSQL_DATABASE", value: "app" },
        ],
      }),
  },
  {
    id: "mariadb",
    label: "MariaDB",
    description: "MariaDB 11 con contraseña de root generada",
    build: () =>
      form({
        image: "docker.io/library/mariadb:11",
        name: "mariadb",
        ports: [{ host: "3306", container: "3306", protocol: "tcp", localOnly: true }],
        volumes: [{ source: "mariadbdata", target: "/var/lib/mysql", readOnly: false }],
        env: [
          { key: "MARIADB_ROOT_PASSWORD", value: generatePassword(20) },
          { key: "MARIADB_DATABASE", value: "app" },
        ],
      }),
  },
  {
    id: "redis",
    label: "Redis",
    description: "Caché en memoria con datos persistentes",
    build: () =>
      form({
        image: "docker.io/library/redis:7-alpine",
        name: "redis",
        ports: [{ host: "6379", container: "6379", protocol: "tcp", localOnly: true }],
        volumes: [{ source: "redisdata", target: "/data", readOnly: false }],
        command: "redis-server --appendonly yes",
      }),
  },
  {
    id: "adminer",
    label: "Adminer",
    description: "Administrador web de bases de datos (puerto 8081)",
    build: () =>
      form({
        image: "docker.io/library/adminer:latest",
        name: "adminer",
        ports: [{ host: "8081", container: "8080", protocol: "tcp", localOnly: false }],
      }),
  },
  {
    id: "portainer",
    label: "Portainer",
    description: "Panel web para Docker (puerto 9443, HTTPS)",
    dockerOnly: true,
    build: () =>
      form({
        image: "docker.io/portainer/portainer-ce:latest",
        name: "portainer",
        ports: [{ host: "9443", container: "9443", protocol: "tcp", localOnly: false }],
        volumes: [
          { source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: false },
          { source: "portainer_data", target: "/data", readOnly: false },
        ],
        restart: "always",
      }),
  },
];
