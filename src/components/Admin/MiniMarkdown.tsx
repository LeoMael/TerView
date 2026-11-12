// Markdown mínimo para el texto de la IA: títulos, párrafos, listas, bloques de código, `código` y
// **negrita**. Se pinta con elementos de React: nunca se inserta HTML de la respuesta.
import type { ReactNode } from "react";

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; lang: string; text: string };

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      out.push({ kind: "code", lang: fence[2] ?? "", text: code.join("\n") });
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ kind: "h", level: h[1].length, text: h[2].replace(/#+\s*$/, "") });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const kind = /\d/.test(li[1]) ? "ol" : "ul";
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.items.push(li[2]);
      else out.push({ kind, items: [li[2]] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Continuación de un elemento de lista con sangría.
    const last = out[out.length - 1];
    if (!para.length && last && (last.kind === "ul" || last.kind === "ol") && /^\s{2,}\S/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

/** `código` y **negrita**. */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    parts.push(t.startsWith("`") ? <code key={k++}>{t.slice(1, -1)}</code> : <strong key={k++}>{t.slice(2, -2)}</strong>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function MiniMarkdown({ text, codeActions }: { text: string; codeActions?: (code: string) => ReactNode }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="vs-md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h": {
            const H = (b.level <= 2 ? "h4" : "h5") as "h4" | "h5";
            return <H key={i}>{inline(b.text)}</H>;
          }
          case "p":
            return <p key={i}>{inline(b.text)}</p>;
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <div key={i} className="vs-md-code">
                <pre className="mono">{b.text}</pre>
                {codeActions && <div className="vs-md-code-actions">{codeActions(b.text)}</div>}
              </div>
            );
        }
      })}
    </div>
  );
}
