// Pestaña «Contenedores» de lab-docker: Docker detectado, contenedores con CPU y memoria en vivo.
import { click, connect, el, sessionTab, sleep } from "../ayuda";

async function contenedores(sinBarra: boolean) {
  await connect("lab-docker");
  if (sinBarra) await click(el(".tabs-side-btn"));
  await sessionTab("Contenedores");
  await el(".ct-table", 10000);
  // Espera a la primera lectura de `docker stats` (CPU y memoria en la tabla).
  const end = Date.now() + 8000;
  while (Date.now() < end && !/%/.test(document.querySelector(".ct-table tbody")?.textContent ?? "")) await sleep(200);
  await sleep(600);
}

export const escenas: Record<string, () => Promise<void>> = {
  // Para el manual, sin barra lateral: más sitio para la tabla.
  contenedores: () => contenedores(true),
  // Comprobación (no va al manual): la tabla con la barra lateral abierta.
  "contenedores-barra": () => contenedores(false),
};
