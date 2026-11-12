// Comandos de shell para el servidor (funciones puras). Todo se ejecuta con `sh -c '…'` para no
// depender del shell del usuario (fish, zsh…), y cada valor va citado.

/** Cita un argumento para un shell POSIX. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Envuelve un script para ejecutarlo con sh. */
export function wrapSh(script: string): string {
  return `sh -c ${shQuote(script)}`;
}

/**
 * Ruta del servidor como expresión de shell: `~` y `~/…` se expanden a `$HOME`; el resto va citado.
 */
export function pathExpr(p: string): string {
  const t = p.trim();
  if (t === "~") return `"$HOME"`;
  if (t.startsWith("~/")) return `"$HOME"/${shQuote(t.slice(2))}`;
  return shQuote(t);
}

/** Ruta absoluta o con ~, sin saltos de línea. */
export function validateRemotePath(p: string): string | null {
  const t = p.trim();
  if (!t) return "Indica la carpeta en el servidor";
  if (/[\n\r\0]/.test(t)) return "La ruta no puede tener saltos de línea";
  if (!(t.startsWith("/") || t === "~" || t.startsWith("~/"))) return "Usa una ruta absoluta (/srv/app) o que empiece por ~/";
  if (t === "/" || t === "~") return "Elige una subcarpeta, no la raíz";
  return null;
}

/** Rama válida (subconjunto de git check-ref-format; igual que el motor). */
export function validateBranch(b: string): string | null {
  const t = b.trim();
  if (!t) return "Indica la rama";
  const ok =
    t.length <= 200 &&
    !t.startsWith("-") &&
    !t.startsWith("/") &&
    !t.endsWith("/") &&
    !t.endsWith(".lock") &&
    !t.includes("..") &&
    !t.includes("//") &&
    /^[A-Za-z0-9._/-]+$/.test(t);
  return ok ? null : "Nombre de rama no válido";
}

/** Línea de llave pública: `tipo base64 [comentario]` (sin opciones delante). */
const KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/=]{16,})(?:\s+(.*))?$/;

export function parsePubKey(line: string): { type: string; body: string; comment: string } | null {
  const m = KEY_RE.exec(line.trim());
  if (!m) return null;
  return { type: m[1], body: m[2], comment: (m[3] ?? "").trim() };
}

/** Huella corta para mostrar (inicio…fin del cuerpo). */
export function shortKey(line: string): string {
  const k = parsePubKey(line);
  if (!k) return line.slice(0, 40);
  const b = k.body;
  return `${k.type.replace(/^ssh-/, "")} ${b.slice(0, 10)}…${b.slice(-10)}`;
}

/**
 * Añade llaves a ~/.ssh/authorized_keys del usuario conectado: sin duplicar (compara el cuerpo
 * base64), carpeta 700 y archivo 600, rechaza enlaces simbólicos. Imprime `TV_ADDED n` y `TV_SKIPPED n`.
 */
export function addAuthorizedKeysScript(lines: string[]): string {
  const keys = lines.map((l) => parsePubKey(l)).filter((k): k is NonNullable<typeof k> => k !== null);
  if (keys.length === 0) throw new Error("No hay ninguna llave pública válida");
  const parts = [
    "set -e",
    "umask 077",
    'd="$HOME/.ssh"; f="$d/authorized_keys"',
    'if [ -L "$d" ] || [ -L "$f" ]; then echo "~/.ssh o authorized_keys es un enlace simbólico: no se modifica" >&2; exit 3; fi',
    'mkdir -p "$d"; chmod 700 "$d"',
    'touch "$f"; chmod 600 "$f"',
    // Si el archivo no termina en salto de línea, lo añadimos antes de agregar.
    'if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then echo >> "$f"; fi',
    "added=0; skipped=0",
  ];
  for (const k of keys) {
    const line = k.comment ? `${k.type} ${k.body} ${k.comment}` : `${k.type} ${k.body}`;
    parts.push(
      `if grep -qF -- ${shQuote(k.body)} "$f"; then skipped=$((skipped+1)); else printf '%s\\n' ${shQuote(line)} >> "$f"; added=$((added+1)); fi`,
    );
  }
  parts.push('echo "TV_ADDED $added"', 'echo "TV_SKIPPED $skipped"');
  return wrapSh(parts.join("\n"));
}

export function parseAddResult(stdout: string): { added: number; skipped: number } {
  const a = /TV_ADDED (\d+)/.exec(stdout);
  const s = /TV_SKIPPED (\d+)/.exec(stdout);
  return { added: a ? Number(a[1]) : 0, skipped: s ? Number(s[1]) : 0 };
}

/** Nombre de archivo seguro para la llave de despliegue de un repo. */
export function deployKeyName(owner: string, repo: string): string {
  const safe = `${owner}-${repo}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `terview_deploy_${safe}`;
}

/** Ruta (con ~) de la llave de despliegue en el servidor. */
export function deployKeyPath(owner: string, repo: string): string {
  return `~/.ssh/${deployKeyName(owner, repo)}`;
}

/** Crea (si no existe) la llave de despliegue ed25519 sin frase y muestra la pública. */
export function deployKeyGenScript(owner: string, repo: string): string {
  const name = deployKeyName(owner, repo);
  const comment = `terview-deploy ${owner}/${repo}`;
  return wrapSh(
    [
      "set -e",
      "umask 077",
      'mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"',
      "command -v ssh-keygen >/dev/null 2>&1 || { echo 'Falta ssh-keygen en el servidor (paquete openssh-client)' >&2; exit 127; }",
      `k="$HOME/.ssh/${name}"`,
      `if [ ! -f "$k" ]; then ssh-keygen -q -t ed25519 -N '' -C ${shQuote(comment)} -f "$k" >/dev/null; fi`,
      'cat "$k.pub"',
    ].join("\n"),
  );
}

/** Valor de GIT_SSH_COMMAND / core.sshCommand para una llave del servidor (ruta con ~). */
export function gitSshCommand(keyPath: string): string {
  const p = keyPath.startsWith("~/") ? `$HOME/${keyPath.slice(2)}` : keyPath;
  return `ssh -i "${p}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}

export interface CloneOpts {
  url: string;
  dest: string;
  branch: string;
  /** Llave de despliegue (repo privado por SSH). */
  keyPath: string | null;
}

/** Script de clonado (se muestra al usuario antes de ejecutarlo). */
export function cloneScript(o: CloneOpts): string {
  const dest = pathExpr(o.dest);
  const lines = [
    "set -e",
    "exec 2>&1",
    "command -v git >/dev/null 2>&1 || { echo 'Git no está instalado en el servidor' >&2; exit 127; }",
    `dest=${dest}`,
    'if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then echo "La carpeta destino ya existe y no está vacía" >&2; exit 4; fi',
    'mkdir -p "$(dirname "$dest")"',
  ];
  if (o.keyPath) {
    const ssh = gitSshCommand(o.keyPath);
    lines.push(
      `GIT_SSH_COMMAND=${shQuoteKeepHome(ssh)} git clone --branch ${shQuote(o.branch)} -- ${shQuote(o.url)} "$dest"`,
      // Para que `git pull` posterior use la misma llave.
      `git -C "$dest" config core.sshCommand ${shQuoteKeepHome(ssh)}`,
    );
  } else {
    lines.push(`git clone --branch ${shQuote(o.branch)} -- ${shQuote(o.url)} "$dest"`);
  }
  lines.push('echo "Clonado en $dest"');
  return lines.join("\n");
}

/** Cita con comillas dobles dejando `$HOME` expandible (el resto no tiene $ ni comillas). */
function shQuoteKeepHome(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$(?!HOME\/)/g, "\\$")}"`;
}

export interface DeployOpts {
  path: string;
  branch: string;
  commands: string;
  /** Llave de despliegue (si el repo no se clonó con TerView y necesita una). */
  keyPath?: string | null;
}

/** Comandos posteriores (uno por línea; se ignoran vacíos y los que empiezan por #). */
export function commandLines(commands: string): string[] {
  return commands
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Script de "Actualizar desde GitHub": git pull + comandos, parando al primer error. */
export function deployScript(o: DeployOpts): string {
  const lines = [
    "set -e",
    "exec 2>&1",
    `cd ${pathExpr(o.path)}`,
    ...(o.keyPath ? [`export GIT_SSH_COMMAND=${shQuoteKeepHome(gitSshCommand(o.keyPath))}`] : []),
    `echo '$ git pull --ff-only origin '${shQuote(o.branch)}`,
    "git fetch --prune origin",
    `git checkout ${shQuote(o.branch)}`,
    `git pull --ff-only origin ${shQuote(o.branch)}`,
  ];
  for (const c of commandLines(o.commands)) {
    lines.push(`printf '\\n$ %s\\n' ${shQuote(c)}`, c);
  }
  lines.push("printf '\\nListo.\\n'");
  return lines.join("\n");
}
