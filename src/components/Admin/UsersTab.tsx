// Sub-pestaña «Usuarios»: tabla, filtros y acciones (crear, editar, llaves, bloquear, eliminar).
import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { KeySquare, Lock, LockOpen, Pencil, Search, Trash2, UserPlus } from "lucide-react";
import { daysToDate, deleteUserPlan, lockUserPlan, type UserRow } from "../../features/admin";
import { protectedReason, useAdmin } from "./context";
import { VirtualTable, type Column } from "./VirtualTable";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { PlanModal } from "./PlanReview";
import { UserDialog } from "./UserDialog";
import { KeysDialog } from "./KeysDialog";

type Dialog =
  | { kind: "create" }
  | { kind: "edit"; user: UserRow }
  | { kind: "keys"; user: UserRow }
  | { kind: "lock"; user: UserRow; lock: boolean }
  | { kind: "delete"; user: UserRow };

function lockedCell(u: UserRow) {
  if (u.locked === null) return <span className="faint">—</span>;
  if (u.locked) return <span className="adm-tag adm-tag-red">Bloqueado</span>;
  if (u.shadow?.status === "NP") return <span className="adm-tag adm-tag-yellow">Sin contraseña</span>;
  if (u.shadow?.status === "NL") return <span className="faint">Sin acceso</span>;
  if (u.shadow?.lastChange === 0) return <span className="adm-tag adm-tag-yellow">Cambiar clave</span>;
  return <span className="adm-tag adm-tag-green">Activo</span>;
}

export function UsersTab() {
  const { users, readOnly, me, env } = useAdmin();
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; user: UserRow } | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => showSystem || !u.isSystem)
      .filter(
        (u) =>
          !q ||
          u.name.toLowerCase().includes(q) ||
          u.fullName.toLowerCase().includes(q) ||
          String(u.uid) === q ||
          u.groups.some((g) => g.toLowerCase().includes(q)),
      )
      .sort((a, b) => (a.uid === 0 ? -1 : b.uid === 0 ? 1 : a.uid - b.uid));
  }, [users, query, showSystem]);

  const sel = rows.find((u) => u.name === selected) ?? null;
  const hiddenSystem = users.filter((u) => u.isSystem).length;

  const columns: Column<UserRow>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Usuario",
        width: "minmax(110px, 1.1fr)",
        render: (u) => (
          <span className="adm-name">
            {u.name}
            {u.name === me && <span className="adm-you">tú</span>}
          </span>
        ),
        title: (u) => u.name,
      },
      { key: "full", label: "Nombre completo", width: "minmax(110px, 1.2fr)", render: (u) => u.fullName || <span className="faint">—</span>, title: (u) => u.gecos },
      { key: "uid", label: "UID", width: "58px", align: "right", render: (u) => <span className="mono">{u.uid}</span> },
      { key: "groups", label: "Grupos", width: "minmax(120px, 1.4fr)", render: (u) => u.groups.join(", "), title: (u) => u.groups.join(", ") },
      { key: "shell", label: "Shell", width: "minmax(80px, 0.8fr)", render: (u) => <span className="mono">{u.shell}</span>, title: (u) => u.shell },
      { key: "home", label: "Carpeta", width: "minmax(100px, 1fr)", render: (u) => <span className="mono">{u.home}</span>, title: (u) => u.home },
      {
        key: "last",
        label: "Último acceso",
        width: "118px",
        render: (u) => u.lastLogin ?? <span className="faint">—</span>,
      },
      {
        key: "state",
        label: "Estado",
        width: "104px",
        render: lockedCell,
        title: (u) =>
          u.shadow?.expireDays != null ? `La cuenta caduca el ${daysToDate(u.shadow.expireDays)}` : u.locked === null ? "Hace falta root o sudo para saberlo" : "",
      },
      {
        key: "sudo",
        label: "Admin",
        width: "54px",
        render: (u) => (u.isAdmin ? <span className="adm-tag adm-tag-accent">Sí</span> : <span className="faint">No</span>),
        title: (u) => (u.isAdmin ? (u.uid === 0 ? "root" : "Está en wheel/sudo/admin") : ""),
      },
    ],
    [me],
  );

  const actions = useCallback(
    (u: UserRow): (MenuItem | "sep")[] => {
      const prot = protectedReason(u.name, me);
      const roTitle = readOnly ? "Necesitas root o sudo" : undefined;
      return [
        { label: "Editar…", icon: <Pencil size={14} />, onClick: () => setDialog({ kind: "edit", user: u }), disabled: readOnly, title: roTitle },
        { label: "Llaves SSH…", icon: <KeySquare size={14} />, onClick: () => setDialog({ kind: "keys", user: u }), disabled: readOnly && u.name !== me },
        "sep",
        u.locked
          ? { label: "Desbloquear", icon: <LockOpen size={14} />, onClick: () => setDialog({ kind: "lock", user: u, lock: false }), disabled: readOnly, title: roTitle }
          : {
              label: "Bloquear",
              icon: <Lock size={14} />,
              onClick: () => setDialog({ kind: "lock", user: u, lock: true }),
              disabled: readOnly || !!prot,
              title: prot ?? roTitle,
            },
        {
          label: "Eliminar…",
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => setDialog({ kind: "delete", user: u }),
          disabled: readOnly || !!prot,
          title: prot ?? roTitle,
        },
      ];
    },
    [me, readOnly],
  );

  const onContext = useCallback((e: MouseEvent, u: UserRow) => setMenu({ x: e.clientX, y: e.clientY, user: u }), []);
  const selProt = sel ? protectedReason(sel.name, me) : null;

  return (
    <div className="adm-pane">
      <div className="adm-toolbar">
        <div className="adm-search">
          <Search size={13} />
          <input
            className="input"
            placeholder="Buscar usuario, nombre, grupo o UID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar usuarios"
          />
        </div>
        <label className="checkbox adm-check">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
          Mostrar cuentas del sistema
          {!showSystem && hiddenSystem > 0 && <span className="faint">({hiddenSystem})</span>}
        </label>
        <div className="adm-spacer" />
        <div className="adm-actions" aria-label="Acciones del usuario seleccionado">
          <button className="btn btn-sm" disabled={!sel || readOnly} onClick={() => sel && setDialog({ kind: "edit", user: sel })}>
            <Pencil size={13} /> Editar
          </button>
          <button
            className="btn btn-sm"
            disabled={!sel || (readOnly && sel.name !== me)}
            onClick={() => sel && setDialog({ kind: "keys", user: sel })}
          >
            <KeySquare size={13} /> Llaves SSH
          </button>
          <button
            className="btn btn-sm"
            disabled={!sel || readOnly || (!sel.locked && !!selProt)}
            title={sel && !sel.locked ? (selProt ?? undefined) : undefined}
            onClick={() => sel && setDialog({ kind: "lock", user: sel, lock: !sel.locked })}
          >
            {sel?.locked ? <LockOpen size={13} /> : <Lock size={13} />}
            {sel?.locked ? "Desbloquear" : "Bloquear"}
          </button>
          <button
            className="btn btn-sm adm-btn-danger-soft"
            disabled={!sel || readOnly || !!selProt}
            title={selProt ?? undefined}
            onClick={() => sel && setDialog({ kind: "delete", user: sel })}
          >
            <Trash2 size={13} /> Eliminar
          </button>
        </div>
        <button className="btn btn-sm btn-primary" disabled={readOnly || !env} onClick={() => setDialog({ kind: "create" })}>
          <UserPlus size={13} /> Crear usuario
        </button>
      </div>

      <VirtualTable
        label="Usuarios"
        columns={columns}
        rows={rows}
        rowKey={(u) => u.name}
        selected={selected}
        onSelect={setSelected}
        onActivate={(u) => !readOnly && setDialog({ kind: "edit", user: u })}
        onContextMenu={onContext}
        onKey={(e, u) => {
          if (e.key === "Delete" && !readOnly && !protectedReason(u.name, me)) {
            e.preventDefault();
            setDialog({ kind: "delete", user: u });
          }
        }}
        rowClass={(u) => (u.locked ? "adm-row-muted" : "")}
        placeholder={<span>{query ? "Ningún usuario coincide con la búsqueda" : "No hay usuarios que mostrar"}</span>}
      />
      <div className="adm-statusbar">
        {rows.length} {rows.length === 1 ? "usuario" : "usuarios"}
        {env && (
          <span className="faint">
            · comandos {env.toolset === "shadow" ? "shadow-utils (useradd, usermod…)" : "busybox (adduser, deluser…)"} · grupo de administración «
            {env.adminGroup}»
          </span>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={actions(menu.user)} onClose={() => setMenu(null)} />}

      {dialog?.kind === "create" && <UserDialog mode="create" onClose={() => setDialog(null)} onCreated={(n) => setSelected(n)} />}
      {dialog?.kind === "edit" && <UserDialog mode="edit" user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.kind === "keys" && <KeysDialog user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.kind === "lock" && env && (
        <PlanModal
          title={dialog.lock ? `Bloquear a ${dialog.user.name}` : `Desbloquear a ${dialog.user.name}`}
          plan={lockUserPlan(env, dialog.user.name, dialog.lock)}
          onCancel={() => setDialog(null)}
          onDone={() => setDialog(null)}
          runLabel={dialog.lock ? "Bloquear" : "Desbloquear"}
        >
          <p className="dialog-message">
            {dialog.lock
              ? "La contraseña de la cuenta quedará desactivada (no podrá entrar con contraseña). Las llaves SSH pueden seguir funcionando según la configuración del servidor."
              : "La cuenta podrá volver a entrar con su contraseña."}
          </p>
        </PlanModal>
      )}
      {dialog?.kind === "delete" && env && <DeleteUserDialog user={dialog.user} onClose={() => setDialog(null)} />}
    </div>
  );
}

function DeleteUserDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { env } = useAdmin();
  const [removeHome, setRemoveHome] = useState(false);
  if (!env) return null;
  return (
    <PlanModal
      title={`Eliminar a ${user.name}`}
      plan={deleteUserPlan(env, user.name, removeHome)}
      confirmWord={user.name}
      onCancel={onClose}
      onDone={onClose}
      runLabel="Eliminar"
    >
      <p className="dialog-message">
        Se eliminará la cuenta <strong>{user.name}</strong>
        {user.fullName ? ` (${user.fullName})` : ""}. Esta acción no se puede deshacer.
      </p>
      <label className="checkbox adm-check adm-mb">
        <input type="checkbox" checked={removeHome} onChange={(e) => setRemoveHome(e.target.checked)} />
        Borrar también su carpeta personal (<span className="mono">{user.home}</span>) y su correo
      </label>
    </PlanModal>
  );
}
