// Escucha Ctrl+Shift+P (y openPalette()) y carga la paleta de comandos solo cuando se abre.
// La paleta y el catálogo de comandos van en un trozo aparte: no pesan en el arranque.
import { Suspense, useEffect, useState } from "react";
import { preloadable } from "../../lib/lazy";
import { OPEN_PALETTE_EVENT } from "./actions";
import { isModKey } from "../../lib/platform";

export const PaletteView = preloadable(() => import("./CommandPalette").then((m) => m.PaletteView));

export function PaletteHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Mayús+P (⌘⇧P en macOS).
      if (isModKey(e) && e.shiftKey && !e.altKey && (e.key === "P" || e.key === "p" || e.code === "KeyP")) {
        // Fase de captura: antes de que la terminal lo convierta en ^P.
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <PaletteView onClose={() => setOpen(false)} />
    </Suspense>
  );
}
