// Abrir terminales locales y lanzar Claude Code / Codex con el contexto de SSHorus.
//   openLocalTerminal()             // shell del sistema en la última carpeta elegida
//   launchAssistant("claude")       // detecta, ofrece instalar, pregunta por el MCP y abre
//   sendToAi(texto, "web")          // «Enviar a la IA» desde una terminal de servidor
import { createElement } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { localTerm, type AiTool, type AiToolInfo } from "../../api/localterm";
import { mcp, type McpConfig } from "../../api/mcp";
import { confirmDialog } from "../../components/ui/dialogs";
import { openSettingsAt } from "../../components/Settings/settingsNav";
import { tabCurrentPath } from "../../components/Session/sessionState";
import type { TermController } from "../../components/Terminal/termController";
import { useProfiles } from "../../stores/profiles";
import { useSettings } from "../../stores/settings";
import { useTabs } from "../../stores/tabs";
import { toast } from "../../stores/toasts";
import { clipboard } from "../../lib/clipboard";
import { getPrivilege } from "../privileges/store";
import { refreshStatus, useMcp } from "../mcp/store";
import { choiceDialog } from "./ChoiceDialog";
import { buildAiContext, selectionForAi, usesDirect, type ContextServer } from "./context";
import { KIND_LABEL } from "./logic";
import { getLocalController, lastSshTabId, openLocalTab, useLocalTabs } from "./store";

// ───────── Carpeta de inicio ─────────

function lastCwd(): string | null {
  return useSettings.getState().settings.localAi.lastCwd;
}

function rememberCwd(cwd: string) {
  const s = useSettings.getState();
  s.update({ localAi: { ...s.settings.localAi, lastCwd: cwd } });
}

/** Diálogo de carpetas. Recuerda la elegida para la próxima vez. */
export async function chooseFolder(): Promise<string | null> {
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Carpeta de trabajo",
      defaultPath: lastCwd() ?? undefined,
    });
    if (typeof picked !== "string" || !picked) return null;
    rememberCwd(picked);
    return picked;
  } catch (e) {
    toast.error("No se pudo abrir el selector de carpetas", e);
    return null;
  }
}

/** Abre la shell del sistema. */
export function openLocalTerminal(cwd: string | null = lastCwd()) {
  openLocalTab({ kind: "shell", cwd });
}

// ───────── Instalar ─────────

async function offerInstall(info: AiToolInfo, cwd: string | null): Promise<void> {
  if (info.needsNode && !info.npmFound) {
    const go = await confirmDialog({
      title: `${info.label} no está instalado`,
      message: createElement(
        "div",
        null,
        createElement("p", null, `${info.label} se instala con npm, que viene con Node.js, y no se encontró en este equipo.`),
        createElement("p", null, "Instala Node.js (versión LTS) y vuelve a intentarlo. El comando será:"),
        createElement("pre", { className: "lt-cmd" }, info.installCommand),
      ),
      confirmText: "Abrir nodejs.org",
    });
    if (go) openUrl("https://nodejs.org/").catch((e) => toast.error("No se pudo abrir el enlace", e));
    return;
  }
  const ok = await confirmDialog({
    title: `${info.label} no está instalado`,
    message: createElement(
      "div",
      null,
      createElement("p", null, `¿Instalarlo ahora? Se abrirá una terminal local y se ejecutará este comando, para que veas lo que hace:`),
      createElement("pre", { className: "lt-cmd" }, info.installCommand),
      createElement(
        "p",
        { className: "muted" },
        info.tool === "claude"
          ? "Es el instalador oficial de Anthropic (claude.ai/install)."
          : "Es el paquete oficial de OpenAI en npm. Si npm da un error de permisos (EACCES), configura npm para instalar en tu carpeta personal.",
      ),
      createElement("p", { className: "muted" }, `Cuando termine, vuelve a pulsar «${info.label}».`),
    ),
    confirmText: "Instalar",
  });
  if (!ok) return;
  openLocalTab({
    kind: "shell",
    cwd,
    intro: [`Instalando ${info.label}. Cuando termine, vuelve a pulsar «${info.label}» en el menú de terminal local.`],
    initialInput: `${info.installCommand}\r`,
  });
}

// ───────── MCP ─────────

/** ¿Se usa el MCP? Si está apagado, pregunta. null = cancelar. */
async function decideMcp(): Promise<boolean | null> {
  const mode = useSettings.getState().settings.localAi.mode;
  if (mode === "direct") return false;
  await refreshStatus();
  const st = useMcp.getState().status;
  if (st?.enabled) {
    // Encendido pero sin poder usarse: se abre solo con el contexto (y se dice por qué).
    if (!st.running) {
      toast.error("El MCP de SSHorus no está en marcha: se abre solo con el contexto", st.error ?? undefined);
      return false;
    }
    if (!st.bridgeFound) {
      toast.error("No se encontró el puente sshorus-mcp: se abre solo con el contexto", st.bridgePath);
      return false;
    }
    return true;
  }
  const choice = await choiceDialog({
    title: "El MCP de SSHorus está apagado",
    message: createElement(
      "div",
      null,
      createElement(
        "p",
        null,
        "Con el MCP el asistente usa tus conexiones de SSHorus (también las que van con contraseña) y te pide permiso antes de cada cambio.",
      ),
      createElement(
        "p",
        { className: "muted" },
        "Si lo activas, elige después en Ajustes → Asistentes de IA a qué servidores puede entrar (por defecto, a ninguno). Sin MCP, el asistente recibe igual la lista de servidores y puede usar ssh directo.",
      ),
    ),
    choices: [
      { value: "context", label: mode === "mcp" ? "Abrir sin MCP" : "Solo contexto" },
      { value: "enable", label: "Activar el MCP", primary: true },
    ],
  });
  if (choice === null) return null;
  if (choice === "context") return false;
  try {
    const s = await mcp.setEnabled(true);
    useMcp.setState({ status: s });
    if (!s.running) {
      toast.error("El MCP no pudo arrancar", s.error ?? undefined);
      return false;
    }
    if (!s.bridgeFound) {
      toast.error("No se encontró el puente sshorus-mcp: se abre solo con el contexto", s.bridgePath);
      return false;
    }
    const cfg = await mcp.config().catch(() => null);
    if (cfg && Object.keys(cfg.access).length === 0) {
      toast.info(
        "MCP activado",
        "Aún no tiene acceso a ningún servidor: elígelos en Ajustes → Asistentes de IA.",
      );
    }
    return true;
  } catch (e) {
    toast.error("No se pudo activar el MCP", e);
    return false;
  }
}

// ───────── Contexto ─────────

async function gatherContext(
  cwd: string | null,
  withMcp: boolean,
  quiet = false,
): Promise<{ text: string | null; servers: number }> {
  const settings = useSettings.getState().settings.localAi;
  const { servers, projects } = useProfiles.getState();
  const tabs = useTabs.getState().tabs;
  const direct = usesDirect(settings.mode, withMcp);
  const [aliases, cfg] = await Promise.all([
    direct ? localTerm.sshAliases().catch(() => []) : Promise.resolve([]),
    withMcp ? mcp.config().catch((): McpConfig | null => null) : Promise.resolve(null),
  ]);
  const aliasOf = new Map(aliases.map((a) => [a.serverId, a.alias]));
  const projectsOf = (id: string) => projects.filter((p) => p.serverIds.includes(id)).map((p) => p.name);

  const ctxServers: ContextServer[] = servers.map((s) => {
    const tab = tabs.find((t) => t.profileId === s.id && t.status === "connected");
    const priv = tab ? getPrivilege(tab.sessionId) : null;
    return {
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      auth: s.auth,
      alias: aliasOf.get(s.id) ?? null,
      projects: projectsOf(s.id),
      connected: !!tab,
      privilege: priv && priv.level !== "unknown" ? priv.level : null,
      distro: priv?.distroId ?? null,
      mcpAccess: cfg?.access[s.id] ?? "none",
    };
  });

  const lastId = lastSshTabId();
  const lastTab = lastId ? tabs.find((t) => t.id === lastId) : undefined;
  const active = lastTab
    ? {
        serverName: lastTab.title,
        alias: aliasOf.get(lastTab.profileId) ?? null,
        cwd: tabCurrentPath(lastTab),
      }
    : null;

  const text = buildAiContext({
    servers: ctxServers,
    projects: projects.map((p) => ({
      name: p.name,
      servers: p.serverIds.map((id) => servers.find((s) => s.id === id)?.name).filter((n): n is string => !!n),
    })),
    active,
    cwd,
    now: new Date(),
    mode: settings.mode,
    mcp: withMcp,
    options: settings,
  });
  if (!quiet && direct && servers.length > 0 && aliases.length === 0) {
    toast.info(
      "Los servidores no están en ~/.ssh/config",
      "El asistente no podrá usar ssh directo. Expórtalos desde la barra lateral (Nuevo → Exportar) o activa «Mantener sincronizado».",
    );
  }
  return { text: text || null, servers: servers.length };
}

/** El contexto que recibiría ahora un asistente (para verlo en Ajustes). */
export async function previewContext(): Promise<string> {
  const mode = useSettings.getState().settings.localAi.mode;
  await refreshStatus();
  const withMcp = mode !== "direct" && !!useMcp.getState().status?.enabled;
  const r = await gatherContext(lastCwd(), withMcp, true);
  return r.text ?? "";
}

// ───────── Lanzar ─────────

/** Busca si están instalados (con aviso si falla). */
export async function detectAssistants(): Promise<AiToolInfo[] | null> {
  try {
    return await localTerm.detect();
  } catch (e) {
    toast.error("No se pudo comprobar qué asistentes hay instalados", e);
    return null;
  }
}

/**
 * Abre Claude Code o Codex en una pestaña local, en la última carpeta elegida, con el contexto de
 * SSHorus (y su MCP si está activo). Si no está instalado, ofrece instalarlo.
 * `paste`: texto para pegar en el asistente cuando esté listo.
 */
export async function launchAssistant(tool: AiTool, opts: { cwd?: string | null; paste?: string | null } = {}) {
  const cwd = opts.cwd ?? lastCwd();
  const all = await detectAssistants();
  const info = all?.find((i) => i.tool === tool);
  if (!info) return;
  if (!info.installed) {
    await offerInstall(info, cwd);
    return;
  }
  const withMcp = await decideMcp();
  if (withMcp === null) return;
  let context: { text: string | null; servers: number } = { text: null, servers: 0 };
  try {
    context = await gatherContext(cwd, withMcp);
  } catch (e) {
    toast.error("No se pudo preparar el contexto: se abre sin él", e);
  }
  const label = KIND_LABEL[tool];
  const intro = [
    `${label} en ${cwd ?? "tu carpeta personal"}.`,
    context.text
      ? `Contexto de SSHorus: ${context.servers === 1 ? "1 servidor" : `${context.servers} servidores`}${withMcp ? " y el MCP de SSHorus" : ""}.`
      : "Sin contexto de SSHorus (desactivado en Ajustes).",
    tool === "claude"
      ? "Si no has iniciado sesión, Claude Code te lo pedirá (o escribe /login)."
      : "Si no has iniciado sesión, Codex te lo pedirá (o ejecuta «codex login»).",
  ];
  markToolUsed(tool);
  openLocalTab({
    kind: tool,
    cwd,
    launch: { tool, context: context.text, mcp: withMcp },
    intro,
    pendingPaste: opts.paste ?? null,
  });
}

// ───────── Enviar a la IA ─────────

/** Cuánto se espera a que el asistente esté listo para pegar. */
const PASTE_WAIT_MS = 20_000;

/** Pega cuando el programa acepte «pegado entre corchetes» (así no se envía línea a línea).
 *  Si no llega a estar listo, lo deja en el portapapeles. */
export async function pasteWhenReady(getCtrl: () => TermController | null, text: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < PASTE_WAIT_MS) {
    const c = getCtrl();
    if (c?.isRunning() && c.acceptsBracketedPaste()) {
      c.pasteText(text);
      c.focus();
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    await clipboard.write(text);
    toast.info("Texto copiado", "El asistente aún no estaba listo: pégalo tú con Ctrl+Mayús+V.");
  } catch (e) {
    toast.error("No se pudo pasar el texto al asistente", e);
  }
}

/** Pega `text` en la pestaña del asistente abierta (la más reciente) o abre uno. */
export async function sendToAi(text: string, serverName: string | null) {
  const payload = selectionForAi(text, serverName);
  const tabs = useLocalTabs.getState().tabs;
  const target = [...tabs].reverse().find((t) => t.kind !== "shell" && t.aiAlive);
  if (target) {
    useTabs.getState().setActive(target.id);
    await pasteWhenReady(() => getLocalController(target.id), payload);
    return;
  }
  const all = await detectAssistants();
  if (!all) return;
  const installed = all.filter((i) => i.installed);
  if (installed.length === 0) {
    toast.info("No hay ningún asistente instalado", "Abre «Claude Code» o «Codex» desde el menú de terminal local para instalarlo.");
    return;
  }
  // Si están los dos, el último que se usó; si no, Claude Code.
  const prefer = lastTool && installed.some((i) => i.tool === lastTool) ? lastTool : installed[0].tool;
  await launchAssistant(prefer, { paste: payload });
}

let lastTool: AiTool | null = null;

/** Se llama al abrir un asistente (para «Enviar a la IA»). */
export function markToolUsed(tool: AiTool) {
  lastTool = tool;
}

/** Abre Ajustes en la sección de la terminal local. */
export function openLocalAiSettings() {
  openSettingsAt("localAi");
}
