// «Novedades»: tras actualizar, el primer arranque muestra una vez lo nuevo de esa versión (sacado del
// CHANGELOG incluido en la app). Se carga aparte desde main.tsx cuando ajustes y servidores ya están
// cargados, así no retrasa el arranque. El diálogo vive en su propia raíz de React (como el aviso de
// actualización) y no se muestra mientras TerView está bloqueado.
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import changelogSource from "../../../CHANGELOG.md?raw";
import { parseMarkdown, plainText, splitChangelog } from "../../components/About/markdown";
import { useProfiles } from "../../stores/profiles";

/** Última versión cuyas novedades se vieron (o se dieron por vistas) en este equipo. */
export const LAST_SEEN_KEY = "terview.lastSeenVersion";

/** Como mucho tantos puntos en el aviso; el resto se cuenta y está en el historial completo. */
const MAX_ITEMS = 8;
const MAX_SUMMARY = 130;

export interface WhatsNewItem {
  title: string;
  summary: string;
}
export interface WhatsNewGroup {
  label: string;
  items: WhatsNewItem[];
}
export interface WhatsNewNotes {
  version: string;
  date: string | null;
  groups: WhatsNewGroup[];
  /** Puntos que no caben en el aviso. */
  hidden: number;
}

interface WhatsNewState {
  notes: WhatsNewNotes | null;
  /** Versión que se guarda como vista al cerrar (null si el aviso se forzó a mano). */
  remember: string | null;
}

export const useWhatsNew = create<WhatsNewState>(() => ({ notes: null, remember: null }));

const GROUP_LABELS: Record<string, string> = {
  añadido: "Nuevo",
  cambiado: "Mejorado",
  corregido: "Arreglado",
  eliminado: "Quitado",
  seguridad: "Seguridad",
};

/** `undefined` = no se puede usar el almacenamiento (entonces no se muestra nada, para no insistir). */
function readLastSeen(): string | null | undefined {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return undefined;
  }
}

function writeLastSeen(version: string) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, version);
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Primera frase (sin cortar en «p. ej.»), recortada si es muy larga. */
function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(?=\s+[A-ZÁÉÍÓÚÑ¿¡(]|$)/.exec(text);
  let s = m ? m[1] : text;
  if (s.length > MAX_SUMMARY) s = s.slice(0, MAX_SUMMARY).replace(/[\s,;:]+\S*$/, "") + "…";
  return s;
}

/** `**Título** (dónde): texto…` → título y primera frase. */
function toItem(md: string): WhatsNewItem {
  const m = /^\*\*(.+?)\*\*(.*)$/.exec(md.trim());
  if (!m) return { title: firstSentence(plainText(md)), summary: "" };
  let title = plainText(m[1]).replace(/[\s:.]+$/, "");
  let rest = plainText(m[2]).trim();
  // «(Ajustes → Algo):» al principio dice dónde está: va con el título.
  const where = /^\(([^)]{1,60})\)\s*/.exec(rest);
  if (where) {
    title += ` (${where[1]})`;
    rest = rest.slice(where[0].length);
  }
  rest = rest.replace(/^[\s:.,;—–-]+/, "");
  const summary = rest ? firstSentence(rest.charAt(0).toUpperCase() + rest.slice(1)) : "";
  return { title, summary };
}

function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/^v/i, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Lo esencial de una versión del CHANGELOG: los puntos de primer nivel, agrupados. null si no está. */
export function releaseHighlights(version: string, source: string = changelogSource): WhatsNewNotes | null {
  const release = splitChangelog(source).find((r) => sameVersion(r.version, version));
  if (!release?.body.trim()) return null;
  const groups: WhatsNewGroup[] = [];
  let label = "";
  let shown = 0;
  let hidden = 0;
  for (const b of parseMarkdown(release.body)) {
    if (b.type === "heading") {
      const text = plainText(b.text);
      label = GROUP_LABELS[text.toLowerCase()] ?? text;
      continue;
    }
    if (b.type !== "list") continue;
    let group = groups[groups.length - 1];
    if (!group || group.label !== label) groups.push((group = { label, items: [] }));
    for (const it of b.items) {
      if (shown < MAX_ITEMS) {
        group.items.push(toItem(it.text));
        shown++;
      } else hidden++;
    }
  }
  const visible = groups.filter((g) => g.items.length > 0);
  if (!visible.length) return null;
  return { version: release.version, date: release.date, groups: visible, hidden };
}

let mounted = false;

/** El diálogo vive en su propia raíz de React (no depende de App). */
function ensureMounted() {
  if (mounted) return;
  mounted = true;
  void Promise.all([import("react-dom/client"), import("./WhatsNewDialog")]).then(([{ createRoot }, { WhatsNewDialog }]) => {
    const host = document.createElement("div");
    host.id = "tv-whats-new-root";
    document.body.appendChild(host);
    createRoot(host).render(<WhatsNewDialog />);
  });
}

function open(notes: WhatsNewNotes, remember: string | null) {
  useWhatsNew.setState({ notes, remember });
  ensureMounted();
}

/** Cierra el aviso; si salió solo tras actualizar, apunta la versión como vista. */
export function dismissWhatsNew() {
  const { remember } = useWhatsNew.getState();
  if (remember) writeLastSeen(remember);
  useWhatsNew.setState({ notes: null, remember: null });
}

/**
 * Al arrancar (con ajustes y servidores ya cargados): decide si toca mostrar las novedades.
 * - Instalación nueva (sin versión guardada y sin servidores): se guarda la versión y no se muestra nada.
 * - Sin versión guardada pero con servidores (viene de una versión sin esta función) o con otra versión: se muestra.
 * - Si el CHANGELOG no tiene sección para esta versión: se guarda y no se muestra.
 */
export async function checkWhatsNew(): Promise<void> {
  let current: string;
  try {
    current = await getVersion();
  } catch {
    return;
  }
  const last = readLastSeen();
  if (last === undefined || (last !== null && sameVersion(last, current))) return;
  if (last === null && useProfiles.getState().servers.length === 0) {
    writeLastSeen(current);
    return;
  }
  const notes = releaseHighlights(current);
  if (!notes) {
    writeLastSeen(current);
    return;
  }
  open(notes, current);
}

/**
 * Muestra el aviso de novedades a mano (pruebas y capturas), sin tocar la versión guardada.
 * Sin argumento usa la versión de la app; también vale p. ej. `showWhatsNew("Sin publicar")`.
 * Devuelve false si el CHANGELOG no tiene esa versión.
 */
export async function showWhatsNew(version?: string): Promise<boolean> {
  const v = version ?? (await getVersion().catch(() => null));
  const notes = v ? releaseHighlights(v) : null;
  if (!notes) return false;
  open(notes, null);
  return true;
}

// Solo en desarrollo: poder abrirlo desde la consola (`terviewShowWhatsNew("Sin publicar")`).
if (import.meta.env.DEV) Object.assign(window, { terviewShowWhatsNew: showWhatsNew });
