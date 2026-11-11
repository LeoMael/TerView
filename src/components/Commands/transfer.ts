// Importar / exportar "Mis comandos" en JSON.
// Exportar copia el JSON al portapapeles (no hay plugin de archivos en la app); importar acepta un
// archivo elegido con el selector del sistema o el JSON pegado del portapapeles.
import type { Snippet, SnippetScope } from "../../api/types";
import { clipboard } from "../../lib/clipboard";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { useSnippets } from "./state";

interface ExportFile {
  app: "TerView";
  version: 1;
  commands: Omit<Snippet, "id">[];
}

export async function exportSnippets(list: Snippet[]) {
  const file: ExportFile = {
    app: "TerView",
    version: 1,
    commands: list.map(({ id: _id, ...rest }) => rest),
  };
  try {
    await clipboard.write(JSON.stringify(file, null, 2));
    toast.success(
      `${list.length} comando${list.length === 1 ? "" : "s"} copiado${list.length === 1 ? "" : "s"} como JSON`,
      "Pégalo en un archivo .json para compartirlo con tu equipo.",
    );
  } catch (e) {
    toast.error("No se pudo copiar al portapapeles", e);
  }
}

const SCOPES: SnippetScope[] = ["global", "project", "server"];

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Convierte un objeto importado en Snippet nuevo (id ""), o null si no es válido. */
function toSnippet(raw: unknown, known: { projects: Set<string>; servers: Set<string> }): Snippet | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name)?.trim();
  const command = str(o.command)?.trim();
  if (!name || !command) return null;
  let scope: SnippetScope = SCOPES.includes(o.scope as SnippetScope) ? (o.scope as SnippetScope) : "global";
  let scopeId = str(o.scopeId);
  // Proyectos/servidores de otra máquina no existen aquí: pasan a globales.
  if (scope === "project" && !(scopeId && known.projects.has(scopeId))) scope = "global";
  if (scope === "server" && !(scopeId && known.servers.has(scopeId))) scope = "global";
  if (scope === "global") scopeId = null;
  return {
    id: "",
    name,
    command,
    description: str(o.description),
    category: str(o.category)?.trim() || "Mis comandos",
    scope,
    scopeId,
    dangerous: o.dangerous === true,
    sudo: o.sudo === true,
    readOnly: o.readOnly === true,
  };
}

export async function importSnippetsFromText(text: string) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("El contenido no es un JSON válido.");
  }
  const arr: unknown[] | null = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { commands?: unknown }).commands)
      ? (data as { commands: unknown[] }).commands
      : null;
  if (!arr) throw new Error("No se encontró una lista de comandos (se espera { \"commands\": [...] }).");

  const { projects, servers } = useProfiles.getState();
  const known = { projects: new Set(projects.map((p) => p.id)), servers: new Set(servers.map((s) => s.id)) };
  const existing = useSnippets.getState().list;
  const sameKey = (s: Pick<Snippet, "name" | "command">) => `${s.name}\u0000${s.command}`;
  const have = new Set(existing.map(sameKey));

  let added = 0;
  let skipped = 0;
  let invalid = 0;
  for (const raw of arr) {
    const s = toSnippet(raw, known);
    if (!s) {
      invalid++;
      continue;
    }
    if (have.has(sameKey(s))) {
      skipped++;
      continue;
    }
    const saved = await useSnippets.getState().save(s);
    if (saved) {
      have.add(sameKey(saved));
      added++;
    } else invalid++;
  }
  const extra = [skipped && `${skipped} ya existían`, invalid && `${invalid} no válidos`].filter(Boolean).join(" · ");
  if (added) toast.success(`Importados ${added} comando${added === 1 ? "" : "s"}`, extra || undefined);
  else toast.info("No se importó ningún comando", extra || undefined);
}
