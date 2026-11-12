import { call } from "./core";

/** Carpeta de la caché donde se prepara (descarga) lo que se va a arrastrar al sistema. */
export interface DragOutDir {
  /** Raíz de todo lo preparado (para reconocer los arrastres propios al soltar en la app). */
  root: string;
  /** Carpeta nueva y vacía para esta descarga. */
  dir: string;
}

/** Arrastrar del explorador remoto al escritorio / gestor de archivos del sistema. */
export const dragOut = {
  /** Crea una carpeta nueva en la caché de arrastre. */
  dir: () => call<DragOutDir>("drag_out_dir"),
  /** Empieza el arrastre nativo (con el botón del ratón apretado). Resuelve al soltar:
   *  `true` si se soltó en algún sitio, `false` si se canceló. Error `NotFound` si lo
   *  preparado ya no está en la caché. */
  start: (paths: string[]) => call<boolean>("drag_out_start", { paths }),
};
