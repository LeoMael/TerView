// Crear o editar un usuario: formulario → revisión del comando exacto → ejecución.
import { useMemo, useState } from "react";
import { Copy, Eye, EyeOff, Sparkles } from "lucide-react";
import {
  ADMIN_GROUP_NAMES,
  createUserPlan,
  daysToDate,
  editUserPlan,
  generatePassword,
  isSystemGroup,
  parsePublicKey,
  validateDate,
  validateFullName,
  validateName,
  validatePassword,
  validateShell,
  type Plan,
  type UserRow,
} from "../../features/admin";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { useAdmin } from "./context";
import { AdmModal } from "./AdmModal";
import { PlanReview } from "./PlanReview";

async function copyText(text: string) {
  try {
    await clipboard.write(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

/** Campo de contraseña con «Generar segura», mostrar y copiar. */
function PasswordField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [show, setShow] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="adm-pass">
        <input
          className="input mono"
          type={show ? "text" : "password"}
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() => setShow((s) => !s)}
          title={show ? "Ocultar" : "Mostrar"}
          aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={!value}
          onClick={() =>
            copyText(value).then(
              () => toast.success("Contraseña copiada"),
              (e) => toast.error("No se pudo copiar", e),
            )
          }
          title="Copiar"
          aria-label="Copiar contraseña"
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
        >
          <Sparkles size={13} /> Generar segura
        </button>
      </div>
    </label>
  );
}

/** Lista de grupos con casillas y filtro. */
function GroupPicker({ groups, value, onChange }: { groups: string[]; value: Set<string>; onChange: (v: Set<string>) => void }) {
  const [filter, setFilter] = useState("");
  const shown = groups.filter((g) => !filter || g.includes(filter.toLowerCase()));
  return (
    <div className="adm-groups-picker">
      <input
        className="input"
        placeholder="Filtrar grupos"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Filtrar grupos"
      />
      <div className="adm-groups-list" role="group" aria-label="Grupos">
        {shown.map((g) => (
          <label key={g} className="checkbox adm-check">
            <input
              type="checkbox"
              checked={value.has(g)}
              onChange={(e) => {
                const n = new Set(value);
                if (e.target.checked) n.add(g);
                else n.delete(g);
                onChange(n);
              }}
            />
            <span className="mono">{g}</span>
          </label>
        ))}
        {!shown.length && <div className="faint adm-pad">Sin grupos</div>}
      </div>
    </div>
  );
}

type Props = { mode: "create"; onClose: () => void; onCreated?: (name: string) => void } | { mode: "edit"; user: UserRow; onClose: () => void };

export function UserDialog(props: Props) {
  const { env, read, users } = useAdmin();
  const editing = props.mode === "edit" ? props.user : null;
  const adminGroup = env?.adminGroup ?? "wheel";

  const shells = useMemo(() => {
    const list = [...(read?.shells ?? [])];
    if (!list.length) list.push("/bin/sh");
    if (editing && !list.includes(editing.shell)) list.unshift(editing.shell);
    for (const s of ["/sbin/nologin", "/usr/sbin/nologin"]) {
      if (!list.includes(s) && read?.passwd.some((p) => p.shell === s)) list.push(s);
    }
    return list;
  }, [read, editing]);
  const defaultShell = shells.find((s) => s.endsWith("/bash")) ?? shells.find((s) => s.endsWith("/sh")) ?? shells[0] ?? "/bin/sh";

  // Grupos elegibles: todos menos el de administración (casilla aparte) y el principal del usuario.
  const groupNames = useMemo(() => {
    const all = read?.groups ?? [];
    const norm = all.filter((g) => g.name !== adminGroup && g.name !== editing?.primaryGroup);
    const people = norm.filter((g) => !isSystemGroup(g)).map((g) => g.name);
    const system = norm.filter((g) => isSystemGroup(g)).map((g) => g.name);
    return [...people.sort(), ...system.sort()];
  }, [read, adminGroup, editing]);

  const [name, setName] = useState(editing?.name ?? "");
  const [fullName, setFullName] = useState(editing?.fullName ?? "");
  const [changePass, setChangePass] = useState(!editing);
  const [password, setPassword] = useState("");
  const [shell, setShell] = useState(editing?.shell ?? defaultShell);
  const [createHome, setCreateHome] = useState(true);
  const initialGroups = useMemo(
    () => new Set((editing?.extraGroups ?? []).filter((g) => g !== adminGroup)),
    [editing, adminGroup],
  );
  const [groups, setGroups] = useState<Set<string>>(initialGroups);
  const initialAdmin = editing ? editing.groups.includes(adminGroup) : false;
  const [admin, setAdmin] = useState(initialAdmin);
  const [publicKey, setPublicKey] = useState("");
  const [forceChange, setForceChange] = useState(false);
  const initialExpire = editing?.shadow?.expireDays != null ? daysToDate(editing.shadow.expireDays) : "";
  const [expire, setExpire] = useState(initialExpire);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [noChanges, setNoChanges] = useState(false);

  if (!env) return null;
  const canEditInfo = !editing || env.canUsermod;
  const otherAdmin = editing?.groups.filter((g) => ADMIN_GROUP_NAMES.includes(g) && g !== adminGroup) ?? [];

  const review = () => {
    const errs: Record<string, string> = {};
    if (!editing) {
      const e = validateName(name);
      if (e) errs.name = e;
      else if (users.some((u) => u.name === name)) errs.name = "Ya existe un usuario con ese nombre";
      else if (read?.groups.some((g) => g.name === name) && env.toolset === "shadow")
        errs.name = "Ya existe un grupo con ese nombre (useradd crea uno igual para el usuario)";
    }
    const fe = validateFullName(fullName);
    if (fe) errs.fullName = fe;
    if (changePass) {
      const pe = validatePassword(password);
      if (pe) errs.password = pe;
    }
    const se = validateShell(shell);
    if (se) errs.shell = se;
    let key = "";
    if (!editing && publicKey.trim()) {
      const k = parsePublicKey(publicKey);
      if (!k.ok) errs.key = k.error;
      else key = k.line;
    }
    if (editing && expire && expire !== initialExpire) {
      const de = validateDate(expire);
      if (de) errs.expire = de;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;

    if (!editing) {
      setPlan(
        createUserPlan(env, {
          name,
          fullName: fullName.trim(),
          password,
          shell,
          createHome,
          groups: [...groups],
          admin,
          publicKey: key,
          forceChange: forceChange && env.canChage,
        }),
      );
      return;
    }
    const addGroups = [...groups].filter((g) => !initialGroups.has(g));
    const removeGroups = [...initialGroups].filter((g) => !groups.has(g));
    if (admin && !initialAdmin) addGroups.push(adminGroup);
    if (!admin && initialAdmin) removeGroups.push(adminGroup);
    const p = editUserPlan(env, {
      name: editing.name,
      fullName: env.canUsermod && fullName.trim() !== editing.fullName ? fullName.trim() : undefined,
      shell: env.canUsermod && shell !== editing.shell ? shell : undefined,
      password: changePass ? password : undefined,
      addGroups,
      removeGroups,
      expire: env.canChage && expire !== initialExpire ? expire : undefined,
      forceChange: forceChange && env.canChage,
    });
    if (!p) {
      setNoChanges(true);
      return;
    }
    setPlan(p);
  };

  const title = editing ? `Editar a ${editing.name}` : "Crear usuario";

  if (plan) {
    return (
      <AdmModal title={title} onClose={props.onClose} width={620}>
        <PlanReview
          plan={plan}
          onBack={() => setPlan(null)}
          onCancel={props.onClose}
          onDone={() => {
            setPassword("");
            if (props.mode === "create") props.onCreated?.(name);
            props.onClose();
          }}
          runLabel={editing ? "Aplicar cambios" : "Crear usuario"}
        />
      </AdmModal>
    );
  }

  const err = (k: string) =>
    errors[k] ? (
      <div className="field-error" role="alert">
        {errors[k]}
      </div>
    ) : null;

  return (
    <AdmModal title={title} onClose={props.onClose} width={620}>
      <form
        className="adm-form"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
        onChange={() => setNoChanges(false)}
      >
        <div className="modal-body">
          <div className="field-row">
            <label className="field">
              <span>Nombre de usuario</span>
              <input
                className="input mono"
                value={name}
                disabled={!!editing}
                autoFocus={!editing}
                spellCheck={false}
                autoComplete="off"
                maxLength={32}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="p. ej. ana"
                aria-invalid={!!errors.name}
              />
              {err("name")}
            </label>
            <label className="field">
              <span>Nombre completo</span>
              <input
                className="input"
                value={fullName}
                disabled={!canEditInfo}
                autoFocus={!!editing && canEditInfo}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Opcional"
                title={!canEditInfo ? "Sin usermod (busybox) no se puede cambiar" : undefined}
              />
              {err("fullName")}
            </label>
          </div>

          {editing && (
            <label className="checkbox adm-check adm-mb">
              <input type="checkbox" checked={changePass} onChange={(e) => setChangePass(e.target.checked)} />
              Cambiar contraseña
            </label>
          )}
          {changePass && (
            <>
              <PasswordField label={editing ? "Nueva contraseña" : "Contraseña"} value={password} onChange={setPassword} />
              {err("password")}
            </>
          )}

          <div className="field-row">
            <label className="field">
              <span>Shell</span>
              <select
                className="select"
                value={shell}
                disabled={!canEditInfo}
                onChange={(e) => setShell(e.target.value)}
                title={!canEditInfo ? "Sin usermod (busybox) no se puede cambiar" : undefined}
              >
                {shells.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {err("shell")}
            </label>
            {editing ? (
              <label className="field">
                <span>La cuenta caduca el</span>
                <div className="adm-pass">
                  <input
                    className="input"
                    type="date"
                    value={expire}
                    disabled={!env.canChage}
                    onChange={(e) => setExpire(e.target.value)}
                    title={!env.canChage ? "Hace falta chage (shadow-utils)" : undefined}
                  />
                  <button type="button" className="btn btn-sm" disabled={!env.canChage || !expire} onClick={() => setExpire("")}>
                    Sin caducidad
                  </button>
                </div>
                {err("expire")}
              </label>
            ) : (
              <div className="field adm-field-check">
                <label className="checkbox adm-check">
                  <input type="checkbox" checked={createHome} onChange={(e) => setCreateHome(e.target.checked)} />
                  Crear carpeta personal
                </label>
              </div>
            )}
          </div>

          <div className="field">
            <span className="adm-field-label">Grupos adicionales</span>
            <GroupPicker groups={groupNames} value={groups} onChange={setGroups} />
          </div>

          <label className="checkbox adm-check adm-mb">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            Dar acceso de administrador (grupo <span className="mono">{adminGroup}</span>)
            {otherAdmin.length > 0 && <span className="faint">· también está en {otherAdmin.join(", ")}</span>}
          </label>

          {!editing && (
            <label className="field">
              <span>Llave SSH pública (opcional)</span>
              <textarea
                className="textarea mono adm-key-input"
                rows={2}
                value={publicKey}
                disabled={!createHome}
                spellCheck={false}
                placeholder={createHome ? "ssh-ed25519 AAAA… usuario@equipo" : "Necesita carpeta personal"}
                onChange={(e) => setPublicKey(e.target.value)}
              />
              {err("key")}
            </label>
          )}

          <label className="checkbox adm-check" title={!env.canChage ? "Hace falta chage (shadow-utils)" : undefined}>
            <input
              type="checkbox"
              checked={forceChange}
              disabled={!env.canChage}
              onChange={(e) => setForceChange(e.target.checked)}
            />
            {editing ? "Forzar cambio de contraseña en el próximo inicio" : "Forzar cambio de contraseña en el primer inicio"}
            {!env.canChage && <span className="faint">(no disponible: falta chage)</span>}
          </label>
          {noChanges && <div className="adm-note">No hay cambios que aplicar.</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary">
            Revisar comando…
          </button>
        </div>
      </form>
    </AdmModal>
  );
}
