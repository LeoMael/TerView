// Importar / exportar "Mis comandos" en JSON.
// Exportar: a un archivo (diálogo «Guardar» del sistema) o al portapapeles.
// Importar: desde un archivo (diálogo «Abrir») o el JSON pegado del portapapeles. Antes de guardar
// nada se calcula un plan (qué se añade, qué se actualiza, qué se omite) para mostrarlo en la vista previa.
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { localfs } from "../../api/localfs";
import type { Snippet, SnippetScope } from "../../api/types";
import { clipboard } from "../../lib/clipboard";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { useSnippets } from "./state";

export const EXPORT_FILE_NAME = "terview-comandos.json";
const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

interface ExportFile {
  app: "TerView";
  version: 1;
  commands: Omit<Snippet, "id">[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function snippetsToJson(list: Snippet[]): string {
  const file: ExportFile = {
    app: "TerView",
    version: 1,
    commands: list.map(({ id: _id, ...rest }) => rest),
  };
  return JSON.stringify(file, null, 2);
}

/** Copia todos los comandos como JSON al portapapeles. */
export async function exportSnippets(list: Snippet[]) {
  try {
    await clipboard.write(snippetsToJson(list));
    toast.success(
      `${list.length} ${plural(list.length, "comando copiado", "comandos copiados")} como JSON`,
      "Pégalo en un archivo .json para compartirlo con tu equipo.",
    );
  } catch (e) {
    toast.error("No se pudo copiar al portapapeles", e);
  }
}

/** Guarda todos los comandos en un archivo .json elegido con el diálogo del sistema. */
export async function exportSnippetsToFile(list: Snippet[]) {
  let path: string | null;
  try {
    path = await saveFileDialog({ title: "Exportar Mis comandos", defaultPath: EXPORT_FILE_NAME, filters: JSON_FILTER });
  } catch (e) {
    toast.error("No se pudo abrir el diálogo para guardar", e);
    return;
  }
  if (!path) return;
  if (!/\.json$/i.test(path)) path += ".json";
  try {
    await localfs.writeText(path, snippetsToJson(list) + "\n");
    toast.success(`${list.length} ${plural(list.length, "comando exportado", "comandos exportados")}`, path);
  } catch (e) {
    toast.error("No se pudo guardar el archivo", e);
  }
}

/** Pide un archivo .json con el diálogo del sistema y devuelve su texto (null si se cancela). */
export async function pickImportFile(): Promise<{ path: string; text: string } | null> {
  const picked = await openFileDialog({
    title: "Importar Mis comandos",
    multiple: false,
    directory: false,
    filters: [...JSON_FILTER, { name: "Todos los archivos", extensions: ["*"] }],
  });
  if (typeof picked !== "string") return null;
  return { path: picked, text: await localfs.readText(picked) };
}

// ───────── Plan de importación ─────────

const SCOPES: SnippetScope[] = ["global", "project", "server"];

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Convierte un objeto importado en Snippet nuevo (id ""), o el motivo por el que no es válido. */
function toSnippet(raw: unknown, known: { projects: Set<string>; servers: Set<string> }): Snippet | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "no es un objeto";
  const o = raw as Record<string, unknown>;
  const name = str(o.name)?.trim();
  const command = str(o.command)?.trim();
  if (!name) return "le falta el nombre";
  if (!command) return `«${name}» no tiene comando`;
  if (name.length > 200) return `«${name.slice(0, 40)}…» tiene un nombre demasiado largo`;
  let scope: SnippetScope = SCOPES.includes(o.scope as SnippetScope) ? (o.scope as SnippetScope) : "global";
  let scopeId = str(o.scopeId);
  // Proyectos/servidores de otra máquina no existen aquí: pasan a globales.
  if (scope === "project" && !(scopeId && known.projects.has(scopeId))) scope = "global";
  if (scope === "server" && !(scopeId && known.servers.has(scopeId))) scope = "global";
  if (scope === "global") scopeId = null;
  const description = str(o.description)?.trim() || null;
  return {
    id: "",
    name,
    command,
    description,
    category: str(o.category)?.trim() || "Mis comandos",
    scope,
    scopeId,
    dangerous: o.dangerous === true,
    sudo: o.sudo === true,
    readOnly: o.readOnly === true,
  };
}

export interface ImportPlan {
  /** Comandos nuevos. */
  add: Snippet[];
  /** Comandos que ya existen (mismo nombre y ámbito) con cambios: llevan el id del existente. */
  update: { before: Snippet; after: Snippet }[];
  /** Ya existen exactamente iguales (o repetidos dentro del archivo). */
  skipped: number;
  /** Entradas no válidas, con el motivo (como mucho unas pocas). */
  invalid: string[];
  invalidCount: number;
  /** Número total de entradas del archivo. */
  total: number;
}

const nameKey = (s: Pick<Snippet, "name" | "scope" | "scopeId">) =>
  `${s.name.trim().toLowerCase()}\u0000${s.scope}\u0000${s.scopeId ?? ""}`;
const sameCmdKey = (s: Pick<Snippet, "name" | "command">) => `${s.name.trim().toLowerCase()}\u0000${s.command.trim()}`;

function sameContent(a: Snippet, b: Snippet): boolean {
  return (
    a.command.trim() === b.command.trim() &&
    (a.description ?? "") === (b.description ?? "") &&
    a.category === b.category &&
    a.dangerous === b.dangerous &&
    a.sudo === b.sudo &&
    a.readOnly === b.readOnly
  );
}

/** Lee el JSON y decide qué haría la importación, sin guardar nada. Lanza Error si no es válido. */
export function planImport(text: string): ImportPlan {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error("El contenido no es un JSON válido.");
  }
  const arr: unknown[] | null = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { commands?: unknown }).commands)
      ? (data as { commands: unknown[] }).commands
      : null;
  if (!arr) throw new Error('No se encontró una lista de comandos (se espera { "commands": [...] }).');
  const version = data && typeof data === "object" && !Array.isArray(data) ? (data as { version?: unknown }).version : 1;
  if (typeof version === "number" && version > 1) {
    throw new Error("El archivo es de una versión más nueva de TerView. Actualiza la aplicación para importarlo.");
  }

  const { projects, servers } = useProfiles.getState();
  const known = { projects: new Set(projects.map((p) => p.id)), servers: new Set(servers.map((s) => s.id)) };
  const existing = useSnippets.getState().list;
  const byName = new Map(existing.map((s) => [nameKey(s), s]));
  const sameCmd = new Set(existing.map(sameCmdKey));
  const seen = new Set<string>();

  const plan: ImportPlan = { add: [], update: [], skipped: 0, invalid: [], invalidCount: 0, total: arr.length };
  for (const raw of arr) {
    const s = toSnippet(raw, known);
    if (typeof s === "string") {
      plan.invalidCount++;
      if (plan.invalid.length < 5) plan.invalid.push(s);
      continue;
    }
    const key = nameKey(s);
    if (seen.has(key)) {
      plan.skipped++; // repetido dentro del propio archivo
      continue;
    }
    seen.add(key);
    const before = byName.get(key);
    if (before) {
      if (sameContent(before, s)) plan.skipped++;
      else plan.update.push({ before, after: { ...s, id: before.id } });
    } else if (sameCmd.has(sameCmdKey(s))) {
      plan.skipped++; // mismo nombre y comando en otro ámbito
    } else {
      plan.add.push(s);
    }
  }
  return plan;
}

/** Guarda el plan. `withUpdates` = false deja los existentes como están. */
export async function applyImport(plan: ImportPlan, withUpdates: boolean) {
  const save = useSnippets.getState().save;
  let added = 0;
  let updated = 0;
  let failed = 0;
  for (const s of plan.add) {
    if (await save(s)) added++;
    else failed++;
  }
  if (withUpdates) {
    for (const u of plan.update) {
      if (await save(u.after)) updated++;
      else failed++;
    }
  }
  const skipped = plan.skipped + (withUpdates ? 0 : plan.update.length);
  const extra = [
    skipped && `${skipped} ${plural(skipped, "omitido", "omitidos")}`,
    plan.invalidCount && `${plan.invalidCount} no ${plural(plan.invalidCount, "válido", "válidos")}`,
    failed && `${failed} con error`,
  ]
    .filter(Boolean)
    .join(" · ");
  const parts = [
    added && `${added} ${plural(added, "añadido", "añadidos")}`,
    updated && `${updated} ${plural(updated, "actualizado", "actualizados")}`,
  ].filter(Boolean);
  if (parts.length) toast.success(`Comandos: ${parts.join(", ")}`, extra || undefined);
  else toast.info("No se importó ningún comando", extra || undefined);
}
