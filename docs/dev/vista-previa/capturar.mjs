#!/usr/bin/env node
// Saca las capturas del manual (docs/manual/*.png) con la interfaz REAL de TerView y el motor simulado.
//
//   node docs/dev/vista-previa/capturar.mjs            # todas
//   node docs/dev/vista-previa/capturar.mjs terminal   # solo las escenas que se nombren
//
// Necesita Google Chrome o Chromium instalado (variable CHROME para otra ruta) y, para aligerar los PNG,
// ImageMagick (`magick`; sin él se guardan tal cual). Arranca solo el servidor de Vite de la vista
// previa (puerto 1430) si no está ya en marcha. SALIDA=/otra/carpeta para no tocar docs/manual.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const outDir = process.env.SALIDA ?? join(root, "docs/manual");
const BASE = "http://localhost:1430/docs/dev/vista-previa/index.html";
const PORT = Number(process.env.PUERTO_CDP ?? 9333);

/** archivo → escena, tema y tamaño de ventana. */
const CAPTURAS = [
  { file: "01-instalar.png", escena: "acerca" },
  { file: "02-servidor.png", escena: "servidor", size: [1280, 1040] },
  { file: "03-proyectos.png", escena: "proyectos" },
  { file: "04-terminal.png", escena: "terminal", query: { sesion: "34,66" } },
  { file: "05-archivos.png", escena: "archivos", query: { sesion: "70,30" } },
  { file: "06-transferencias.png", escena: "transferencias", query: { sesion: "70,30" } },
  { file: "07-editor.png", escena: "editor", query: { sesion: "75,25" } },
  { file: "08-comandos.png", escena: "comandos", query: { sesion: "86,14" } },
  { file: "08b-analizar.png", escena: "analizar", query: { sesion: "86,14" }, size: [1280, 1000] },
  { file: "09-varios-servidores.png", escena: "varios" },
  { file: "10-contenedores.png", escena: "contenedores" },
  { file: "11-monitor.png", escena: "monitor", query: { sesion: "82,18" } },
  { file: "12-tuneles.png", escena: "tuneles", query: { sesion: "70,30" } },
  { file: "13-administracion.png", escena: "administracion" },
  { file: "13b-puertos.png", escena: "puertos", query: { sesion: "70,30" } },
  { file: "13c-sitios.png", escena: "sitios", query: { sesion: "84,16" } },
  { file: "14-vulnerabilidades.png", escena: "vulnerabilidades", query: { sesion: "84,16" } },
  { file: "15-ia.png", escena: "ia" },
  { file: "16-github.png", escena: "github" },
  { file: "17-pin.png", escena: "pin", query: { bloqueado: "1" }, pad: 48 },
  { file: "18-mcp.png", escena: "mcp", size: [1280, 1500] },
  { file: "19-ajustes.png", escena: "ajustes", tema: "light" },
];

const only = process.argv.slice(2);
// Un nombre que no está en la lista se captura igual como «<escena>.png» (útil al preparar escenas nuevas).
const list = only.length
  ? only.map((n) => CAPTURAS.find((c) => c.escena === n || c.file === n) ?? { file: `${n}.png`, escena: n, tema: process.env.TEMA })
  : CAPTURAS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitUp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await up(url)) return;
    await sleep(300);
  }
  throw new Error(`No responde ${url}`);
}

const children = [];
function cleanup() {
  for (const c of children) c.kill("SIGTERM");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));

// 1. Vite
if (!(await up(BASE))) {
  const vite = spawn("npx", ["vite", "--config", "docs/dev/vista-previa/vite.config.ts"], { cwd: root, stdio: "ignore" });
  children.push(vite);
  await waitUp(BASE);
}

// 2. Chrome sin ventana
const chromePath =
  process.env.CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
if (!chromePath) throw new Error("No encuentro Chrome/Chromium (usa CHROME=/ruta)");
const profile = mkdtempSync(join(tmpdir(), "terview-capturas-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--lang=es-ES",
    "about:blank",
  ],
  { stdio: "ignore" },
);
children.push(chrome);
process.on("exit", () => {
  chrome.kill("SIGKILL");
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Chrome aún escribe: se queda en la carpeta temporal */
  }
});
await waitUp(`http://127.0.0.1:${PORT}/json/version`);

// 3. Protocolo de depuración (CDP) sobre WebSocket
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let nextId = 1;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  } else if (m.method === "Runtime.consoleAPICalled") {
    logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  } else if (m.method === "Runtime.exceptionThrown") {
    logs.push(`EXCEPCIÓN: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  }
};
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const c of list) {
  // TEMA=<apariencia> y VENTANA=<ancho>x<alto> fuerzan otra apariencia o tamaño (pruebas, no el manual).
  const tema = process.env.TEMA ?? c.tema ?? "dark";
  const [w, h] = process.env.VENTANA ? process.env.VENTANA.split("x").map(Number) : (c.size ?? [1280, 800]);
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const claro = tema === "light" || tema === "sand";
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: claro ? "light" : "dark" }] });
  logs.length = 0;
  const q = new URLSearchParams({ escena: c.escena, tema, ...(c.query ?? {}) });
  await send("Page.navigate", { url: `${BASE}?${q}` });
  const end = Date.now() + 30000;
  while (Date.now() < end && !(await evaluate("window.__listo === true").catch(() => false))) await sleep(200);
  const listo = await evaluate("window.__listo === true").catch(() => false);
  const err = listo ? await evaluate("window.__errorEscena ?? null").catch(() => "sin respuesta") : "la escena no terminó (¿error al cargar la página?)";
  const sel = await evaluate("window.__recorte ?? null").catch(() => null);
  let clip;
  if (sel) {
    const pad = c.pad ?? 12;
    const r = await evaluate(
      `(() => { const sels = [].concat(${JSON.stringify(sel)}); const bs = sels.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
        if (!bs.length) return null; const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
        return { x, y, width: Math.max(...bs.map((b) => b.right)) - x, height: Math.max(...bs.map((b) => b.bottom)) - y }; })()`,
    );
    if (r) {
      const x = Math.max(0, r.x - pad);
      const y = Math.max(0, r.y - pad);
      clip = { x, y, width: Math.min(w - x, r.width + pad * 2), height: Math.min(h - y, r.height + pad * 2), scale: 1 };
    }
  }
  const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  const out = join(outDir, c.file);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  // Paleta de 256 colores: unas 3 veces menos peso y sin diferencia visible en la interfaz (colores planos).
  spawnSync("magick", [out, "-strip", "-dither", "None", "-colors", "256", "-define", "png:compression-level=9", `PNG8:${out}`]);
  const ok = !err;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${c.file} (${c.escena}, ${tema})${err ? `\n   ${err.split("\n")[0]}` : ""}`);
  const interesting = logs.filter((l) => process.env.DEBUG || /\[sim\]|EXCEPCI|error/i.test(l));
  for (const l of interesting) console.log(`   ${l.slice(0, 400)}`);
}

ws.close();
process.exit(failed ? 1 : 0);
