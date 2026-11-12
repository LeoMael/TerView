// Escenas: cada una deja la app en el estado que muestra una imagen del manual.
// Se manejan casi siempre como lo haría una persona (clics sobre la interfaz real); a veces se abre
// un diálogo directamente con su store.
import { useUi } from "../../../src/stores/ui";
import { openManual, openSettingsAt } from "../../../src/components/Settings/settingsNav";
import { showWhatsNew } from "../../../src/features/whatsNew/whatsNew";
import { emit } from "@tauri-apps/api/event";
import { SERVERS } from "./datos";
import { JOBS } from "./respuestas/general";
import * as ayuda from "./ayuda";
import { app, byText, click, connect, crop, dblclick, el, sessionTab, sleep, type } from "./ayuda";

async function settings(section: Parameters<typeof openSettingsAt>[0]) {
  await app();
  openSettingsAt(section);
  await el(".modal");
  await sleep(500);
  crop(".modal");
}

/** Pulsa una tecla con modificadores sobre un elemento (o el que tiene el foco). */
async function key(target: HTMLElement | null, k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  const t = target ?? (document.activeElement as HTMLElement) ?? document.body;
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  t.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

/** Fila del explorador por ruta. */
const row = (path: string) => el(`.fx-row[data-fx-path="${path}"]`);

async function pressRow(path: string, ctrl = false) {
  const r = await row(path);
  r.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: ctrl }));
  r.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, ctrlKey: ctrl }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  await sleep(100);
}

/** Abre la carpeta de la tienda en el explorador. */
async function tienda() {
  await connect();
  await dblclick(row("/var/www/tienda"));
  await row("/var/www/tienda/logo.png");
  await sleep(300);
}

export const ESCENAS: Record<string, () => Promise<void>> = {
  inicio: async () => {
    await app();
  },
  acerca: () => settings("about"),
  mcp: () => settings("assistants"),
  ia: () => settings("ai"),
  ajustes: async () => {
    await connect();
    openSettingsAt("appearance");
    await el(".modal");
    await sleep(500);
  },
  servidor: async () => {
    await app();
    useUi.getState().openServerEditor(SERVERS[0]);
    await el(".modal");
    await sleep(400);
    crop(".modal");
  },
  proyectos: async () => {
    await app();
    await click(byText(/Nuevo/, "button"));
    await sleep(300);
    crop([".app-sidebar", ".context-menu"]);
  },
  pin: async () => {
    await el(".lock-card", 10000);
    await sleep(300);
    crop(".lock-card");
  },
  terminal: async () => {
    await connect();
    // Segunda terminal y vuelta a la primera.
    await click(el("[aria-label='Nueva terminal'], [title^='Nueva terminal']"));
    await sleep(500);
    await click(byText(/^Terminal 1/, "[role=tab], button, div"));
    await sleep(400);
    // Buscar en la terminal (Ctrl+Shift+F).
    const ta = await el(".xterm-helper-textarea");
    ta.focus();
    await key(ta, "F", { ctrl: true, shift: true });
    const input = await el(".term-search-input", 3000).catch(() => null);
    if (input) await type(input, "pedido");
    await sleep(300);
  },
  archivos: async () => {
    await tienda();
    await pressRow("/var/www/tienda/catalogo-2026.csv");
    await pressRow("/var/www/tienda/logo.png", true);
    const r = await row("/var/www/tienda/logo.png");
    const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.x + 160, clientY: b.y + 14, button: 2 }));
    await sleep(400);
  },
  transferencias: async () => {
    await tienda();
    await click(el(".tp-collapsed"));
    // Avance de los archivos en curso (la velocidad se calcula con lo que llega cada momento).
    const jobs = JOBS.map((j) => ({ ...j }));
    for (let i = 0; i < 12; i++) {
      for (const j of jobs) if (j.status === "running") j.transferred = Math.min(j.size * 0.95, j.transferred + j.speed * 0.25);
      await emit("transfer://update", jobs.filter((j) => j.status === "running"));
      await sleep(250);
    }
    await click(byText("fotos/", "button, span, div"));
    await sleep(500);
  },
  editor: async () => {
    await tienda();
    await dblclick(row("/var/www/tienda/index.php"));
    await sleep(600);
    await sessionTab("Archivos");
    await dblclick(row("/var/www/tienda/nginx.conf"));
    await el(".monaco-editor .view-lines", 15000);
    await sleep(1200);
  },
  tuneles: async () => {
    await connect();
    await sessionTab("Túneles");
    await sleep(600);
  },
  // Comprobaciones de la guía dentro de la app (no van al manual).
  manual: async () => {
    await app();
    openManual();
    await el(".modal");
    await sleep(1500);
    crop(".modal");
  },
  "manual-imagenes": async () => {
    await app();
    openManual();
    await el(".modal img", 10000);
    (await el(".modal img")).scrollIntoView({ block: "start" });
    await sleep(1500);
    crop(".modal");
  },
  novedades: async () => {
    await app();
    await showWhatsNew("Sin publicar");
    await sleep(800);
  },
  github: async () => {
    await app();
    await click(el("[aria-label='GitHub']"));
    await el(".modal, [role=dialog]");
    await sleep(800);
  },
};

// Más escenas en ./escenas/*.ts (cada archivo exporta `escenas`).
const MAS = import.meta.glob<Record<string, () => Promise<void>>>("./escenas/*.ts", { eager: true, import: "escenas" });
for (const m of Object.values(MAS)) Object.assign(ESCENAS, m);

export async function runEscena(name: string) {
  const f = ESCENAS[name];
  if (!f) throw new Error(`Escena desconocida: ${name}`);
  crop(null);
  await f();
  await sleep(400);
}

// Utilidades disponibles para depurar desde la consola del navegador.
Object.assign(window, { __sim: ayuda });
