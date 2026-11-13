// Tipos comunes del administrador de contenedores (Podman y Docker normalizados al mismo formato).

export type Engine = "podman" | "docker";

/** Herramienta de Compose disponible en el servidor. */
export type ComposeTool = "docker compose" | "docker-compose" | "podman compose" | "podman-compose";

/** Estado normalizado de un contenedor. */
export type ContainerState = "running" | "paused" | "exited" | "created" | "restarting" | "removing" | "dead" | "unknown";

export interface PortMapping {
  /** "" = todas las interfaces. */
  hostIp: string;
  /** null = expuesto pero no publicado. */
  hostPort: number | null;
  containerPort: number;
  protocol: string;
  /** Rango (podman: `range`; docker: "8000-8002->8000-8002/tcp"). */
  range: number;
}

export interface Container {
  id: string;
  shortId: string;
  name: string;
  image: string;
  state: ContainerState;
  /** Texto original del motor («Up 2 hours», «Exited (0) 3 days ago»…). */
  status: string;
  exitCode: number | null;
  health: "healthy" | "unhealthy" | "starting" | null;
  /** Unix segundos (null si no se pudo leer). */
  created: number | null;
  ports: PortMapping[];
  labels: Record<string, string>;
  networks: string[];
  command: string;
  /** Proyecto de Compose (etiqueta com.docker.compose.project), si lo hay. */
  composeProject: string | null;
  composeService: string | null;
  composeWorkingDir: string | null;
  composeConfigFiles: string | null;
  pod: string | null;
  /** Dueño (clave de `owner.ts`), puesto al leer la lista. */
  owner?: string;
}

export interface ImageInfo {
  id: string;
  shortId: string;
  /** "repositorio:etiqueta" (o "<none>:<none>"). Una entrada por etiqueta. */
  tags: string[];
  repository: string;
  tag: string;
  size: number | null;
  created: number | null;
  /** Número de contenedores que la usan (null = el motor no lo dice). */
  containers: number | null;
  dangling: boolean;
  owner?: string;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  created: number | null;
  labels: Record<string, string>;
  anonymous: boolean;
  /** Sin contenedores que lo usen (filtro dangling=true). */
  unused: boolean;
  owner?: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  subnets: string[];
  internal: boolean;
  created: number | null;
  labels: Record<string, string>;
  /** Red integrada del motor (no se puede borrar). */
  builtin: boolean;
  owner?: string;
}

export interface DfRow {
  /** Images | Containers | Local Volumes | Build Cache */
  type: string;
  label: string;
  total: number | null;
  active: number | null;
  size: number | null;
  reclaimable: number | null;
  /** Texto original del espacio recuperable («10.01GB (58%)»). */
  reclaimableText: string;
}

export interface ContainerStats {
  id: string;
  name: string;
  cpuPercent: number | null;
  memUsage: number | null;
  memLimit: number | null;
  memPercent: number | null;
  owner?: string;
}

export interface InspectSummary {
  id: string;
  name: string;
  image: string;
  created: string;
  state: string;
  startedAt: string;
  restartPolicy: string;
  restartCount: number | null;
  command: string;
  workingDir: string;
  env: { key: string; value: string }[];
  mounts: { type: string; source: string; destination: string; rw: boolean; name: string }[];
  networks: { name: string; ip: string; gateway: string; mac: string }[];
  ports: { container: string; host: string }[];
  labels: Record<string, string>;
}
