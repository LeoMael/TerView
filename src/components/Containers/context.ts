// Contexto compartido por las sub-pestañas del administrador de contenedores.
import { createContext, useContext, type ReactNode } from "react";
import type {
  Cmd,
  ComposeTool,
  Container,
  CtOwner,
  ContainerStats,
  DetectResult,
  DfRow,
  Engine,
  EngineRun,
  EngineStatus,
  ImageInfo,
  NetworkInfo,
  RunForm,
  VolumeInfo,
} from "../../features/containers";
import type { Elevation } from "../../features/privileges";

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Unix ms de la última carga correcta. */
  loadedAt: number;
}

export type ResourceKind = "containers" | "images" | "volumes" | "networks" | "df";

export interface ResourceMap {
  containers: Resource<Container[]>;
  images: Resource<ImageInfo[]>;
  volumes: Resource<VolumeInfo[]>;
  networks: Resource<NetworkInfo[]>;
  df: Resource<DfRow[]>;
}

export interface ReviewOption {
  key: string;
  label: ReactNode;
  hint?: string;
  initial?: boolean;
}

export interface ReviewRequest {
  title: string;
  message?: ReactNode;
  /** Lista de lo afectado (o cualquier contenido), según las opciones marcadas. */
  details?: (opts: Record<string, boolean>) => ReactNode;
  options?: ReviewOption[];
  build: (opts: Record<string, boolean>) => Cmd[];
  danger?: boolean;
  /** Hay que escribir esta palabra para habilitar «Ejecutar». */
  confirmWord?: string;
  runLabel?: string;
  timeoutSecs?: number;
  /** Aviso al terminar bien (si devuelve texto, se usa como detalle). */
  success: string | ((r: EngineRun) => string);
  /** Recursos que se recargan al terminar. */
  reload?: ResourceKind[];
  /** Elevación distinta de la del motor (p. ej. systemctl siempre como root). */
  elevationOverride?: Elevation | null;
  onDone?: (r: EngineRun) => void;
}

export interface LogsTarget {
  title: string;
  /** Comando de lectura (últimas N líneas). */
  build: (tail: number, timestamps: boolean) => Cmd;
  /** Comando para seguir en la terminal. */
  follow: (tail: number) => Cmd;
}

export interface CtContextValue {
  sessionId: string;
  profileId: string;
  disabled: boolean;
  active: boolean;
  engine: Engine;
  status: EngineStatus;
  detect: DetectResult;
  composeTools: ComposeTool[];
  /** null = hace falta sudo y no hay forma de elevar todavía. */
  elevation: Elevation | null;
  needsSudo: boolean;
  /** «sudo » / «doas » / "" para mostrar comandos. */
  prefix: string;
  res: ResourceMap;
  stats: ContainerStats[];
  reload: (...kinds: ResourceKind[]) => Promise<void>;
  /**
   * Ejecuta comandos, cada uno como su dueño (`Cmd.owner`; sin él, el usuario elegido arriba), con la
   * elevación que toque. Pide sudo si hace falta.
   */
  run: (cmds: Cmd[], timeoutSecs?: number) => Promise<EngineRun>;
  /** Script libre (ya citado) como ese dueño, por ejemplo para comprobar una carpeta. */
  runRawAs: (owner: string | undefined, script: string, timeoutSecs?: number) => Promise<EngineRun>;
  review: (req: ReviewRequest) => void;
  askSudo: () => void;
  openLogs: (t: LogsTarget) => void;
  openInspect: (c: Container) => void;
  /** `owner`: con qué usuario se crea (sin él, el elegido arriba). */
  openRunForm: (prefill?: Partial<RunForm>, owner?: string) => void;
  /** Escribe el comando en la terminal de la sesión (con «sudo » o como el dueño, si aplica). */
  toTerminal: (cmd: Cmd, execute: boolean) => boolean;
  /** Muestra el comando antes de ejecutarlo (Ajustes de la pestaña). */
  render: (cmd: Cmd) => string;

  // ───────── Usuarios (con root o sudo) ─────────
  /** Dueños que se están viendo (uno, o varios con «Todos»). */
  owners: CtOwner[];
  /** «Todos»: las listas mezclan usuarios y llevan la columna «Usuario». */
  allOwners: boolean;
  /** Dueño con el que se crean cosas nuevas (null con «Todos»: hay que elegir uno arriba). */
  newOwner: string | null;
  /** Nombre del dueño para mostrar. */
  ownerLabel: (owner: string | undefined) => string;
  /** El dueño es root (puertos bajos, linger…). */
  ownerIsRoot: (owner: string | undefined) => boolean;
  /** Un comando por dueño de los elementos (acciones en lote). */
  perOwner: <T extends { owner?: string }>(items: T[], build: (items: T[]) => Cmd) => Cmd[];
}

/** Aviso de los botones de crear y limpiar con «Todos». */
export const PICK_OWNER_HINT = "Con «Todos», elige arriba el usuario con el que hacerlo";

export const CtContext = createContext<CtContextValue | null>(null);

export function useCt(): CtContextValue {
  const v = useContext(CtContext);
  if (!v) throw new Error("useCt fuera de ContainersPanel");
  return v;
}
