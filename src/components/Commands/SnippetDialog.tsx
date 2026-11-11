// Crear / editar un comando propio ("Mis comandos").
import { useMemo, useState } from "react";
import type { Snippet, SnippetScope } from "../../api/types";
import { Modal } from "../ui/Modal";
import { useProfiles } from "../../stores/profiles";
import { useSnippets } from "./state";
import { parseVars } from "./template";

interface Props {
  /** Snippet a editar (id "" = nuevo). */
  initial: Snippet;
  /** Servidor de la conexión (para "Este servidor" / "Este proyecto"). */
  profileId: string;
  onClose: (saved: Snippet | null) => void;
}

export function emptySnippet(): Snippet {
  return {
    id: "",
    name: "",
    description: null,
    command: "",
    category: "Mis comandos",
    scope: "global",
    scopeId: null,
    dangerous: false,
    sudo: false,
    readOnly: false,
  };
}

export function SnippetDialog({ initial, profileId, onClose }: Props) {
  const save = useSnippets((s) => s.save);
  const mine = useSnippets((s) => s.list);
  const projects = useProfiles((s) => s.projects);
  const servers = useProfiles((s) => s.servers);
  const myProjects = useMemo(() => projects.filter((p) => p.serverIds.includes(profileId)), [projects, profileId]);
  const thisServer = servers.find((s) => s.id === profileId);

  const [s, setS] = useState<Snippet>(initial);
  const [projectId, setProjectId] = useState<string>(
    initial.scope === "project" && initial.scopeId ? initial.scopeId : (myProjects[0]?.id ?? ""),
  );
  const [sudoTouched, setSudoTouched] = useState(initial.id !== "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const categories = useMemo(
    () => Array.from(new Set(["Mis comandos", ...mine.map((m) => m.category)])).sort(),
    [mine],
  );
  const vars = useMemo(() => parseVars(s.command), [s.command]);

  const setScope = (scope: SnippetScope) => setS((x) => ({ ...x, scope }));

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!s.name.trim()) errs.name = "Ponle un nombre";
    if (!s.command.trim()) errs.command = "Escribe el comando";
    let scopeId: string | null = null;
    if (s.scope === "server") scopeId = profileId;
    if (s.scope === "project") {
      scopeId = projectId || null;
      if (!scopeId) errs.scope = "Este servidor no pertenece a ningún proyecto";
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    const saved = await save({
      ...s,
      name: s.name.trim(),
      command: s.command.trim(),
      description: s.description?.trim() ? s.description.trim() : null,
      category: s.category.trim() || "Mis comandos",
      scopeId: s.scope === "global" ? null : scopeId,
    });
    setSaving(false);
    if (saved) onClose(saved);
  };

  return (
    <Modal
      open
      width={560}
      title={initial.id ? "Editar comando" : "Nuevo comando"}
      onClose={() => onClose(null)}
      footer={
        <>
          <button className="btn" onClick={() => onClose(null)}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={submit}>
            {initial.id ? "Guardar" : "Crear comando"}
          </button>
        </>
      }
    >
      <div className="cmd-form">
        <label className="field">
          <span>Nombre</span>
          <input
            className="input"
            autoFocus
            value={s.name}
            placeholder="Reiniciar la API"
            onChange={(e) => setS({ ...s, name: e.target.value })}
          />
        </label>
        {errors.name && <div className="field-error">{errors.name}</div>}

        <label className="field">
          <span>Descripción (opcional)</span>
          <input
            className="input"
            value={s.description ?? ""}
            placeholder="Qué hace y cuándo usarlo"
            onChange={(e) => setS({ ...s, description: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Comando</span>
          <textarea
            className="textarea mono cmd-form-command"
            rows={4}
            spellCheck={false}
            value={s.command}
            placeholder="podman logs -f --tail {{lineas:100}} {{contenedor}}"
            onChange={(e) => {
              const command = e.target.value;
              setS((x) => ({ ...x, command, sudo: sudoTouched ? x.sudo : /(^|[\s;&|(])sudo\s/.test(command) }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        {errors.command && <div className="field-error">{errors.command}</div>}
        <div className="cmd-form-hint">
          Variables: <code>{"{{nombre}}"}</code> o con valor por defecto <code>{"{{lineas:200}}"}</code>. Los valores se
          citan solos al ejecutar.
          {vars.length > 0 && (
            <div className="cmd-form-vars">
              {vars.map((v) => (
                <span key={v.name} className="cmd-tag">
                  {v.name}
                  {v.default !== undefined ? ` = ${v.default}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>

        <label className="field">
          <span>Categoría</span>
          <input
            className="input"
            list="cmd-categories"
            value={s.category}
            onChange={(e) => setS({ ...s, category: e.target.value })}
          />
          <datalist id="cmd-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>

        <div className="field">
          <span>Disponible en</span>
          <div className="cmd-scope">
            <label className="checkbox">
              <input type="radio" checked={s.scope === "global"} onChange={() => setScope("global")} />
              Todos los servidores
            </label>
            <label className="checkbox">
              <input
                type="radio"
                checked={s.scope === "project"}
                disabled={myProjects.length === 0}
                onChange={() => setScope("project")}
              />
              Este proyecto
              {s.scope === "project" && myProjects.length > 0 && (
                <select className="select cmd-scope-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {myProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              {myProjects.length === 0 && <span className="faint">(este servidor no está en ningún proyecto)</span>}
            </label>
            <label className="checkbox">
              <input type="radio" checked={s.scope === "server"} onChange={() => setScope("server")} />
              Este servidor
              {thisServer && <span className="faint">({thisServer.name})</span>}
            </label>
          </div>
          {errors.scope && <div className="field-error">{errors.scope}</div>}
        </div>

        <div className="cmd-flags">
          <label className="checkbox">
            <input type="checkbox" checked={s.dangerous} onChange={(e) => setS({ ...s, dangerous: e.target.checked })} />
            <span>Peligroso <span className="faint">(pide confirmación)</span></span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={s.sudo}
              onChange={(e) => {
                setSudoTouched(true);
                setS({ ...s, sudo: e.target.checked });
              }}
            />
            <span>Usa sudo</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={s.readOnly} onChange={(e) => setS({ ...s, readOnly: e.target.checked })} />
            <span>Solo lectura</span>
          </label>
        </div>
      </div>
    </Modal>
  );
}
