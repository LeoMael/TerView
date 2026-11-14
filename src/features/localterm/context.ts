// Contexto de SSHorus para los asistentes de IA (Claude Code, Codex). Función pura, con pruebas.
//
// «La idea es solo dar contexto»: el asistente sabe qué servidores hay y cómo llegar a ellos, y
// trabaja como mejor sepa. Dos vías:
// - Directa: `ssh <alias> '<comando>'` con los alias que SSHorus escribe en ~/.ssh/config.
// - MCP de SSHorus: usa las conexiones de SSHorus (también las que van con contraseña), con permisos.
//
// NUNCA lleva contraseñas, llaves (ni su ruta), tokens ni el PIN: solo nombres, alias, usuario,
// host, puerto, proyecto y el método de acceso.
import type { AuthMethod, LocalAiMode, LocalAiSettings } from "../../api/types";
import type { McpAccess } from "../../api/mcp";

export interface ContextServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  /** Alias de ~/.ssh/config que lleva a este servidor (null = no exportado o desactualizado). */
  alias: string | null;
  /** Nombres de los proyectos en los que está. */
  projects: string[];
  /** Tiene una pestaña conectada ahora en SSHorus. */
  connected: boolean;
  /** Lo que se sabe de la conexión abierta (sin pedir nada al servidor). */
  privilege?: string | null;
  distro?: string | null;
  /** Acceso del asistente por el MCP. */
  mcpAccess: McpAccess;
}

export interface ContextProject {
  name: string;
  servers: string[];
}

export interface ContextInput {
  servers: ContextServer[];
  projects: ContextProject[];
  /** Pestaña de servidor que miraba el usuario al abrir el asistente. */
  active: { serverName: string; alias: string | null; cwd: string | null } | null;
  /** Carpeta local en la que se abre el asistente. */
  cwd: string | null;
  now: Date;
  /** Vía elegida en Ajustes. */
  mode: LocalAiMode;
  /** El MCP se configura de verdad en este lanzamiento. */
  mcp: boolean;
  options: Pick<LocalAiSettings, "includeServers" | "includeHosts" | "includeProjects" | "includeActive" | "includeDate">;
  /** Máximo de servidores listados (el resto se resume). */
  maxServers?: number;
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Quita saltos de línea y caracteres de control de un dato del usuario (no puede romper el formato). */
function one(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

const ACCESS_LABEL: Record<McpAccess, string> = {
  none: "sin acceso",
  read: "solo lectura",
  full: "completo (con permiso)",
};

const PRIVILEGE_LABEL: Record<string, string> = {
  root: "root",
  "sudo-nopasswd": "sudo sin contraseña",
  sudo: "sudo (pide contraseña)",
  "maybe-sudo": "quizá sudo",
  user: "usuario sin sudo",
};

/** ¿Se usa la vía directa (ssh) en este lanzamiento? */
export function usesDirect(mode: LocalAiMode, mcp: boolean): boolean {
  return mode !== "mcp" || !mcp;
}

function serverLine(s: ContextServer, input: ContextInput, direct: boolean): string {
  const { options } = input;
  const parts: string[] = [];
  const target = options.includeHosts
    ? `${one(s.username)}@${one(s.host)}${s.port !== 22 ? `:${s.port}` : ""}`
    : one(s.username);
  parts.push(`usuario ${target}`);
  if (direct) {
    if (s.alias) parts.push(`alias ssh \`${s.alias}\``);
    else parts.push("sin alias en ~/.ssh/config");
  }
  if (options.includeProjects && s.projects.length > 0) parts.push(`proyecto ${s.projects.map(one).join(", ")}`);
  if (s.auth === "password") {
    parts.push(
      input.mcp && s.mcpAccess !== "none"
        ? "entra con contraseña: por ssh directo no entrará, usa el MCP"
        : "entra con contraseña: por ssh directo no entrará (pide al usuario que lo haga él)",
    );
  } else if (s.auth === "agent") {
    parts.push("llave del agente ssh");
  } else {
    parts.push("llave");
  }
  if (s.connected) {
    const extra = [s.privilege ? (PRIVILEGE_LABEL[s.privilege] ?? null) : null, s.distro ? one(s.distro) : null]
      .filter(Boolean)
      .join(", ");
    parts.push(`conectado ahora en SSHorus${extra ? ` (${extra})` : ""}`);
  }
  if (input.mcp) parts.push(`MCP: ${ACCESS_LABEL[s.mcpAccess]}`);
  return `- ${one(s.name)}: ${parts.join(" · ")}`;
}

/** Máximo de caracteres que se mandan con «Enviar a la IA» (se guarda el final: lo más reciente). */
export const MAX_SELECTION_CHARS = 20_000;

/** Texto que se pega en el asistente con «Enviar a la IA»: la selección entre ``` y de qué servidor viene.
 *  No lleva salto final: el usuario añade su pregunta y pulsa Enter. */
export function selectionForAi(text: string, serverName: string | null): string {
  let body = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  let cut = false;
  if (body.length > MAX_SELECTION_CHARS) {
    body = body.slice(body.length - MAX_SELECTION_CHARS);
    cut = true;
  }
  // Que la selección no cierre el bloque antes de tiempo.
  const fence = body.includes("```") ? "````" : "```";
  const head = serverName ? `Esto sale de la terminal del servidor «${one(serverName)}»` : "Esto sale de una terminal";
  return `${head}${cut ? " (solo el final)" : ""}:\n${fence}\n${body}\n${fence}\n`;
}

/** Texto de contexto para el asistente (markdown sencillo, en español). Vacío si no hay nada que decir. */
export function buildAiContext(input: ContextInput): string {
  const { options, servers } = input;
  const direct = usesDirect(input.mode, input.mcp);
  const max = input.maxServers ?? 60;
  const out: string[] = [];

  out.push("# Contexto de SSHorus");
  out.push(
    "Te abrió SSHorus, el cliente SSH del usuario, en una terminal de su propio equipo (no en un servidor)." +
      (input.cwd ? ` Carpeta de trabajo: ${one(input.cwd)}.` : ""),
  );
  if (options.includeDate) {
    out.push(`Fecha de hoy: ${WEEKDAYS[input.now.getDay()]} ${isoDate(input.now)}.`);
  }

  out.push("");
  out.push("## Cómo llegar a los servidores");
  if (direct) {
    out.push(
      "- Directo por ssh: `ssh -o BatchMode=yes <alias> '<comando>'` con los alias de abajo (SSHorus los escribe en ~/.ssh/config). BatchMode hace que falle en vez de quedarse esperando una contraseña.",
    );
  }
  if (input.mcp) {
    out.push(
      "- MCP de SSHorus (servidor «sshorus»: list_servers, run_command, read_file, write_file, list_containers, list_sites…): usa las conexiones de SSHorus, también las que van con contraseña. Cada cambio pide permiso al usuario en SSHorus; respeta su respuesta.",
    );
  }
  if (direct && input.mcp) {
    out.push("- Elige la vía que mejor manejes. Para servidores con contraseña o sin alias, usa el MCP.");
  }
  if (!direct && !input.mcp) {
    out.push("- No hay vía configurada: pide al usuario que te diga cómo conectar.");
  }
  out.push("- Antes de cambiar algo en un servidor, di qué comando vas a ejecutar y por qué.");
  out.push("- No pidas ni muestres contraseñas, llaves privadas ni tokens.");

  if (options.includeServers) {
    out.push("");
    if (servers.length === 0) {
      out.push("## Servidores");
      out.push("El usuario aún no tiene servidores guardados en SSHorus.");
    } else {
      out.push(`## Servidores guardados en SSHorus (${servers.length})`);
      // Primero los conectados, luego por nombre.
      const sorted = [...servers].sort(
        (a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name, "es"),
      );
      for (const s of sorted.slice(0, max)) out.push(serverLine(s, input, direct));
      if (sorted.length > max) {
        out.push(
          `- …y ${sorted.length - max} más${input.mcp ? " (pídelos con list_servers del MCP)" : ""}.`,
        );
      }
    }
  }

  if (options.includeProjects && input.projects.length > 0) {
    out.push("");
    out.push("## Proyectos");
    for (const p of input.projects) {
      out.push(`- ${one(p.name)}: ${p.servers.length > 0 ? p.servers.map(one).join(", ") : "sin servidores"}`);
    }
  }

  if (options.includeActive && input.active) {
    const a = input.active;
    out.push("");
    out.push("## Lo que miraba el usuario");
    out.push(
      `Al abrirte tenía delante el servidor «${one(a.serverName)}»` +
        (a.alias && direct ? ` (alias \`${a.alias}\`)` : "") +
        (a.cwd ? `, en la carpeta ${one(a.cwd)}` : "") +
        ". Si pide algo «en el servidor» sin decir cuál, probablemente se refiere a este.",
    );
  }

  return out.join("\n").trim();
}
