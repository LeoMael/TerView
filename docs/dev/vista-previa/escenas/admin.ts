// Escenas de la pestaña «Administración» de web-prod: usuarios, puertos, sitios web, vulnerabilidades y auditoría.
import { byText, click, connect, el, sessionTab, sleep } from "../ayuda";

async function admin(sub?: string, sinBarra = false) {
  await connect("web-prod");
  // Sin la barra lateral las tablas anchas (versiones, rutas) caben sin recortar.
  if (sinBarra) await click(el("[aria-label='Mostrar u ocultar barra lateral']"));
  await sessionTab("Administración");
  await el(".adm-root");
  if (sub) await click(byText(sub, ".adm-tab"));
}

export const escenas: Record<string, () => Promise<void>> = {
  administracion: async () => {
    await admin();
    await el(".adm-name");
    // Con la lectura de /etc/shadow ya hecha (columna «Estado»).
    await byText("Activo", ".adm-tag");
    await click(byText("ana", ".adm-name"));
    await sleep(400);
  },
  puertos: async () => {
    await admin("Puertos");
    await byText(/nginx/, ".adm-body span, .adm-body div");
    await sleep(500);
  },
  sitios: async () => {
    await admin("Sitios web", true);
    await el(".adm-site");
    await byText(/escuchando/, ".adm-listen");
    await sleep(500);
  },
  vulnerabilidades: async () => {
    await admin("Vulnerabilidades", true);
    await el(".vs-summary");
    await byText(/nuevas/, ".vs-summary span");
    await sleep(500);
  },
  auditoria: async () => {
    await admin("Auditoría", true);
    await el(".au-summary");
    await el(".au-check");
    await sleep(500);
  },
};
