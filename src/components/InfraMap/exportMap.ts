// Exportar el mapa: SVG con los colores del tema ya resueltos (sirve fuera de la app) y PNG a partir de él.
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { localfs } from "../../api/localfs";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";

const PROPS = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-opacity",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "color",
  "visibility",
  "display",
];

/** SVG autónomo del contenido (sin zoom ni desplazamiento). */
export function svgText(svg: SVGSVGElement, content: SVGGElement, width: number, height: number): string {
  const clone = content.cloneNode(true) as SVGGElement;
  clone.removeAttribute("transform");
  const src = [content, ...content.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const d = dst[i] as SVGElement;
    d.removeAttribute("class");
    d.setAttribute("style", PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  const bg = getComputedStyle(svg).getPropertyValue("--bg").trim() || "#ffffff";
  const ns = "http://www.w3.org/2000/svg";
  const out = document.createElementNS(ns, "svg");
  out.setAttribute("xmlns", ns);
  out.setAttribute("viewBox", `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
  out.setAttribute("width", String(Math.ceil(width)));
  out.setAttribute("height", String(Math.ceil(height)));
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("width", "100%");
  rect.setAttribute("height", "100%");
  rect.setAttribute("fill", bg);
  out.appendChild(rect);
  // Las puntas de flecha (defs) también.
  const defs = svg.querySelector("defs");
  if (defs) {
    const dc = defs.cloneNode(true) as SVGDefsElement;
    const ds = [...defs.querySelectorAll("*")];
    [...dc.querySelectorAll("*")].forEach((el, i) => {
      const cs = getComputedStyle(ds[i]);
      el.removeAttribute("class");
      el.setAttribute("style", `fill:${cs.getPropertyValue("fill")};stroke:${cs.getPropertyValue("stroke")}`);
    });
    out.appendChild(dc);
  }
  out.appendChild(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(out)}`;
}

/** PNG (al doble de resolución) a partir del SVG. */
export async function pngBytes(svg: string, width: number, height: number, scale = 2): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("No se pudo dibujar la imagen"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Sin lienzo");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("No se pudo crear el PNG");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ask(name: string, ext: string, label: string): Promise<string | null> {
  try {
    let path = await saveFileDialog({ title: "Exportar mapa", defaultPath: `${name}.${ext}`, filters: [{ name: label, extensions: [ext] }] });
    if (!path) return null;
    if (!path.toLowerCase().endsWith(`.${ext}`)) path += `.${ext}`;
    return path;
  } catch (e) {
    toast.error("No se pudo abrir el diálogo para guardar", e);
    return null;
  }
}

export type ExportFormat = "png" | "svg" | "mermaid" | "mermaid-copy";

export async function exportMap(
  format: ExportFormat,
  o: { name: string; svg: SVGSVGElement; content: SVGGElement; width: number; height: number; mermaid: () => string },
): Promise<void> {
  try {
    if (format === "mermaid-copy") {
      await clipboard.write(o.mermaid());
      toast.success("Mermaid copiado");
      return;
    }
    const ext = format === "mermaid" ? "mmd" : format;
    const path = await ask(o.name, ext, format === "mermaid" ? "Mermaid" : format.toUpperCase());
    if (!path) return;
    if (format === "mermaid") await localfs.writeText(path, o.mermaid());
    else {
      const text = svgText(o.svg, o.content, o.width, o.height);
      if (format === "svg") await localfs.writeText(path, text);
      else await localfs.writeBytes(path, await pngBytes(text, o.width, o.height));
    }
    toast.success("Mapa exportado", path);
  } catch (e) {
    toast.error("No se pudo exportar el mapa", e);
  }
}
