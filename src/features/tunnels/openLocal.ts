// «Abrir túnel a mi PC» hacia un puerto del servidor: reutiliza (o crea) un túnel local guardado y lo arranca.
// Lo usan Contenedores (puertos publicados) y Administración → Puertos.
import { errorMessage } from "../../api/core";
import { tunnels, type TunnelDef } from "../../api/tunnels";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { ensureTunnelEvents, useTunnels } from "./useTunnels";

function sameHost(a: string, b: string): boolean {
  const norm = (h: string) => (h === "localhost" ? "127.0.0.1" : h.replace(/^\[|\]$/g, "").toLowerCase());
  return norm(a) === norm(b);
}

/**
 * Abre en tu PC un túnel hacia `destHost:destPort` (visto desde el servidor), copia la dirección local
 * y avisa con un mensaje. Si el puerto es menor de 1024 se escucha en uno libre (en tu PC no se pueden
 * abrir puertos bajos sin ser administrador).
 */
export async function openLocalTunnel(
  sessionId: string,
  profileId: string,
  destHost: string,
  destPort: number,
  name: string,
): Promise<void> {
  try {
    ensureTunnelEvents();
    const store = useTunnels.getState();
    if (!store.defs[profileId]) await store.loadDefs(profileId);
    const defs = useTunnels.getState().defs[profileId] ?? [];
    let def: TunnelDef | undefined = defs.find(
      (d) => d.kind === "local" && d.destPort === destPort && sameHost(d.destHost, destHost),
    );
    if (!def) {
      def = await useTunnels.getState().save({
        id: "",
        profileId,
        name,
        kind: "local",
        bindHost: "127.0.0.1",
        bindPort: destPort < 1024 ? 0 : destPort,
        destHost,
        destPort,
        autoStart: false,
      });
    }
    const st = await tunnels.start(sessionId, def.id);
    useTunnels.getState().applyStatus(st);
    const addr = `localhost:${st.boundPort ?? def.bindPort}`;
    await clipboard.write(addr).catch(() => {});
    toast.success("Túnel abierto", `Usa ${addr} en tu PC (dirección copiada). Lo verás en la pestaña Túneles.`);
  } catch (e) {
    toast.error("No se pudo abrir el túnel", errorMessage(e));
  }
}
