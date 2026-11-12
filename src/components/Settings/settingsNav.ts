// Sección visible de Ajustes, para poder abrirlos directamente en una sección (p. ej. «Acerca de»).
import { create } from "zustand";
import { useUi } from "../../stores/ui";

export type SectionId =
  | "appearance"
  | "terminal"
  | "connection"
  | "transfers"
  | "explorer"
  | "editor"
  | "servers"
  | "security"
  | "assistants"
  | "ai"
  | "advanced"
  | "about";

export const useSettingsNav = create<{ section: SectionId; setSection: (s: SectionId) => void }>((set) => ({
  section: "appearance",
  setSection: (section) => set({ section }),
}));

/** Abre Ajustes en la sección indicada. */
export function openSettingsAt(section: SectionId) {
  useSettingsNav.getState().setSection(section);
  useUi.getState().openSettings();
}
