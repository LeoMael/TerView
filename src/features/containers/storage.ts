// Preferencias locales por servidor (motor elegido, modo de Podman, carpetas de Compose usadas).
// localStorage puede fallar (modo privado, cuota): todo va con try/catch y valores por defecto.
import type { Engine } from "./types";

const PREFIX = "terview.containers";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${PREFIX}.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}.${key}`, JSON.stringify(value));
  } catch {
    // sin almacenamiento: no pasa nada
  }
}

export function loadEngine(profileId: string): Engine | null {
  const v = read<string | null>(`engine.${profileId}`, null);
  return v === "podman" || v === "docker" ? v : null;
}

export function saveEngine(profileId: string, engine: Engine): void {
  write(`engine.${profileId}`, engine);
}

/** Podman como root (sudo) en vez de rootless. */
export function loadPodmanRoot(profileId: string): boolean {
  return read<boolean>(`podmanRoot.${profileId}`, false) === true;
}

export function savePodmanRoot(profileId: string, v: boolean): void {
  write(`podmanRoot.${profileId}`, v);
}

export interface ComposeFolder {
  dir: string;
  file: string;
  /** Unix ms del último uso. */
  usedAt: number;
}

const MAX_FOLDERS = 20;

export function loadComposeFolders(profileId: string): ComposeFolder[] {
  const v = read<unknown>(`compose.${profileId}`, []);
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is ComposeFolder => typeof x === "object" && x !== null && typeof (x as ComposeFolder).dir === "string" && typeof (x as ComposeFolder).file === "string")
    .slice(0, MAX_FOLDERS);
}

export function rememberComposeFolder(profileId: string, dir: string, file: string): ComposeFolder[] {
  const list = loadComposeFolders(profileId).filter((f) => f.dir !== dir);
  const next = [{ dir, file, usedAt: Date.now() }, ...list].slice(0, MAX_FOLDERS);
  write(`compose.${profileId}`, next);
  return next;
}

export function forgetComposeFolder(profileId: string, dir: string): ComposeFolder[] {
  const next = loadComposeFolders(profileId).filter((f) => f.dir !== dir);
  write(`compose.${profileId}`, next);
  return next;
}
