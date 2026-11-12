// «Abrir túnel a mi PC» para un puerto publicado de un contenedor (usa el túnel local común).
import type { PortMapping } from "../../features/containers";
import { openLocalTunnel } from "../../features/tunnels/openLocal";

export async function openPortTunnel(sessionId: string, profileId: string, p: PortMapping): Promise<void> {
  if (p.hostPort === null) return;
  const destHost = p.hostIp && p.hostIp !== "::" ? p.hostIp : "127.0.0.1";
  await openLocalTunnel(sessionId, profileId, destHost, p.hostPort, `Contenedor :${p.hostPort}`);
}
