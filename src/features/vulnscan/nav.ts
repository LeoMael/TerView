// Atajo «Ver vulnerabilidades» desde Contenedores → Imágenes: pide abrir Administración →
// Vulnerabilidades de esa sesión, filtrada por una imagen.
import { create } from "zustand";

export interface VulnNavRequest {
  sessionId: string;
  /** Id corto (12) de la imagen. */
  imageId: string;
  /** Nombre para mostrar en el filtro. */
  label: string;
  seq: number;
}

interface NavState {
  request: VulnNavRequest | null;
  open: (sessionId: string, imageId: string, label: string) => void;
  /** La sub-pestaña ya aplicó el filtro. */
  done: (seq: number) => void;
}

let seq = 0;

export const useVulnNav = create<NavState>((set) => ({
  request: null,
  open: (sessionId, imageId, label) =>
    set({ request: { sessionId, imageId: imageId.replace(/^sha256:/, "").slice(0, 12), label, seq: ++seq } }),
  done: (s) => set((st) => (st.request?.seq === s ? { request: null } : st)),
}));
