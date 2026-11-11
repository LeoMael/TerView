// Portapapeles del sistema vía plugin de Tauri (navigator.clipboard falla en WebKitGTK).
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export const clipboard = {
  write: (text: string) => writeText(text),
  read: async () => (await readText()) ?? "",
};
