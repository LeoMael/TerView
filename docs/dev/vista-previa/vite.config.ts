// Vista previa de SSHorus en un navegador normal, con el motor (Rust) SIMULADO y datos falsos.
// Solo sirve para sacar las capturas del manual (docs/manual/*.png). No forma parte de la app:
// `npm run build` usa el vite.config.ts de la raíz, que solo compila index.html.
//
//   npx vite --config docs/dev/vista-previa/vite.config.ts
//   → http://localhost:1430/docs/dev/vista-previa/index.html?escena=terminal&tema=dark
//
// Para regenerar todas las capturas: node docs/dev/vista-previa/capturar.mjs
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    open: false,
    // Sin recarga en caliente: varias capturas pueden ir a la vez y no deben recargarse solas.
    hmr: false,
    watch: { ignored: ["**/src-tauri/**", "**/docs/manual/**"] },
  },
});
