// Carga diferida de componentes con precarga.
//   const X = preloadable(() => import("./X").then((m) => m.X));
//   X.preload();            // en segundo plano (p. ej. con whenIdle)
//   <Suspense fallback={…}><X {...props} /></Suspense>
// Si el módulo ya está cargado se renderiza directamente (sin pasar por Suspense ni parpadear).
import { createElement, lazy, useState, type ComponentType } from "react";

export interface Preloadable<P extends object> {
  (props: P): ReturnType<typeof createElement>;
  preload: () => Promise<unknown>;
}

export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>): Preloadable<P> {
  let loaded: ComponentType<P> | null = null;
  let promise: Promise<ComponentType<P>> | null = null;
  const preload = () => {
    promise ??= load().then(
      (c) => (loaded = c),
      (err: unknown) => {
        promise = null; // permitir reintentar
        throw err;
      },
    );
    return promise;
  };
  const Lazy = lazy(() => preload().then((c) => ({ default: c })));
  function Wrapper(props: P) {
    // Se decide una sola vez por instancia: cambiar de tipo desmontaría el árbol (terminales, editores…).
    const [C] = useState<ComponentType<P>>(() => loaded ?? (Lazy as unknown as ComponentType<P>));
    return createElement(C, props);
  }
  return Object.assign(Wrapper, { preload });
}

type IdleWin = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

/** Ejecuta `fn` cuando la ventana esté ociosa (o tras `timeout` ms como máximo). */
export function whenIdle(fn: () => void, timeout = 2000): void {
  const w = window as IdleWin;
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout });
  else setTimeout(fn, Math.min(timeout, 300));
}

/** Ejecuta las tareas una tras otra, cada una en un momento ocioso distinto (no bloquea la ventana). */
export function idleQueue(tasks: (() => Promise<unknown> | void)[], timeout = 3000): void {
  const next = (i: number) => {
    if (i >= tasks.length) return;
    whenIdle(() => {
      Promise.resolve()
        .then(tasks[i])
        .catch(() => {
          /* la precarga es opcional: si falla, se cargará al usarse */
        })
        .finally(() => next(i + 1));
    }, timeout);
  };
  next(0);
}
