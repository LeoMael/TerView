// «Abrir túnel a mi PC» para un puerto publicado: reutiliza (o crea) un túnel local del servidor y lo arranca.
import { errorMessage } from "../../api/core";
import { tunnels, type TunnelDef } from "../../api/tunnels";
import { ensureTunnelEvents, useTunnels } from "../../features/tunnels/useTunnels";
import type { PortMapping } from "../../features/containers";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";

export async function openPortTunnel(sessionId: string, profileId: string, p: PortMapping): Promise<void> {
  if (p.hostPort === null) return;
  const port = p.hostPort;
  const destHost = p.hostIp && p.hostIp !== "::" ? p.hostIp : "127.0.0.1";
  try {
    ensureTunnelEvents();
    const store = useTunnels.getState();
    if (!store.defs[profileId]) await store.loadDefs(profileId);
    const defs = useTunnels.getState().defs[profileId] ?? [];
    let def: TunnelDef | undefined = defs.find(
      (d) => d.kind === "local" && d.destPort === port && (d.destHost === destHost || (destHost === "127.0.0.1" && d.destHost === "localhost")),
    );
    if (!def) {
      def = await useTunnels.getState().save({
        id: "",
        profileId,
        name: `Contenedor :${port}`,
        kind: "local",
        bindHost: "127.0.0.1",
        bindPort: port,
        destHost,
        destPort: port,
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
