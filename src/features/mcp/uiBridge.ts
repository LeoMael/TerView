// Peticiones del servidor MCP a la interfaz (evento `mcp://ui-request`, respuesta `mcp_ui_reply`).
//
// Aquí se reutiliza lo que ya hace la interfaz en vez de copiarlo al motor:
// - connect: el flujo normal de conexión (contraseña, huella, 2FA) y su pestaña.
// - catalog: el catálogo base de la Biblioteca (components/Commands/catalog.ts).
// - ports / sites: los scripts y analizadores de Administración (features/admin/ports.ts y web.ts).
// - containers: la detección de Podman/Docker y la lista de contenedores (features/containers).
// - sudo / sudo-rejected: la contraseña de sudo de un comando del asistente ya aprobado (sudoAsk.ts) y el
//   aviso de que sudo la rechazó. La contraseña va al motor (que la pasa por stdin), nunca al asistente.
// Las lecturas se hacen como el usuario conectado (sin sudo).
import { errorMessage } from "../../api/core";
import { mcp, type McpUiRequest } from "../../api/mcp";
import { useProfiles } from "../../stores/profiles";
import { useTabs } from "../../stores/tabs";
import { toast } from "../../stores/toasts";
import { connectToServer } from "../connect";
import { sudoRejectedNotified } from "../privileges";
import { sudoForAssistant } from "./sudoAsk";

async function connect(profileId: string): Promise<{ sessionId: string }> {
  const findTab = () =>
    useTabs
      .getState()
      .tabs.filter((t) => t.profileId === profileId && t.status === "connected")
      .slice(-1)[0];
  const open = findTab();
  if (open) return { sessionId: open.sessionId };
  const profile = useProfiles.getState().servers.find((s) => s.id === profileId);
  if (!profile) throw new Error("Ese servidor ya no existe en TerView");
  const ok = await connectToServer(profile, { initialPath: profile.defaultPath });
  const tab = findTab();
  if (!ok || !tab) throw new Error(`No se pudo conectar a «${profile.name}» (o se canceló en TerView)`);
  return { sessionId: tab.sessionId };
}

async function catalog() {
  const { CATALOG } = await import("../../components/Commands/catalog");
  return CATALOG.map((e) => ({
    id: e.id,
    category: e.category,
    name: e.name,
    description: e.description ?? null,
    command: e.command,
    dangerous: e.dangerous,
    sudo: e.sudo,
    readOnly: e.readOnly,
    interactive: !!e.interactive,
  }));
}

function sessionOf(payload: Record<string, unknown>): string {
  const id = payload.sessionId;
  if (typeof id !== "string" || !id) throw new Error("Falta la conexión");
  return id;
}

async function ports(sessionId: string) {
  const { PORTS_SCRIPT, parsePorts, readElevated } = await import("../admin");
  const r = await readElevated(sessionId, PORTS_SCRIPT, null, 20);
  return parsePorts(r.result.stdout);
}

async function sites(sessionId: string) {
  const { WEB_SCRIPT, parseWeb, readElevated } = await import("../admin");
  const r = await readElevated(sessionId, WEB_SCRIPT, null, 40);
  return parseWeb(r.result.stdout);
}

async function containers(sessionId: string) {
  const c = await import("../containers");
  const none = { kind: "none" } as const;
  const det = await c.runRaw(sessionId, c.DETECT_SCRIPT, none, 40);
  const found = det.result ? c.parseDetect(det.result.stdout) : null;
  if (!found?.ok) throw new Error(det.error ?? "No se pudo comprobar si hay Podman o Docker en el servidor");
  const engines = [];
  for (const st of [found.podman, found.docker]) {
    if (!st) continue;
    // El emulador de Docker de Podman repetiría los mismos contenedores.
    if (st.engine === "docker" && found.dockerIsShim) continue;
    if (!st.installed || !st.accessible) {
      engines.push({ engine: st.engine, installed: st.installed, version: st.version, problem: st.problem, containers: [] });
      continue;
    }
    const r = await c.runEngine(sessionId, [c.listContainers(st.engine)], none, 30);
    engines.push({
      engine: st.engine,
      installed: true,
      version: st.version,
      rootless: st.rootless,
      problem: r.ok ? null : r.error,
      containers: r.ok && r.result ? c.parseContainers(r.result.stdout) : [],
    });
  }
  if (engines.length === 0) return { engines, note: "No hay Podman ni Docker en el servidor" };
  return { engines };
}

async function run(req: McpUiRequest): Promise<unknown> {
  switch (req.kind) {
    case "connect": {
      const profileId = req.payload.profileId;
      if (typeof profileId !== "string") throw new Error("Falta el servidor");
      return connect(profileId);
    }
    case "catalog":
      return catalog();
    case "ports":
      return ports(sessionOf(req.payload));
    case "sites":
      return sites(sessionOf(req.payload));
    case "containers":
      return containers(sessionOf(req.payload));
    case "sudo":
      return sudoForAssistant(req.payload);
    case "sudo-rejected": {
      // Igual que la interfaz: se olvida la de memoria y la guardada queda como rechazada.
      sudoRejectedNotified(sessionOf(req.payload));
      const name = typeof req.payload.serverName === "string" ? req.payload.serverName : "el servidor";
      toast.error("Contraseña de sudo incorrecta", `sudo la rechazó en «${name}» (comando del asistente). Se pedirá de nuevo.`);
      return null;
    }
    default:
      throw new Error(`Petición desconocida: ${req.kind}`);
  }
}

export async function handleUiRequest(req: McpUiRequest) {
  try {
    const value = await run(req);
    await mcp.uiReply(req.id, true, value, null);
  } catch (e) {
    await mcp.uiReply(req.id, false, null, errorMessage(e)).catch(() => {});
  }
}
