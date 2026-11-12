// Utilidades para las escenas: esperar elementos, clics y escritura como lo haría una persona.

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const visible = (e: HTMLElement) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";

/** Espera a que exista un elemento (selector CSS) visible. */
export async function el(selector: string, timeout = 8000): Promise<HTMLElement> {
  const end = Date.now() + timeout;
  for (;;) {
    const found = [...document.querySelectorAll<HTMLElement>(selector)].find(visible);
    if (found) return found;
    if (Date.now() > end) throw new Error(`No aparece: ${selector}`);
    await sleep(50);
  }
}

/** Elemento visible cuyo texto (recortado) coincide; `within` limita la búsqueda. */
export async function byText(text: string | RegExp, selector = "button, [role=button], [role=tab], a, li, div, span", timeout = 8000) {
  const end = Date.now() + timeout;
  const match = (t: string) => (typeof text === "string" ? t === text : text.test(t));
  for (;;) {
    const all = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (e) => visible(e) && match((e.textContent ?? "").trim()),
    );
    // El más interno (el que no contiene a otro que también coincide).
    const found = all.find((e) => !all.some((o) => o !== e && e.contains(o)));
    if (found) return found;
    if (Date.now() > end) throw new Error(`No aparece el texto: ${String(text)}`);
    await sleep(50);
  }
}

export async function click(target: HTMLElement | Promise<HTMLElement>) {
  const e = await target;
  e.scrollIntoView({ block: "nearest" });
  e.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  e.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  e.click();
  await sleep(120);
}

export async function dblclick(target: HTMLElement | Promise<HTMLElement>) {
  const e = await target;
  e.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await sleep(150);
}

/** Escribe en un input/textarea controlado por React. */
export async function type(target: HTMLElement | Promise<HTMLElement>, value: string) {
  const e = (await target) as HTMLInputElement;
  const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(e, value);
  e.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(80);
}

/** Recorta la captura a uno o varios elementos (se une su contorno); null = ventana entera. */
export function crop(selector: string | string[] | null) {
  window.__recorte = selector;
}

/** Arranque común: la interfaz principal cargada. */
export async function app() {
  await el(".app");
  await sleep(300);
}

/** Abre una conexión a un servidor desde la pantalla de bienvenida o la barra lateral. */
export async function connect(name = "web-prod") {
  await app();
  const item = await byText(name, ".sb-server-name, .wl-server-name, button, li, span");
  await dblclick(item);
  await click(item);
  await el(".xterm-screen", 10000);
  await sleep(600);
}

/** Pestaña fija de la sesión (Archivos, Comandos, Contenedores…). */
export async function sessionTab(label: string) {
  await click(byText(label, "button, [role=tab]"));
  await sleep(500);
}
