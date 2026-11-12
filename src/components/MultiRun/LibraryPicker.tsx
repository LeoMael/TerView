// Elegir un comando de la biblioteca (catálogo + "Mis comandos", solo lectura).
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { snippets } from "../../api/snippets";
import { errorMessage } from "../../api/core";
import type { Snippet } from "../../api/types";
import { CATALOG, DISTRO_LABEL, type CatalogEntry } from "../Commands/catalog";
import { fuzzyScore } from "../Commands/template";

export interface LibraryChoice {
  command: string;
  label: string;
  dangerous: boolean;
  sudo: boolean;
}

interface Item {
  id: string;
  category: string;
  group: string;
  name: string;
  description: string;
  command: string;
  dangerous: boolean;
  sudo: boolean;
  readOnly: boolean;
  interactive: boolean;
  distro: string | null;
}

const MINE = "Mis comandos";

function fromEntry(e: CatalogEntry): Item {
  return {
    id: e.id,
    category: e.category,
    group: e.group,
    name: e.name,
    description: e.description ?? "",
    command: e.command,
    dangerous: e.dangerous,
    sudo: e.sudo,
    readOnly: e.readOnly,
    interactive: !!e.interactive,
    distro: e.distro ? DISTRO_LABEL[e.distro] : null,
  };
}

function fromSnippet(s: Snippet): Item {
  return {
    id: `my.${s.id}`,
    category: MINE,
    group: s.category || MINE,
    name: s.name,
    description: s.description ?? "",
    command: s.command,
    dangerous: s.dangerous,
    sudo: s.sudo,
    readOnly: s.readOnly,
    interactive: false,
    distro: null,
  };
}

// "Mis comandos" se lee una vez por apertura de la app (no cambia mientras el panel está abierto).
let mineCache: Snippet[] | null = null;

export function LibraryPicker({ onPick, onClose }: { onPick: (c: LibraryChoice) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState<Snippet[] | null>(mineCache);
  const [mineError, setMineError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let alive = true;
    snippets
      .load()
      .then((list) => {
        mineCache = list;
        if (alive) setMine(list);
      })
      .catch((e: unknown) => {
        if (alive) {
          setMine((m) => m ?? []);
          setMineError(errorMessage(e));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const all = useMemo(() => [...(mine ?? []).map(fromSnippet), ...CATALOG.map(fromEntry)], [mine]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return all;
    const scored: { item: Item; score: number }[] = [];
    for (const item of all) {
      const score = fuzzyScore(q, [
        { text: item.name, weight: 3 },
        { text: item.command, weight: 2 },
        { text: `${item.category} ${item.group}`, weight: 1.5 },
        { text: item.description, weight: 1 },
      ]);
      if (score !== null) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }, [all, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (it: Item) => {
    if (it.interactive) return;
    onPick({ command: it.command, label: it.name, dangerous: it.dangerous, sudo: it.sudo });
  };

  const grouped = !query.trim();
  let lastHead = "";

  return (
    <div
      className="mr-lib"
      data-mr-own-escape
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((a) => Math.min(results.length - 1, a + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === "Enter" && results[active]) {
          e.preventDefault();
          pick(results[active]);
        }
      }}
    >
      <div className="mr-lib-head">
        <div className="mr-search mr-grow">
          <Search size={13} className="mr-search-icon" />
          <input
            ref={inputRef}
            className="input"
            value={query}
            placeholder="Buscar en la biblioteca (nombre, comando, categoría)"
            aria-label="Buscar comando"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Cerrar biblioteca" title="Cerrar (Esc)">
          <X size={15} />
        </button>
      </div>
      {mineError && <div className="mr-lib-note">No se pudieron cargar «Mis comandos»: {mineError}</div>}
      <div className="mr-lib-list" ref={listRef} role="listbox" aria-label="Comandos">
        {results.length === 0 && <div className="mr-empty">Sin resultados</div>}
        {results.slice(0, 300).map((it, i) => {
          const head = `${it.category} · ${it.group}`;
          const showHead = grouped && head !== lastHead;
          lastHead = head;
          return (
            <div key={it.id}>
              {showHead && <div className="mr-lib-group">{head}</div>}
              <button
                data-idx={i}
                role="option"
                aria-selected={i === active}
                aria-disabled={it.interactive || undefined}
                className={`mr-lib-item${i === active ? " active" : ""}${it.interactive ? " disabled" : ""}`}
                title={it.interactive ? "Interactivo o no termina: solo sirve en la terminal" : it.description || it.command}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => pick(it)}
              >
                <span className="mr-lib-name">
                  {it.name}
                  {!grouped && <span className="mr-lib-cat">{it.category}</span>}
                  {it.dangerous && <span className="mr-tag danger">peligroso</span>}
                  {it.sudo && <span className="mr-tag warn">sudo</span>}
                  {it.readOnly && <span className="mr-tag">solo lectura</span>}
                  {it.interactive && <span className="mr-tag">interactivo</span>}
                  {it.distro && <span className="mr-tag">{it.distro}</span>}
                </span>
                <span className="mr-lib-cmd mono">{it.command}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
