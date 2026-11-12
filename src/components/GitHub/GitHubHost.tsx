// Punto de montaje de la ventana de GitHub.
//   <GitHubHost />            una vez, en App (junto a DialogHost)
//   openGitHub("keys")        desde cualquier sitio (barra lateral, Ajustes, paleta…)
import { lazy, Suspense } from "react";
import { useGitHub, type GhSection } from "../../features/github/store";

const GitHubDialog = lazy(() => import("./GitHubDialog").then((m) => ({ default: m.GitHubDialog })));

export type { GhSection };

/** Abre la ventana de GitHub (opcionalmente en una sección). */
export function openGitHub(section?: GhSection) {
  useGitHub.getState().show(section);
}

export function closeGitHub() {
  useGitHub.getState().close();
}

export function GitHubHost() {
  const open = useGitHub((s) => s.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <GitHubDialog />
    </Suspense>
  );
}
