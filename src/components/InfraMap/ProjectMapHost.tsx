// App lo monta una vez: <ProjectMapHost />. Para abrirlo: openProjectMap(projectId) de features/infra/store.
import { Suspense } from "react";
import { useProjectMap } from "../../features/infra/store";
import { preloadable } from "../../lib/lazy";

const ProjectMap = preloadable(() => import("./ProjectMap").then((m) => m.ProjectMap));

export function ProjectMapHost() {
  const open = useProjectMap((s) => s.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <ProjectMap />
    </Suspense>
  );
}
