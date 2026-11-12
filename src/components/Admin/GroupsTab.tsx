// Sub-pestaña «Grupos»: lista con miembros; crear, renombrar, eliminar, añadir/quitar miembros.
import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { Pencil, Plus, Search, Trash2, UserMinus, UserPlus, UsersRound } from "lucide-react";
import {
  addMembersPlan,
  createGroupPlan,
  deleteGroupPlan,
  isSystemGroup,
  removeMemberPlan,
  renameGroupPlan,
  validateName,
  type GroupEntry,
  type Plan,
} from "../../features/admin";
import { useAdmin } from "./context";
import { VirtualTable, type Column } from "./VirtualTable";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { AdmModal } from "./AdmModal";
import { PlanModal, PlanReview } from "./PlanReview";

interface GroupRow extends GroupEntry {
  /** Usuarios cuyo grupo principal es este. */
  primaryOf: string[];
  isSystem: boolean;
}

type Dialog =
  | { kind: "create" }
  | { kind: "rename"; group: GroupRow }
  | { kind: "delete"; group: GroupRow }
  | { kind: "members"; group: string };

export function GroupsTab() {
  const { read, readOnly, env } = useAdmin();
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; group: GroupRow } | null>(null);

  const all: GroupRow[] = useMemo(() => {
    if (!read) return [];
    const primary = new Map<number, string[]>();
    for (const p of read.passwd) primary.set(p.gid, [...(primary.get(p.gid) ?? []), p.name]);
    return read.groups.map((g) => ({ ...g, primaryOf: primary.get(g.gid) ?? [], isSystem: isSystemGroup(g) }));
  }, [read]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((g) => showSystem || !g.isSystem)
      .filter((g) => !q || g.name.includes(q) || String(g.gid) === q || g.members.some((m) => m.includes(q)))
      .sort((a, b) => a.gid - b.gid);
  }, [all, query, showSystem]);

  const sel = rows.find((g) => g.name === selected) ?? null;
  const hiddenSystem = all.filter((g) => g.isSystem).length;

  const columns: Column<GroupRow>[] = useMemo(
    () => [
      { key: "name", label: "Grupo", width: "minmax(120px, 1fr)", render: (g) => <span className="adm-name">{g.name}</span>, title: (g) => g.name },
      { key: "gid", label: "GID", width: "64px", align: "right", render: (g) => <span className="mono">{g.gid}</span> },
      {
        key: "members",
        label: "Miembros",
        width: "minmax(160px, 2fr)",
        render: (g) => (g.members.length ? g.members.join(", ") : <span className="faint">—</span>),
        title: (g) => g.members.join(", "),
      },
      {
        key: "primary",
        label: "Grupo principal de",
        width: "minmax(120px, 1fr)",
        render: (g) => (g.primaryOf.length ? <span className="muted">{g.primaryOf.join(", ")}</span> : <span className="faint">—</span>),
        title: (g) => g.primaryOf.join(", "),
      },
    ],
    [],
  );

  const actions = useCallback(
    (g: GroupRow): (MenuItem | "sep")[] => [
      { label: "Miembros…", icon: <UsersRound size={14} />, onClick: () => setDialog({ kind: "members", group: g.name }) },
      {
        label: "Renombrar…",
        icon: <Pencil size={14} />,
        onClick: () => setDialog({ kind: "rename", group: g }),
        disabled: readOnly || !env?.canRenameGroup,
        title: !env?.canRenameGroup ? "Hace falta groupmod (shadow-utils)" : undefined,
      },
      "sep",
      { label: "Eliminar…", icon: <Trash2 size={14} />, danger: true, onClick: () => setDialog({ kind: "delete", group: g }), disabled: readOnly },
    ],
    [readOnly, env],
  );

  const onContext = useCallback((e: MouseEvent, g: GroupRow) => setMenu({ x: e.clientX, y: e.clientY, group: g }), []);

  return (
    <div className="adm-pane">
      <div className="adm-toolbar">
        <div className="adm-search">
          <Search size={13} />
          <input
            className="input"
            placeholder="Buscar grupo, miembro o GID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar grupos"
          />
        </div>
        <label className="checkbox adm-check">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
          Mostrar grupos del sistema
          {!showSystem && hiddenSystem > 0 && <span className="faint">({hiddenSystem})</span>}
        </label>
        <div className="adm-spacer" />
        <div className="adm-actions">
          <button className="btn btn-sm" disabled={!sel} onClick={() => sel && setDialog({ kind: "members", group: sel.name })}>
            <UsersRound size={13} /> Miembros
          </button>
          <button
            className="btn btn-sm"
            disabled={!sel || readOnly || !env?.canRenameGroup}
            title={env && !env.canRenameGroup ? "Hace falta groupmod (shadow-utils)" : undefined}
            onClick={() => sel && setDialog({ kind: "rename", group: sel })}
          >
            <Pencil size={13} /> Renombrar
          </button>
          <button
            className="btn btn-sm adm-btn-danger-soft"
            disabled={!sel || readOnly}
            onClick={() => sel && setDialog({ kind: "delete", group: sel })}
          >
            <Trash2 size={13} /> Eliminar
          </button>
        </div>
        <button className="btn btn-sm btn-primary" disabled={readOnly || !env} onClick={() => setDialog({ kind: "create" })}>
          <Plus size={13} /> Crear grupo
        </button>
      </div>

      <VirtualTable
        label="Grupos"
        columns={columns}
        rows={rows}
        rowKey={(g) => g.name}
        selected={selected}
        onSelect={setSelected}
        onActivate={(g) => setDialog({ kind: "members", group: g.name })}
        onContextMenu={onContext}
        onKey={(e, g) => {
          if (e.key === "Delete" && !readOnly) {
            e.preventDefault();
            setDialog({ kind: "delete", group: g });
          }
        }}
        placeholder={<span>{query ? "Ningún grupo coincide con la búsqueda" : "No hay grupos que mostrar"}</span>}
      />
      <div className="adm-statusbar">
        {rows.length} {rows.length === 1 ? "grupo" : "grupos"}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={actions(menu.group)} onClose={() => setMenu(null)} />}
      {dialog?.kind === "create" && (
        <NameDialog
          title="Crear grupo"
          label="Nombre del grupo"
          existing={all.map((g) => g.name)}
          makePlan={(n) => (env ? createGroupPlan(env, n) : null)}
          onClose={() => setDialog(null)}
          onDone={(n) => setSelected(n)}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`Renombrar «${dialog.group.name}»`}
          label="Nuevo nombre"
          initial={dialog.group.name}
          existing={all.map((g) => g.name)}
          makePlan={(n) => renameGroupPlan(dialog.group.name, n)}
          onClose={() => setDialog(null)}
          onDone={(n) => setSelected(n)}
        />
      )}
      {dialog?.kind === "delete" && env && (
        <PlanModal
          title={`Eliminar el grupo ${dialog.group.name}`}
          plan={deleteGroupPlan(env, dialog.group.name)}
          confirmWord={dialog.group.name}
          onCancel={() => setDialog(null)}
          onDone={() => setDialog(null)}
          runLabel="Eliminar"
        >
          <p className="dialog-message">
            Se eliminará el grupo <strong>{dialog.group.name}</strong>. Los archivos que le pertenecen quedarán con un GID
            sin nombre ({dialog.group.gid}).
          </p>
          {dialog.group.primaryOf.length > 0 && (
            <div className="adm-note adm-note-warn">
              Es el grupo principal de {dialog.group.primaryOf.join(", ")}: el sistema no dejará eliminarlo mientras lo sea.
            </div>
          )}
        </PlanModal>
      )}
      {dialog?.kind === "members" && <MembersDialog groupName={dialog.group} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Diálogo con un nombre (crear/renombrar grupo) → revisión del comando. */
function NameDialog(p: {
  title: string;
  label: string;
  initial?: string;
  existing: string[];
  makePlan: (name: string) => Plan | null;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState(p.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);

  if (plan) {
    return (
      <AdmModal title={p.title} onClose={p.onClose} width={540}>
        <PlanReview
          plan={plan}
          onBack={() => setPlan(null)}
          onCancel={p.onClose}
          onDone={() => {
            p.onDone(name);
            p.onClose();
          }}
        />
      </AdmModal>
    );
  }
  const submit = () => {
    const e = validateName(name, "grupo") ?? (p.existing.includes(name) ? "Ya existe un grupo con ese nombre" : null);
    if (e) return setError(e);
    const pl = p.makePlan(name);
    if (pl) setPlan(pl);
  };
  return (
    <AdmModal title={p.title} onClose={p.onClose} width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="modal-body">
          <label className="field">
            <span>{p.label}</span>
            <input
              className="input mono"
              value={name}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              maxLength={32}
              onChange={(e) => {
                setName(e.target.value.toLowerCase());
                setError(null);
              }}
              aria-invalid={!!error}
            />
          </label>
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={p.onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name || name === p.initial}>
            Revisar comando…
          </button>
        </div>
      </form>
    </AdmModal>
  );
}

/** Miembros de un grupo: quitar uno o añadir varios. Se relee el grupo tras cada cambio. */
function MembersDialog({ groupName, onClose }: { groupName: string; onClose: () => void }) {
  const { read, readOnly, env } = useAdmin();
  const group = read?.groups.find((g) => g.name === groupName) ?? null;
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const title = `Miembros de ${groupName}`;

  if (plan) {
    return (
      <AdmModal title={title} onClose={onClose} width={560}>
        <PlanReview
          plan={plan}
          onBack={() => setPlan(null)}
          onCancel={() => setPlan(null)}
          onDone={() => {
            setPlan(null);
            setToAdd(new Set());
          }}
        />
      </AdmModal>
    );
  }

  const candidates = (read?.passwd ?? [])
    .filter((u) => group && !group.members.includes(u.name))
    .filter((u) => !filter || u.name.includes(filter.toLowerCase()))
    .sort((a, b) => Number(a.uid !== 0 && a.uid < 1000) - Number(b.uid !== 0 && b.uid < 1000) || a.name.localeCompare(b.name));

  return (
    <AdmModal title={title} onClose={onClose} width={560}>
      <div className="modal-body">
        {!group ? (
          <div className="adm-note">El grupo ya no existe.</div>
        ) : (
          <>
            <div className="adm-field-label">Miembros ({group.members.length})</div>
            {group.members.length === 0 ? (
              <div className="adm-note">Sin miembros adicionales.</div>
            ) : (
              <ul className="adm-members">
                {group.members.map((m) => (
                  <li key={m}>
                    <span className="mono">{m}</span>
                    <button
                      className="btn btn-sm"
                      disabled={readOnly || !env}
                      onClick={() => env && setPlan(removeMemberPlan(env, groupName, m))}
                    >
                      <UserMinus size={13} /> Quitar
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <div className="adm-mt">
                <div className="adm-field-label">Añadir usuarios</div>
                <input
                  className="input"
                  placeholder="Filtrar usuarios"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Filtrar usuarios"
                />
                <div className="adm-groups-list" role="group" aria-label="Usuarios para añadir">
                  {candidates.map((u) => (
                    <label key={u.name} className="checkbox adm-check">
                      <input
                        type="checkbox"
                        checked={toAdd.has(u.name)}
                        onChange={(e) => {
                          const n = new Set(toAdd);
                          if (e.target.checked) n.add(u.name);
                          else n.delete(u.name);
                          setToAdd(n);
                        }}
                      />
                      <span className="mono">{u.name}</span>
                      {u.fullName && <span className="faint">{u.fullName}</span>}
                    </label>
                  ))}
                  {!candidates.length && <div className="faint adm-pad">No hay más usuarios</div>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
        {!readOnly && (
          <button
            className="btn btn-primary"
            disabled={!toAdd.size || !env || !group}
            onClick={() => env && setPlan(addMembersPlan(env, groupName, [...toAdd]))}
          >
            <UserPlus size={13} /> Añadir {toAdd.size || ""}…
          </button>
        )}
      </div>
    </AdmModal>
  );
}
