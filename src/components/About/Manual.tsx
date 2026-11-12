// Manual de uso dentro de la app (docs/MANUAL.md incluido en la build). Va en un trozo aparte:
// solo se carga al abrir Ajustes → Manual de uso. Las capturas (docs/manual/*.png) se cargan aún más
// tarde, una a una, cuando el visor llega a ellas.
import { useRef } from "react";
import { ArrowUp } from "lucide-react";
import manualSource from "../../../docs/MANUAL.md?raw";
import { Markdown, type MarkdownEnv } from "./markdown";
import "./Manual.css";

// Sin `eager`: cada imagen es un módulo aparte que solo trae su URL al pedirla.
const IMAGES = import.meta.glob<string>("../../../docs/manual/*.png", { query: "?url", import: "default" });
const IMAGE_BY_NAME = new Map(Object.entries(IMAGES).map(([path, load]) => [path.slice(path.lastIndexOf("/") + 1), load]));

/** `manual/01-instalar.png` (ruta relativa a docs/MANUAL.md) → URL de la imagen empaquetada. */
async function resolveManualImage(src: string): Promise<string | null> {
  const clean = src.split(/[?#]/)[0];
  const load = IMAGE_BY_NAME.get(clean.slice(clean.lastIndexOf("/") + 1));
  return load ? load() : null;
}

const ENV: MarkdownEnv = { resolveImage: resolveManualImage };

export default function ManualView() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="ab-man">
      <div className="ab-man-bar">
        <h3 className="ab-man-title">Manual de uso</h3>
        <button className="btn btn-sm" onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>
          <ArrowUp size={13} /> Ir al inicio
        </button>
      </div>
      <div className="ab-man-scroll" ref={scrollRef}>
        <Markdown source={manualSource} className="ab-md ab-man-md" env={ENV} />
      </div>
    </div>
  );
}
