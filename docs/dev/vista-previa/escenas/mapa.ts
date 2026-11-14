// Mapa de infraestructura del proyecto «Tienda online»: web-prod (nginx → 2 sitios → contenedores y una
// app de Node; usuarios deploy y ana) y db-01 (PostgreSQL), conectados. Datos de src/features/infra/sample.ts.
import { openProjectMap } from "../../../../src/features/infra/store";
import { sampleSnapshots } from "../../../../src/features/infra/sample";
import { app, el, sleep } from "../ayuda";

async function mapa(seleccion: string | null) {
  await app();
  const ids: Record<string, string> = { "srv-web": "s-web", "srv-db": "s-db" };
  const snaps = sampleSnapshots().map((s) => ({ ...s, id: ids[s.id] ?? s.id }));
  openProjectMap("p-tienda", snaps);
  await el(".im-node", 10000);
  await sleep(500);
  if (seleccion) {
    const n = await el(`[data-node$="${seleccion}"]`);
    const r = n.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.x + 20, clientY: r.y + 10, button: 0, pointerId: 1 };
    n.dispatchEvent(new PointerEvent("pointerdown", opts));
    n.dispatchEvent(new PointerEvent("pointerup", opts));
    await sleep(400);
  }
}

export const escenas: Record<string, () => Promise<void>> = {
  mapa: () => mapa(null),
  "mapa-detalle": () => mapa("|ctr:ana:tienda-app"),
};
