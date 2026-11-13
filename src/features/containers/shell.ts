// Construcción de comandos del motor (funciones puras). El citado lo hace `shQuote` de Administración.
import { shQuote } from "../admin/shell";
import type { ComposeTool, Engine } from "./types";

/** Caracteres que no necesitan comillas en un shell POSIX. */
const SAFE_RE = /^[A-Za-z0-9_./:=@%+,-]+$/;

/**
 * Cita un argumento solo si hace falta (para que el comando mostrado sea legible).
 * Lo que no es "seguro" se cita siempre con `shQuote` (comillas simples POSIX).
 */
export function q(arg: string): string {
  return arg !== "" && SAFE_RE.test(arg) ? arg : shQuote(arg);
}

/** Un comando del motor: programa (sin citar, fijo) + argumentos (se citan). */
export interface Cmd {
  /** Tokens fijos del programa: ["podman"], ["docker", "compose"], ["podman-compose"]… */
  bin: string[];
  args: string[];
  /** Carpeta donde se ejecuta (`cd` previo). */
  cwd?: string;
  /** Une stderr a stdout (logs). */
  mergeStderr?: boolean;
  /** Dueño (clave de `owner.ts`: "self", "root" o "u:<usuario>"). Sin él, el elegido arriba. */
  owner?: string;
}

export function engineCmd(engine: Engine, ...args: string[]): Cmd {
  return { bin: [engine], args };
}

export function composeBin(tool: ComposeTool): string[] {
  return tool.split(" ");
}

/** Texto del comando, tal cual se ejecuta (sin la elevación). */
export function renderCmd(c: Cmd): string {
  const main = [...c.bin, ...c.args.map(q)].join(" ") + (c.mergeStderr ? " 2>&1" : "");
  return c.cwd ? `cd ${q(c.cwd)} && ${main}` : main;
}

/** Prefijo visible de la elevación («sudo », «doas » o nada). */
export function displayPrefix(prefix: string, c: Cmd): string {
  if (!prefix) return renderCmd(c);
  const main = `${prefix}${[...c.bin, ...c.args.map(q)].join(" ")}${c.mergeStderr ? " 2>&1" : ""}`;
  return c.cwd ? `cd ${q(c.cwd)} && ${main}` : main;
}

/**
 * Parte un texto en argumentos como lo haría un shell sencillo: espacios separan; comillas simples y
 * dobles agrupan; la barra invertida escapa el siguiente carácter (fuera de comillas simples).
 * Devuelve null si hay comillas sin cerrar.
 */
export function splitArgs(s: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has) out.push(cur);
  return out;
}

/** Nombre de contenedor, volumen o red válido (mismas reglas que Docker/Podman). */
export const OBJ_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function validateObjName(name: string, what = "nombre"): string | null {
  if (!name) return `Escribe el ${what}`;
  if (name.length > 128) return "Máximo 128 caracteres";
  if (!OBJ_NAME_RE.test(name)) return "Solo letras, números, «_», «.» y «-»; debe empezar por letra o número";
  return null;
}

/** Referencia de imagen razonable (registro/ruta:etiqueta@digest), sin espacios ni caracteres de shell. */
export const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;

export function validateImage(ref: string): string | null {
  if (!ref.trim()) return "Escribe la imagen (p. ej. docker.io/library/nginx:alpine)";
  if (!IMAGE_RE.test(ref.trim())) return "La imagen no puede tener espacios ni caracteres especiales";
  return null;
}

/** Ruta absoluta en el servidor (o con ~). */
export function validateServerPath(p: string): string | null {
  if (!p.trim()) return "Escribe la carpeta";
  if (!p.startsWith("/") && !p.startsWith("~")) return "Usa una ruta absoluta (p. ej. /home/ana/proyecto)";
  if (/[\n\r]/.test(p)) return "La ruta no puede tener saltos de línea";
  return null;
}
