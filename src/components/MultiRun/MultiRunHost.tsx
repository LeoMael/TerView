// Monta el panel "Ejecutar en varios servidores" cuando está abierto (se carga al usarse).
// App lo monta una vez: <MultiRunHost />. Para abrirlo: openMultiRun({...}) de features/multirun.
import { Suspense } from "react";
import { useMultiRun } from "../../features/multirun/store";
import { preloadable } from "../../lib/lazy";

export const MultiRunPanel = preloadable(() => import("./MultiRunPanel").then((m) => m.MultiRunPanel));

export function MultiRunHost() {
  const open = useMultiRun((s) => s.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <MultiRunPanel />
    </Suspense>
  );
}
