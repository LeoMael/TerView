// Preferencias locales por servidor (motor elegido, de qué usuario se ven, carpetas de Compose usadas).
// localStorage puede fallar (modo privado, cuota): todo va con try/catch y valores por defecto.
import type { Engine } from "./types";

const PREFIX = "sshorus.containers";

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

/**
 * De quién se ven los contenedores (selector «Usuario»): "self", "root", "u:<usuario>" o "all" (Todos).
 * Antes solo había «Mi usuario / Sistema (root)» (`podmanRoot`): se respeta esa elección.
 */
export function loadOwnerChoice(profileId: string): string {
  const v = read<unknown>(`owner.${profileId}`, null);
  if (typeof v === "string" && /^(self|root|all|u:[A-Za-z0-9_.][A-Za-z0-9_.-]{0,31})$/.test(v)) return v;
  return read<boolean>(`podmanRoot.${profileId}`, false) === true ? "root" : "self";
}

export function saveOwnerChoice(profileId: string, v: string): void {
  write(`owner.${profileId}`, v);
}

export interface ComposeFolder {
  dir: string;
  file: string;
  /** Usuario con el que se usa (clave de `owner.ts`); sin él, el conectado. */
  owner?: string;
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

export function rememberComposeFolder(profileId: string, dir: string, file: string, owner?: string): ComposeFolder[] {
  const list = loadComposeFolders(profileId).filter((f) => f.dir !== dir);
  const item: ComposeFolder = { dir, file, usedAt: Date.now(), ...(owner && owner !== "self" ? { owner } : {}) };
  const next = [item, ...list].slice(0, MAX_FOLDERS);
  write(`compose.${profileId}`, next);
  return next;
}

export function forgetComposeFolder(profileId: string, dir: string): ComposeFolder[] {
  const next = loadComposeFolders(profileId).filter((f) => f.dir !== dir);
  write(`compose.${profileId}`, next);
  return next;
}
