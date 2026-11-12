// Escáner de vulnerabilidades: tipos y comandos del motor (`src-tauri/src/vulnscan/`).
// Los scripts se piden al motor y se ejecutan en el servidor con `runScript` (con o sin sudo); sus
// salidas vuelven al motor con `analyze`, que consulta OSV, junta las fuentes y guarda el historial.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call } from "./core";

export type DistroTool = "dnf4" | "dnf5" | "yum" | "debsecan" | "pro" | "zypper";
export type Engine = "podman" | "docker";
export type Severity = "critical" | "high" | "medium" | "low" | "unknown";
export type SourceId = "osv" | "distro" | "trivy";
export type TargetKind = "system" | "runtime" | "image";
export type NoteLevel = "info" | "warn" | "error";
export type PackageManager = "dpkg" | "rpm" | "apk" | "none";

/** Salida de un comando del servidor. */
export interface RawOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/** Usuario dueño de un almacén de contenedores (para entrar como él). */
export interface UserCtx {
  name: string;
  uid: number;
  home: string;
}

export interface ImageRaw {
  engine: Engine | null;
  /** Dueño (null = el usuario conectado, o root sin elegir usuario). */
  user: string | null;
  /** Salida del listado de imágenes (una vez por motor y usuario). */
  listing: string | null;
  /** "" si este elemento solo lleva el listado. */
  imageId: string;
  output: RawOutput | null;
  error: string | null;
}

export interface ScanNote {
  phase: string;
  level: NoteLevel;
  text: string;
}

/** Todo lo recogido del servidor para un análisis. */
export interface ScanInput {
  serverId: string;
  detect: RawOutput;
  inventory: RawOutput;
  distroTool: DistroTool | null;
  distroOutput: RawOutput | null;
  images: ImageRaw[];
  elevated: boolean;
  useOsv: boolean;
  notes: ScanNote[];
  serverMs: number;
}

export type ScriptRequest =
  | { kind: "detect" }
  | { kind: "users" }
  | { kind: "inventory" }
  | { kind: "distro"; tool: DistroTool; codename: string | null }
  | { kind: "images"; engine: Engine; user: UserCtx | null }
  | { kind: "image"; engine: Engine; user: UserCtx | null; imageId: string; trivy: boolean };

/** Qué hacer tras la fase 1. */
export interface ScanPlan {
  os: string;
  ecosystem: string | null;
  distroTool: DistroTool | null;
  codename: string;
  trivy: string | null;
  podman: boolean;
  docker: boolean;
  user: string;
  isRoot: boolean;
  inContainer: boolean;
  complete: boolean;
}

export interface StoreUser {
  name: string;
  uid: number;
  home: string;
  podman: boolean;
  docker: boolean;
  runtimeDir: boolean;
}

export interface UsersView {
  users: StoreUser[];
  rootPodman: boolean;
  rootDocker: boolean;
}

export interface ContainerRef {
  id: string;
  name: string;
  state: string;
}

export interface ImageInfo {
  engine: Engine | null;
  /** Id corto (12). */
  id: string;
  tags: string[];
  containers: ContainerRef[];
  os: string | null;
  method: string | null;
}

export interface ImagesView {
  /** Las que se van a leer, en orden (con contenedores primero), ya recortadas al límite. */
  selected: ImageInfo[];
  /** Todas las del listado. */
  total: number;
  error: string | null;
}

export interface OsRelease {
  id: string;
  idLike: string[];
  versionId: string;
  version: string;
  versionCodename: string;
  prettyName: string;
  name: string;
}

export interface HostInfo {
  os: OsRelease;
  kernel: string;
  arch: string;
  packageManager: PackageManager | null;
  ecosystem: string | null;
  inContainer: boolean;
  tools: string[];
}

export interface SourceInfo {
  id: SourceId;
  label: string;
  used: boolean;
  note: string | null;
}

export interface Target {
  /** "system", "runtime" o "image:<motor>:<usuario>:<id>". */
  key: string;
  kind: TargetKind;
  label: string;
  user: string | null;
  ecosystem: string | null;
  packages: number;
  image: ImageInfo | null;
  sources: SourceId[];
  error: string | null;
}

export interface ProgramInfo {
  name: string;
  path: string;
  version: string | null;
  owner: string | null;
  thirdParty: boolean;
  upstreamEcosystem: string | null;
}

export interface Finding {
  /** `<id>|<paquete>|<objetivo>`: única en el informe. */
  key: string;
  /** CVE-… o, si no hay CVE, el aviso (DSA-…, FEDORA-…). */
  id: string;
  aliases: string[];
  /** Avisos de la distro que lo arreglan (DSA-…, RLSA-…, FEDORA-…, USN-…). */
  advisories: string[];
  /** Paquete fuente (o el programa en los sueltos). */
  package: string;
  /** Paquetes binarios instalados de ese paquete fuente. */
  binaries: string[];
  installed: string;
  fixed: string | null;
  hasFix: boolean;
  severity: Severity;
  /** Gravedad según la distro, texto original («Important», «low», «unimportant»). */
  distroSeverity: string | null;
  cvss: number | null;
  cvssVector: string | null;
  /** Debian lo marca «unimportant»: oculto por defecto. */
  unimportant: boolean;
  status: string | null;
  summary: string | null;
  /** Clave del objetivo (`Target.key`). */
  target: string;
  sources: SourceId[];
  kernel: boolean;
  ecosystem: string | null;
  /** Programa sin paquete de la distro (resultado aproximado por versión de origen). */
  upstream: boolean;
}

export interface Summary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
  withFix: number;
  unimportant: number;
}

export interface AiExplanation {
  model: string;
  createdAt: string;
  text: string;
}

export interface OsvQueryView {
  ecosystem: string;
  name: string;
  version: string;
}

export interface Report {
  id: string;
  serverId: string;
  createdAt: string;
  durationMs: number;
  elevated: boolean;
  host: HostInfo;
  sources: SourceInfo[];
  targets: Target[];
  programs: ProgramInfo[];
  findings: Finding[];
  summary: Summary;
  notes: ScanNote[];
  ai: AiExplanation | null;
  /** Lo que se mandó a OSV (solo ecosistema, nombre y versión). */
  osvSample: OsvQueryView[];
}

export interface ReportMeta {
  id: string;
  createdAt: string;
  durationMs: number;
  elevated: boolean;
  summary: Summary;
  sources: string[];
  distro: string;
  hasAi: boolean;
}

export interface VulnDetail {
  id: string;
  summary: string | null;
  details: string | null;
  aliases: string[];
  published: string | null;
  modified: string | null;
  references: string[];
}

export interface ProgressPayload {
  scanId: string;
  phase: string;
  done: number;
  total: number;
  text: string;
}

/** Ajustes del escáner (campo `vulnscan` de `settings.json`). */
export interface VulnScanSettings {
  useOsv: boolean;
  useDistroTool: boolean;
  useTrivy: boolean;
  scanImages: boolean;
  imageLimit: number;
  /** Usuarios elegidos por servidor (con sudo). Vacío o ausente = todos. */
  usersByServer: Record<string, string[]>;
}

/** Ajustes del asistente de IA (campo `ai`). El token NO va aquí: está en la bóveda o el llavero. */
export interface AiSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
}

export const DEFAULT_VULNSCAN_SETTINGS: VulnScanSettings = {
  useOsv: true,
  useDistroTool: true,
  useTrivy: true,
  scanImages: true,
  imageLimit: 50,
  usersByServer: {},
};

export const DEFAULT_AI_SETTINGS: AiSettings = { enabled: false, baseUrl: "", model: "" };

export const vulnscan = {
  /** Script de una fase (texto para `runScript`). */
  script: (req: ScriptRequest) => call<string>("vulnscan_script", { req }),
  /** Qué hacer tras la fase 1 (herramienta de la distro, motores de contenedores…). */
  plan: (detect: string) => call<ScanPlan>("vulnscan_plan", { detect }),
  parseUsers: (output: string) => call<UsersView>("vulnscan_parse_users", { output }),
  parseImages: (engine: Engine, output: string, limit: number) =>
    call<ImagesView>("vulnscan_parse_images", { engine, output, limit }),
  /** Fases 5 y 6: OSV, juntar y guardar en el historial. Progreso por `onProgress`. */
  analyze: (input: ScanInput, scanId: string) => call<Report>("vulnscan_analyze", { input, scanId }),
  /** Corta las peticiones a OSV de un análisis. */
  cancel: (scanId: string) => call<boolean>("vulnscan_cancel", { scanId }),
  historyList: (serverId: string) => call<ReportMeta[]>("vulnscan_history_list", { serverId }),
  historyGet: (serverId: string, reportId: string) => call<Report>("vulnscan_history_get", { serverId, reportId }),
  latest: (serverId: string) => call<Report | null>("vulnscan_latest", { serverId }),
  /** Sin `reportId`: borra todo el historial del servidor. */
  historyDelete: (serverId: string, reportId?: string) =>
    call<void>("vulnscan_history_delete", { serverId, reportId: reportId ?? null }),
  setAi: (serverId: string, reportId: string, ai: AiExplanation | null) =>
    call<Report>("vulnscan_set_ai", { serverId, reportId, ai }),
  /** `serverName` null = no ponerlo (sale «servidor-1»). */
  export: (serverId: string, reportId: string, path: string, format: "json" | "markdown", serverName: string | null) =>
    call<void>("vulnscan_export", { serverId, reportId, path, format, serverName }),
  /** Descripción completa y enlaces (caché de OSV o la API). */
  detail: (id: string) => call<VulnDetail>("vulnscan_vuln_detail", { id }),
  onProgress: (cb: (p: ProgressPayload) => void): Promise<UnlistenFn> =>
    listen<ProgressPayload>("vulnscan://progress", (e) => cb(e.payload)),
};

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiStatus {
  hasToken: boolean;
  /** Bóveda bloqueada: no se puede leer el token. */
  locked: boolean;
}

export const ai = {
  status: () => call<AiStatus>("ai_status"),
  /** null o "" borra el token. */
  setToken: (token: string | null) => call<void>("ai_set_token", { token }),
  /** `GET <base>/models` con los ajustes GUARDADOS. Devuelve los modelos. */
  test: () => call<string[]>("ai_test"),
  /** Envía exactamente estos mensajes con los ajustes guardados. */
  chat: (messages: ChatMessage[], requestId: string) =>
    call<{ model: string; text: string }>("ai_chat", { messages, requestId }),
  cancel: (requestId: string) => call<boolean>("ai_cancel", { requestId }),
};
