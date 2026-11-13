// Monaco empaquetado localmente (sin CDN: la app funciona sin internet).
// Se importa una sola vez (desde RemoteEditor, cargado de forma diferida).
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// Si alguien usa los componentes de @monaco-editor/react, que usen esta copia local.
loader.config({ monaco });

// Sin validación semántica de TS/JS: los archivos remotos no tienen su proyecto alrededor.
type TsDefaults = { setDiagnosticsOptions?: (o: { noSemanticValidation: boolean; noSyntaxValidation: boolean }) => void };
const tsLang = (monaco.languages as unknown as { typescript?: { typescriptDefaults?: TsDefaults; javascriptDefaults?: TsDefaults } })
  .typescript;
for (const d of [tsLang?.typescriptDefaults, tsLang?.javascriptDefaults]) {
  d?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback;
}

/** Color de una variable CSS sin «#», para las reglas de sintaxis. */
function tokenColor(name: string, fallback: string): string {
  return cssVar(name, fallback).replace("#", "").slice(0, 6);
}

/** Define (o redefine) el tema de Monaco con los colores de la apariencia actual y lo aplica.
 *  Lee las variables de <html>, así que vale para cualquier apariencia y acento. */
export function applyMonacoTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme !== "light";
  const palette = root.dataset.palette ?? (dark ? "dark" : "light");
  const bg = cssVar("--surface", dark ? "#111827" : "#ffffff");
  const fg = cssVar("--text", dark ? "#e2e8f0" : "#0f172a");
  const faint = cssVar("--text-faint", dark ? "#64748b" : "#64748b");
  const muted = cssVar("--text-muted", dark ? "#94a3b8" : "#475569");
  const accent = cssVar("--accent", dark ? "#38bdf8" : "#0284c7");
  const accentBg = cssVar("--accent-bg", dark ? "#1e3a5f" : "#dbeafe");
  const surface2 = cssVar("--surface-2", dark ? "#1e293b" : "#f1f5f9");
  const border = cssVar("--border-strong", dark ? "#334155" : "#cbd5e1");
  // Las apariencias propias colorean también la sintaxis con sus tonos; Oscuro y Claro dejan los de Monaco.
  const custom = palette !== "dark" && palette !== "light";
  const rules = custom
    ? [
        { token: "comment", foreground: tokenColor("--text-faint", "64748b"), fontStyle: "italic" },
        { token: "keyword", foreground: tokenColor("--purple", "a78bfa") },
        { token: "string", foreground: tokenColor("--green", "22c55e") },
        { token: "number", foreground: tokenColor("--orange", "f97316") },
        { token: "type", foreground: tokenColor("--yellow", "facc15") },
        { token: "tag", foreground: tokenColor("--accent", "38bdf8") },
        { token: "attribute.name", foreground: tokenColor("--yellow", "facc15") },
        { token: "variable", foreground: tokenColor("--text", "e2e8f0") },
        { token: "delimiter", foreground: tokenColor("--text-muted", "94a3b8") },
      ]
    : [];
  const name = `terview-${palette}`;
  monaco.editor.defineTheme(name, {
    base: dark ? (palette === "contrast" ? "hc-black" : "vs-dark") : "vs",
    inherit: true,
    rules,
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editorLineNumber.foreground": faint,
      "editorLineNumber.activeForeground": muted,
      "editorCursor.foreground": accent,
      "editor.selectionBackground": accentBg,
      "editor.inactiveSelectionBackground": surface2,
      "editor.lineHighlightBackground": surface2 + "80",
      "editor.lineHighlightBorder": "#00000000",
      "editorWidget.background": surface2,
      "editorWidget.border": border,
      "editorGutter.background": bg,
      "minimap.background": bg,
      "scrollbarSlider.background": border + "80",
      "scrollbarSlider.hoverBackground": border,
      "focusBorder": accent + "00",
    },
  });
  monaco.editor.setTheme(name);
}

export { monaco };
