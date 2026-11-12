// Mini-intérprete de Markdown para el historial de cambios (sin dependencias).
// Soporta: encabezados (#…####), listas con guion o asterisco (con líneas de continuación y un nivel
// de anidado), párrafos, **negrita**, *cursiva*, `código` y [enlaces](https://…).
import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: { text: string; children: string[] }[] }
  | { type: "para"; text: string };

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { text: string; children: string[] }[] | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: "para", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "list", items: list });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushPara();
      // Una línea en blanco no corta la lista si sigue otro elemento; se decide en la siguiente línea.
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const nested = li[1].length >= 2;
      if (!list) list = [];
      if (nested && list.length) list[list.length - 1].children.push(li[2]);
      else list.push({ text: li[2], children: [] });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // Continuación del último elemento (o de su último hijo).
      const last = list[list.length - 1];
      if (last.children.length) last.children[last.children.length - 1] += " " + line.trim();
      else last.text += " " + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

/** Formato en línea: `código`, **negrita**, *cursiva* y [texto](url). */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Sin «lookbehind» (no existe en WebKit antiguos): el carácter previo a la cursiva va capturado en m[5].
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;
  let last = 0;
  let key = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={key++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key++}>{renderInline(m[2])}</strong>);
    else if (m[3] !== undefined) out.push(<Link key={key++} href={m[4]} label={m[3]} />);
    else if (m[6] !== undefined) {
      if (m[5]) out.push(m[5]);
      out.push(<em key={key++}>{renderInline(m[6])}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, label }: { href: string; label: string }) {
  if (!/^https?:\/\//i.test(href)) return <>{renderInline(label)}</>;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(href);
      }}
    >
      {renderInline(label)}
    </a>
  );
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={className}>{renderBlocks(parseMarkdown(source))}</div>;
}

export function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((b, i) => {
    if (b.type === "heading") {
      const Tag = (["h3", "h3", "h4", "h5"] as const)[b.level - 1];
      return <Tag key={i}>{renderInline(b.text)}</Tag>;
    }
    if (b.type === "list") {
      return (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j}>
              {renderInline(it.text)}
              {it.children.length > 0 && (
                <ul>
                  {it.children.map((c, k) => (
                    <li key={k}>{renderInline(c)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      );
    }
    return <p key={i}>{renderInline(b.text)}</p>;
  });
}

export interface ChangelogRelease {
  /** "0.3.0" o "Sin publicar". */
  version: string;
  date: string | null;
  body: string;
}

/** Divide el CHANGELOG en versiones (encabezados `## [x.y.z] - fecha`). Ignora la introducción. */
export function splitChangelog(src: string): ChangelogRelease[] {
  const out: ChangelogRelease[] = [];
  let cur: ChangelogRelease | null = null;
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^##\s+\[?([^\]\s]+(?:\s[^\]]+)?)\]?(?:\s*-\s*(.+))?\s*$/.exec(line);
    if (m && !line.startsWith("###")) {
      cur = { version: m[1], date: m[2]?.trim() ?? null, body: "" };
      out.push(cur);
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  return out.map((r) => ({ ...r, body: r.body.trim() }));
}
