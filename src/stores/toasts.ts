// Notificaciones pequeñas (esquina inferior derecha). BASE compartida.
import { create } from "zustand";
import { errorMessage } from "../api/core";

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">, ms?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ms = 4500) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (title: string, message?: string) => useToasts.getState().push({ kind: "info", title, message }),
  success: (title: string, message?: string) => useToasts.getState().push({ kind: "success", title, message }),
  error: (title: string, err?: unknown) =>
    useToasts.getState().push({ kind: "error", title, message: err === undefined ? undefined : errorMessage(err) }, 7000),
};
