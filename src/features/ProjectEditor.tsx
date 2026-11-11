// Diálogo «Nuevo proyecto / Editar proyecto», ligado a useUi().projectEditor.
import { useEffect, useRef, useState } from "react";
import { Folder, Plus, Trash2 } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import type { Bookmark, Project } from "../api/types";
import { useProfiles } from "../stores/profiles";
import { useUi } from "../stores/ui";
import { ColorPicker } from "./ColorPicker";

export function ProjectEditorHost() {
  const editor = useUi((s) => s.projectEditor);
  const close = useUi((s) => s.closeProjectEditor);
  if (!editor) return null;
  return <ProjectEditor key={editor.project?.id || "new"} initial={editor.project} onClose={close} />;
}

interface BookmarkDraft extends Bookmark {
  key: number;
}

let draftKey = 0;

function ProjectEditor({ initial, onClose }: { initial: Project | null; onClose: () => void }) {
  const isNew = !initial || initial.id === "";
  const servers = useProfiles((s) => s.servers);
  const saveProject = useProfiles((s) => s.saveProject);

  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [serverIds, setServerIds] = useState<string[]>(initial?.serverIds ?? []);
  const [bookmarks, setBookmarks] = useState<BookmarkDraft[]>(
    (initial?.bookmarks ?? []).map((b) => ({ ...b, key: ++draftKey })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const toggleServer = (id: string, on: boolean) =>
    setServerIds((ids) => (on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id)));

  const updateBookmark = (key: number, patch: Partial<Bookmark>) =>
    setBookmarks((list) => list.map((b) => (b.key === key ? { ...b, ...patch } : b)));

  const addBookmark = () => {
    const serverId = serverIds[0] ?? servers[0]?.id ?? "";
    if (serverId) toggleServer(serverId, true);
    setBookmarks((list) => [...list, { key: ++draftKey, serverId, path: "", label: null }]);
  };

  const save = async () => {
    if (!name.trim()) {
      setError("Indica un nombre");
      nameRef.current?.focus();
      return;
    }
    const cleanBookmarks: Bookmark[] = bookmarks
      .filter((b) => b.serverId && b.path.trim())
      .map((b) => ({ serverId: b.serverId, path: b.path.trim(), label: b.label?.trim() || null }));
    setSaving(true);
    const saved = await saveProject({
      id: initial?.id ?? "",
      name: name.trim(),
      color,
      serverIds,
      bookmarks: cleanBookmarks,
    });
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <Modal
      open
      title={isNew ? "Nuevo proyecto" : "Editar proyecto"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            Guardar
          </button>
        </>
      }
    >
      <div className="field-row">
        <label className="field cd-grow">
          <span>Nombre</span>
          <input
            ref={nameRef}
            className="input"
            value={name}
            placeholder="p. ej. Cliente X"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          {error && <div className="cd-err">{error}</div>}
        </label>
      </div>

      <div className="field">
        <span>Color</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>

      <div className="field">
        <span>Servidores</span>
        {servers.length === 0 ? (
          <div className="cd-hint">Aún no tienes servidores guardados.</div>
        ) : (
          <div className="cd-checklist">
            {servers.map((s) => (
              <label key={s.id} className="checkbox cd-checklist-row">
                <input
                  type="checkbox"
                  checked={serverIds.includes(s.id)}
                  onChange={(e) => toggleServer(s.id, e.target.checked)}
                />
                <span className="cd-checklist-name">{s.name}</span>
                <span className="faint mono cd-checklist-sub">
                  {s.username}@{s.host}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <span>Marcadores (carpetas favoritas)</span>
        {bookmarks.length > 0 && (
          <div className="cd-bookmarks">
            {bookmarks.map((b) => (
              <div key={b.key} className="cd-bookmark-row">
                <Folder size={14} className="cd-folder-icon" />
                <select
                  className="select cd-bm-server"
                  value={b.serverId}
                  aria-label="Servidor"
                  onChange={(e) => {
                    updateBookmark(b.key, { serverId: e.target.value });
                    toggleServer(e.target.value, true);
                  }}
                >
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <input
                  className="input mono cd-bm-path"
                  value={b.path}
                  placeholder="/var/www/app"
                  aria-label="Ruta"
                  spellCheck={false}
                  onChange={(e) => updateBookmark(b.key, { path: e.target.value })}
                />
                <input
                  className="input cd-bm-label"
                  value={b.label ?? ""}
                  placeholder="Etiqueta"
                  aria-label="Etiqueta"
                  onChange={(e) => updateBookmark(b.key, { label: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Quitar marcador"
                  title="Quitar marcador"
                  onClick={() => setBookmarks((list) => list.filter((x) => x.key !== b.key))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div>
          <button type="button" className="btn btn-sm" onClick={addBookmark} disabled={servers.length === 0}>
            <Plus size={14} /> Añadir marcador
          </button>
        </div>
      </div>
    </Modal>
  );
}
