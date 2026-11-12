// Comandos de administración (usuarios, grupos, sesiones) según las herramientas del servidor.
// Funciones puras: generan los pasos de shell ya citados con shQuote. Sin React ni Tauri.
//
// Familias:
//   - "shadow": shadow-utils (Fedora/RHEL, Debian/Ubuntu, Arch; también Alpine con el paquete «shadow»):
//     useradd/usermod/userdel/groupadd/groupdel/groupmod/gpasswd/chpasswd/chage.
//   - "busybox": Alpine mínimo: adduser -D/deluser/addgroup/delgroup/passwd -l|-u/chpasswd.
import { MASK, shQuote } from "./shell";

export type Toolset = "shadow" | "busybox";

export interface AdminEnv {
  toolset: Toolset;
  /** Grupo que da sudo/doas: «sudo» en Debian/Ubuntu, «wheel» en el resto. */
  adminGroup: string;
  tools: Set<string>;
  /** usermod disponible (cambiar shell y nombre completo). */
  canUsermod: boolean;
  /** chage disponible (forzar cambio de contraseña, caducidad). */
  canChage: boolean;
  canRenameGroup: boolean;
  /** Cómo cerrar la sesión de una terminal (null = no se puede). */
  killTool: "pkill" | "ps" | null;
}

/** Elige la familia de comandos según lo instalado y la distro (para el grupo de administración). */
export function detectEnv(
  tools: Set<string>,
  distroId: string | null,
  distroLike: string[],
  groupNames: string[] = [],
): AdminEnv {
  const toolset: Toolset = tools.has("useradd") ? "shadow" : "busybox";
  const family = [distroId ?? "", ...distroLike];
  const debianLike = family.some((d) => ["debian", "ubuntu", "linuxmint", "pop", "raspbian"].includes(d));
  let adminGroup = debianLike ? "sudo" : "wheel";
  // Si el grupo esperado no existe pero el otro sí, se usa el que hay.
  const other = adminGroup === "sudo" ? "wheel" : "sudo";
  if (groupNames.length && !groupNames.includes(adminGroup) && groupNames.includes(other)) adminGroup = other;
  return {
    toolset,
    adminGroup,
    tools,
    canUsermod: tools.has("usermod"),
    canChage: tools.has("chage"),
    canRenameGroup: tools.has("groupmod"),
    killTool: tools.has("pkill-procps") ? "pkill" : tools.has("busybox-ps") ? "ps" : null,
  };
}

/** Un cambio a ejecutar como root: pasos de shell (uno por línea) y, aparte, lo que va por stdin. */
export interface Plan {
  /** Descripción corta para el historial y los avisos («Crear usuario «ana»»). */
  action: string;
  /** Comandos, ya citados, que se ejecutarán en orden con `sh -e` como root. */
  steps: string[];
  /** Entrada estándar del script (p. ej. «usuario:clave» para chpasswd). Secreta: no se muestra ni se guarda. */
  secret?: string;
  /** Cómo se muestra `secret` (siempre enmascarado), p. ej. «ana:●●●●». */
  secretLabel?: string;
  /** Cambios destructivos: el diálogo lo resalta. */
  danger?: boolean;
}

const q = shQuote;

/** Script interior (como root). `set -e`: se detiene en el primer paso que falle. */
export function innerScript(plan: Plan): string {
  return ["set -e", ...plan.steps].join("\n");
}

// ───────── Contraseñas ─────────

/** chpasswd lee «usuario:clave» por stdin (nunca en la línea de comandos). */
function passwordPart(user: string, password: string): Pick<Plan, "secret" | "secretLabel"> & { step: string } {
  return { step: "chpasswd", secret: `${user}:${password}\n`, secretLabel: `${user}:${MASK}` };
}

function forceChangeStep(env: AdminEnv, user: string): string | null {
  if (env.canChage) return `chage -d 0 ${q(user)}`;
  return null;
}

// ───────── authorized_keys ─────────

/** Busca la carpeta personal en /etc/passwd y deja `h` (home), `g` (gid) y `d` (~/.ssh). */
function homeSteps(user: string): string[] {
  return [
    `h=$(awk -F: -v u=${q(user)} '$1 == u { print $6; exit }' /etc/passwd)`,
    `g=$(id -g ${q(user)})`,
    `if [ -z "$h" ] || [ ! -d "$h" ]; then echo ${q(`La carpeta personal de ${user} no existe`)} >&2; exit 1; fi`,
    `d="$h/.ssh"`,
  ];
}

const NO_SYMLINK = `if [ -L "$d" ] || [ -L "$d/authorized_keys" ]; then echo ${q(
  "~/.ssh o authorized_keys es un enlace simbólico: no se modifica por seguridad",
)} >&2; exit 1; fi`;

/**
 * Reescribe ~usuario/.ssh/authorized_keys con `content` (llaves públicas: no son secretas).
 * Carpeta 700 y archivo 600, ambos del usuario. Se escribe en un temporal y se renombra (atómico).
 */
export function writeKeysSteps(user: string, content: string): string[] {
  const body = content.trim() ? `${content.replace(/\s+$/, "")}\n` : "";
  return [
    "# ~/.ssh/authorized_keys: carpeta 700 y archivo 600 del usuario; se escribe en un temporal y se renombra",
    ...homeSteps(user),
    NO_SYMLINK,
    `mkdir -p "$d"`,
    NO_SYMLINK,
    `chown ${q(user)}:"$g" "$d"`,
    `chmod g-s,u=rwx,go= "$d"`,
    `t=$(mktemp "$d/.authorized_keys.XXXXXX")`,
    `printf '%s' ${q(body)} > "$t"`,
    `chown ${q(user)}:"$g" "$t"`,
    `chmod 600 "$t"`,
    `mv -f "$t" "$d/authorized_keys"`,
  ];
}

/** Lectura de authorized_keys (sección @@keys). Sale bien aunque no exista. */
export function readKeysScript(user: string): string {
  return [
    ...homeSteps(user),
    `echo @@keys`,
    `if [ -f "$d/authorized_keys" ]; then cat "$d/authorized_keys"; fi`,
    `echo @@end`,
  ].join("\n");
}

export function setKeysPlan(user: string, lines: string[], action: string): Plan {
  return { action, steps: writeKeysSteps(user, lines.join("\n")) };
}

// ───────── Usuarios ─────────

export interface NewUser {
  name: string;
  fullName: string;
  password: string;
  shell: string;
  createHome: boolean;
  /** Grupos suplementarios (sin el de administración). */
  groups: string[];
  admin: boolean;
  publicKey: string;
  forceChange: boolean;
}

export function createUserPlan(env: AdminEnv, u: NewUser): Plan {
  const groups = [...new Set([...u.groups, ...(u.admin ? [env.adminGroup] : [])])].filter((g) => g !== u.name);
  const steps: string[] = [];
  if (env.toolset === "shadow") {
    const args = ["useradd", u.createHome ? "-m" : "-M"];
    if (u.fullName) args.push("-c", q(u.fullName));
    args.push("-s", q(u.shell));
    if (groups.length) args.push("-G", q(groups.join(",")));
    args.push(q(u.name));
    steps.push(args.join(" "));
  } else {
    const args = ["adduser", "-D"];
    if (!u.createHome) args.push("-H");
    if (u.fullName) args.push("-g", q(u.fullName));
    args.push("-s", q(u.shell), q(u.name));
    steps.push(args.join(" "));
    for (const g of groups) steps.push(`addgroup ${q(u.name)} ${q(g)}`);
  }
  const pw = passwordPart(u.name, u.password);
  steps.push(pw.step);
  if (u.forceChange) {
    const s = forceChangeStep(env, u.name);
    if (s) steps.push(s);
  }
  if (u.publicKey.trim() && u.createHome) steps.push(...writeKeysSteps(u.name, u.publicKey.trim()));
  return { action: `Crear usuario «${u.name}»`, steps, secret: pw.secret, secretLabel: pw.secretLabel };
}

export interface UserEdit {
  name: string;
  /** undefined = sin cambios. */
  fullName?: string;
  shell?: string;
  password?: string;
  addGroups: string[];
  removeGroups: string[];
  /** «AAAA-MM-DD», "" = quitar caducidad, undefined = sin cambios. */
  expire?: string;
  forceChange: boolean;
}

export function addMemberStep(env: AdminEnv, user: string, group: string): string {
  return env.toolset === "shadow" || env.tools.has("gpasswd")
    ? `gpasswd -a ${q(user)} ${q(group)}`
    : `addgroup ${q(user)} ${q(group)}`;
}

export function removeMemberStep(env: AdminEnv, user: string, group: string): string {
  return env.toolset === "shadow" || env.tools.has("gpasswd")
    ? `gpasswd -d ${q(user)} ${q(group)}`
    : `delgroup ${q(user)} ${q(group)}`;
}

/** Plan con todos los cambios del diálogo «Editar». null si no hay nada que cambiar. */
export function editUserPlan(env: AdminEnv, e: UserEdit): Plan | null {
  const steps: string[] = [];
  let secret: Pick<Plan, "secret" | "secretLabel"> = {};
  // Sin usermod (busybox) no hay forma segura de cambiarlos: la interfaz desactiva esos campos.
  if (e.fullName !== undefined && env.canUsermod) steps.push(`usermod -c ${q(e.fullName)} ${q(e.name)}`);
  if (e.shell !== undefined && env.canUsermod) steps.push(`usermod -s ${q(e.shell)} ${q(e.name)}`);
  for (const g of e.addGroups) steps.push(addMemberStep(env, e.name, g));
  for (const g of e.removeGroups) steps.push(removeMemberStep(env, e.name, g));
  if (e.password !== undefined) {
    const pw = passwordPart(e.name, e.password);
    steps.push(pw.step);
    secret = { secret: pw.secret, secretLabel: pw.secretLabel };
  }
  if (e.expire !== undefined && env.canChage) steps.push(`chage -E ${e.expire ? q(e.expire) : "-1"} ${q(e.name)}`);
  if (e.forceChange) {
    const s = forceChangeStep(env, e.name);
    if (s) steps.push(s);
  }
  if (!steps.length) return null;
  return { action: `Editar usuario «${e.name}»`, steps, ...secret };
}

export function lockUserPlan(env: AdminEnv, user: string, lock: boolean): Plan {
  const step = env.canUsermod
    ? `usermod ${lock ? "-L" : "-U"} ${q(user)}`
    : `passwd ${lock ? "-l" : "-u"} ${q(user)}`;
  return { action: `${lock ? "Bloquear" : "Desbloquear"} usuario «${user}»`, steps: [step], danger: lock };
}

export function deleteUserPlan(env: AdminEnv, user: string, removeHome: boolean): Plan {
  const step =
    env.toolset === "shadow"
      ? `userdel${removeHome ? " -r" : ""} ${q(user)}`
      : `deluser${removeHome ? " --remove-home" : ""} ${q(user)}`;
  return {
    action: `Eliminar usuario «${user}»${removeHome ? " y su carpeta personal" : ""}`,
    steps: [step],
    danger: true,
  };
}

// ───────── Grupos ─────────

export function createGroupPlan(env: AdminEnv, group: string): Plan {
  return {
    action: `Crear grupo «${group}»`,
    steps: [env.toolset === "shadow" ? `groupadd ${q(group)}` : `addgroup ${q(group)}`],
  };
}

export function deleteGroupPlan(env: AdminEnv, group: string): Plan {
  return {
    action: `Eliminar grupo «${group}»`,
    steps: [env.toolset === "shadow" ? `groupdel ${q(group)}` : `delgroup ${q(group)}`],
    danger: true,
  };
}

export function renameGroupPlan(group: string, newName: string): Plan {
  return { action: `Renombrar grupo «${group}» a «${newName}»`, steps: [`groupmod -n ${q(newName)} ${q(group)}`] };
}

export function addMembersPlan(env: AdminEnv, group: string, users: string[]): Plan {
  return {
    action: `Añadir ${users.map((u) => `«${u}»`).join(", ")} al grupo «${group}»`,
    steps: users.map((u) => addMemberStep(env, u, group)),
  };
}

export function removeMemberPlan(env: AdminEnv, group: string, user: string): Plan {
  return { action: `Quitar «${user}» del grupo «${group}»`, steps: [removeMemberStep(env, user, group)], danger: true };
}

// ───────── Sesiones ─────────

export function killSessionPlan(env: AdminEnv, tty: string, user: string): Plan | null {
  if (!env.killTool) return null;
  const steps =
    env.killTool === "pkill"
      ? [`pkill -KILL -t ${q(tty)}`]
      : [
          // ps de busybox muestra la terminal como «mayor,menor»: se calcula desde el dispositivo.
          `set -- $(stat -c '%t %T' ${q(`/dev/${tty}`)})`,
          `t=$(printf '%d,%d' "0x$1" "0x$2")`,
          `p=$(ps -o pid,tty | awk -v t="$t" '$2 == t { print $1 }')`,
          `if [ -z "$p" ]; then echo ${q("No hay procesos en esa terminal")} >&2; exit 1; fi`,
          `kill -KILL $p`,
        ];
  return { action: `Cerrar la sesión de «${user}» (${tty})`, steps, danger: true };
}
