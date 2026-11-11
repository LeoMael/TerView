// Plantillas de comandos: variables {{nombre}} / {{nombre:defecto}}, sustitución segura y búsqueda.
// Las plantillas Go como {{.Names}} NO son variables (el nombre debe empezar por letra o "_").

export const VAR_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}\}/g;

export interface TemplateVar {
  name: string;
  /** Primer valor por defecto que aparece en la plantilla (o undefined). */
  default?: string;
}

/** Variables de la plantilla, en orden de aparición y sin repetir. */
export function parseVars(template: string): TemplateVar[] {
  const out: TemplateVar[] = [];
  const seen = new Map<string, TemplateVar>();
  for (const m of template.matchAll(VAR_RE)) {
    const name = m[1];
    const def = m[2];
    const prev = seen.get(name);
    if (prev) {
      if (prev.default === undefined && def !== undefined) prev.default = def;
      continue;
    }
    const v: TemplateVar = { name, default: def };
    seen.set(name, v);
    out.push(v);
  }
  return out;
}

/** Caracteres que no necesitan comillas fuera de comillas. */
const SAFE_RE = /^[A-Za-z0-9_@%+=:,./~^-]+$/;

/** Cita un valor para la shell (fuera de comillas). */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (SAFE_RE.test(value)) return value;
  // "~/mi carpeta" → ~/'mi carpeta' (conserva la expansión de ~).
  const tilde = /^~[A-Za-z0-9_.-]*\//.exec(value);
  if (tilde) return tilde[0] + shellQuote(value.slice(tilde[0].length));
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type QuoteCtx = "none" | "single" | "double";

function quoteFor(ctx: QuoteCtx, value: string): string {
  switch (ctx) {
    case "single":
      // Cerramos, escapamos la comilla y reabrimos.
      return value.replace(/'/g, `'\\''`);
    case "double":
      return value.replace(/[\\"$`]/g, (c) => `\\${c}`);
    default:
      return shellQuote(value);
  }
}

/**
 * Sustituye las variables. Cada valor se cita según dónde esté la variable dentro de la plantilla
 * (fuera de comillas, entre comillas simples o dobles), así un valor con espacios o símbolos
 * nunca rompe ni amplía el comando.
 * Variables sin valor se dejan como `{{nombre}}` (para la vista previa) salvo `fillMissing`.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  opts: { fillMissing?: boolean } = {},
): string {
  let out = "";
  let ctx: QuoteCtx = "none";
  let i = 0;
  const re = new RegExp(VAR_RE.source, "y");
  while (i < template.length) {
    if (template.startsWith("{{", i)) {
      re.lastIndex = i;
      const m = re.exec(template);
      if (m) {
        const name = m[1];
        const def = m[2];
        const raw = values[name];
        const value = raw !== undefined && raw !== "" ? raw : def;
        if (value === undefined) {
          out += opts.fillMissing ? quoteFor(ctx, "") : m[0];
        } else {
          out += quoteFor(ctx, value);
        }
        i += m[0].length;
        continue;
      }
    }
    const ch = template[i];
    if (ctx === "none") {
      if (ch === "\\" && i + 1 < template.length) {
        out += ch + template[i + 1];
        i += 2;
        continue;
      }
      if (ch === "'") ctx = "single";
      else if (ch === '"') ctx = "double";
    } else if (ctx === "single") {
      if (ch === "'") ctx = "none";
    } else {
      if (ch === "\\" && i + 1 < template.length) {
        out += ch + template[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') ctx = "none";
    }
    out += ch;
    i++;
  }
  return out;
}

/** Nombres de variables obligatorias sin valor (ni por defecto). */
export function missingVars(template: string, values: Record<string, string>): string[] {
  return parseVars(template)
    .filter((v) => (values[v.name] ?? "") === "" && v.default === undefined)
    .map((v) => v.name);
}

/** "puerto_host" → "puerto host". */
export function varLabel(name: string): string {
  return name.replace(/_/g, " ");
}

// ───────── Búsqueda difusa ─────────

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Puntuación de coincidencia: cada palabra de la consulta debe aparecer (como subcadena o,
 * si no, como subsecuencia) en el texto. Mayor = mejor. null = no coincide.
 */
export function fuzzyScore(query: string, fields: { text: string; weight: number }[]): number | null {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const hay = fields.map((f) => ({ text: normalize(f.text), weight: f.weight }));
  let total = 0;
  for (const w of words) {
    let best: number | null = null;
    for (const f of hay) {
      const idx = f.text.indexOf(w);
      let s: number | null = null;
      if (idx >= 0) {
        s = 10 * f.weight;
        if (idx === 0 || /[\s\-_/.:|]/.test(f.text[idx - 1])) s += 5 * f.weight;
      } else if (subsequence(w, f.text)) {
        s = 2 * f.weight;
      }
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

function subsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}
