// Pruebas de «Nuevo usuario con clave»: validación de usuario y llave, AllowUsers/AllowGroups, plan y catálogo.
// Ejecutar: npx rolldown src/features/admin/keyUser.test.ts -p node -f esm -o /tmp/ku.mjs && node /tmp/ku.mjs
// Con KU_SH=1 además ejecuta el comando del catálogo en un sh local con useradd/usermod/… falsos.
import { renderTemplate, missingVars } from "../../components/Commands/template";
import { CATALOG } from "../../components/Commands/catalog";
import { detectEnv } from "./commands";
import { splitSections } from "./parse";
import { validateName } from "./shell";
import {
  accessAdvice,
  allowUsersPlan,
  checkPublicKey,
  createKeyUserPlan,
  KEY_USER_CATALOG_COMMAND,
  parseSshdAccess,
  suggestKeyName,
  validateKeyName,
} from "./keyUser";

// Sin @types/node en el proyecto: lo mínimo de Node, tipado a mano.
declare const process: { env: Record<string, string | undefined> };
const nodeModule = (name: string) => import(/* @vite-ignore */ name);

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
  passed++;
}

const ED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICZm9C4sWqQjlgtug0eu7n8xh8h3oGFuNpS0Rq3vCc5z ana@portátil de casa";
const RSA =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCf9LshOS/M0PgpdomIzYzjHaeK+aj18x0aVUVBy/ajYnCYyA+t3djsRq0bpuZiXLMz1Mk/0CALoRdDBkOIC/B8U0wJQPyoxV0ObXrbUKGGdn7NP4kG9/rShiDiNETL5Nd4BE3nHMmVAATEvL0O+aY96a4x3YLQXOPdpiF7C9YTgCONNgG4EiHoHz6wylJJyLRPPtm4ftb4ZmNgUKQveZFg0OvCrBN35gaCGYVCl2gyyuQZzUD5ZP2KzG6sONgb56WxSyN6X1LaORPtV4gOmVPf7+KIpZBRxx+VLUsyOyVivYIQYIWYVD2jyoRgNwn/vt00ZERyO5OCHVj/GTdzoogD";

// ── Nombre de usuario (POSIX, como shadow-utils) ──
eq(validateName("ana"), null, "usuario válido");
eq(validateName("deploy_01-x"), null, "usuario con _ y -");
ok(validateName("Ana"), "mayúsculas");
ok(validateName("1ana"), "empieza por número");
ok(validateName("-ana"), "empieza por guion");
ok(validateName("a b"), "espacio");
ok(validateName("a".repeat(33)), "demasiado largo");

// ── Llave pública ──
const e = checkPublicKey(`  ${ED}  `);
ok(e.ok, "ed25519 válida");
if (e.ok) {
  eq(e.type, "ssh-ed25519", "tipo");
  eq(e.comment, "ana@portátil de casa", "comentario con espacios");
  eq(e.line, ED, "línea recortada");
}
ok(checkPublicKey(RSA).ok, "rsa válida sin comentario");
ok(!checkPublicKey("").ok, "vacía");
ok(!checkPublicKey("hola").ok, "texto cualquiera");
ok(!checkPublicKey(ED.replace("AAAAC3", "AAAAB3")).ok, "tipo interno distinto (rsa dentro de ed25519)");
ok(!checkPublicKey(ED.replace("Cc5z", "Cc5")).ok, "base64 cortado");
ok(!checkPublicKey(ED.replace("Cc5z", "")).ok, "ed25519 cortada (longitud múltiplo de 4)");
ok(!checkPublicKey(ED.replace("ssh-ed25519", "ssh-rsa")).ok, "tipo de delante distinto");
ok(!checkPublicKey(`${ED}\n${RSA}`).ok, "dos líneas");
ok(!checkPublicKey(`command="x" ${ED}`).ok, "con opciones delante");
ok(!checkPublicKey("-----BEGIN OPENSSH PRIVATE KEY-----").ok, "privada");

// ── Nombre del archivo de la llave ──
eq(suggestKeyName("ana", "web.example.com"), "id_ed25519_ana_web", "nombre sugerido");
eq(validateKeyName("id_ed25519_ana"), null, "nombre de llave válido");
ok(validateKeyName("../x"), "ruta");
ok(validateKeyName("x.pub"), ".pub");
ok(validateKeyName(".oculta"), "oculta");

// ── AllowUsers / AllowGroups ──
const acc = parseSshdAccess(
  splitSections(["@@eff", "allowgroups sshusers", "allowgroups admins", "denyusers malo", "@@conf", "AllowGroups x", "@@end"].join("\n")),
);
eq(acc.allowGroups, ["sshusers", "admins"], "sshd -T manda sobre los archivos");
eq(acc.source, "sshd -T", "origen");
eq(accessAdvice(acc, "ana", ["ana"]).needGroup, "sshusers", "falta el grupo");
eq(accessAdvice(acc, "ana", ["ana", "admins"]).needGroup, null, "ya en un grupo permitido");
ok(accessAdvice(acc, "malo", ["malo", "sshusers"]).denied, "DenyUsers");
const conf = parseSshdAccess(splitSections(["@@eff", "@@conf", "  AllowUsers root deploy@10.0.0.* # comentario", "@@end"].join("\n")));
eq(conf.source, "archivos", "sin sshd -T: archivos");
eq(conf.allowUsers, ["root", "deploy@10.0.0.*"], "AllowUsers sin el comentario");
eq(accessAdvice(conf, "ana", ["ana"]).needAllowUsers, true, "AllowUsers no incluye a ana");
eq(accessAdvice(conf, "deploy", ["deploy"]).needAllowUsers, false, "usuario@host cuenta como el usuario");
eq(accessAdvice(parseSshdAccess(splitSections("@@eff\n@@conf\n@@end")), "ana", ["ana"]), { needGroup: null, needAllowUsers: false, denied: null }, "sin restricciones");

// ── Plan del asistente ──
const rocky = detectEnv(new Set(["useradd", "usermod", "chage"]), "rocky", ["rhel", "centos", "fedora"], ["wheel"]);
const plan = createKeyUserPlan(rocky, { name: "ana", publicKey: ED, shell: "/bin/bash", groups: ["sshusers"], admin: true, linger: true });
eq(plan.steps[1], "useradd -m -s '/bin/bash' -G 'sshusers,wheel' 'ana'", "useradd con grupos");
eq(plan.steps[2], "usermod -p '*' 'ana'", "sin contraseña, no bloqueada");
ok(plan.steps.some((s) => s === `printf '%s' '${ED}\n' > "$t"`), "llave citada en authorized_keys");
ok(plan.steps.some((s) => s.includes("loginctl enable-linger 'ana'")), "linger");
ok(!plan.steps.some((s) => /PasswordAuthentication|sshd_config/.test(s)), "no toca sshd_config");
eq(plan.secret, undefined, "sin secretos");
const noLinger = createKeyUserPlan(rocky, { name: "ana", publicKey: ED, shell: "/bin/bash", groups: [], admin: false, linger: false });
eq(noLinger.steps[1], "useradd -m -s '/bin/bash' 'ana'", "sin grupos");
ok(!noLinger.steps.some((s) => s.includes("loginctl")), "sin linger");
const alpine = detectEnv(new Set(["adduser"]), "alpine", [], ["wheel"]);
const ap = createKeyUserPlan(alpine, { name: "ana", publicKey: ED, shell: "/bin/sh", groups: ["sshusers"], admin: true, linger: false });
eq(ap.steps.slice(1, 5), ["adduser -D -s '/bin/sh' 'ana'", "printf '%s:*\\n' 'ana' | chpasswd -e", "addgroup 'ana' 'sshusers'", "addgroup 'ana' 'wheel'"], "busybox");
const evil = createKeyUserPlan(rocky, { name: "ana", publicKey: "ssh-ed25519 AAAA x'; rm -rf / #", shell: "/bin/bash", groups: [], admin: false, linger: false });
ok(evil.steps.some((s) => s.includes(`'ssh-ed25519 AAAA x'\\''; rm -rf / #\n'`)), "comilla de la llave escapada");
const au = allowUsersPlan("ana");
ok(au.danger && au.steps.some((s) => s.includes("sshd -t")), "AllowUsers: comprueba con sshd -t");

// ── Catálogo ──
const entry = CATALOG.find((c) => c.id === "usuarios.crear-usuario-clave");
ok(entry, "entrada del catálogo");
ok(entry?.sudo && entry.command === KEY_USER_CATALOG_COMMAND, "marcada sudo");
eq(Object.keys(entry?.vars ?? {}), ["usuario", "clave_publica", "grupo", "admin", "linger"], "variables");
eq(missingVars(KEY_USER_CATALOG_COMMAND, { usuario: "ana", clave_publica: ED }), [], "grupo/admin/linger opcionales");
ok(!KEY_USER_CATALOG_COMMAND.slice(KEY_USER_CATALOG_COMMAND.indexOf("'") + 1, KEY_USER_CATALOG_COMMAND.lastIndexOf("'")).includes("'"), "script sin comillas simples dentro");
const rendered = renderTemplate(KEY_USER_CATALOG_COMMAND, { usuario: "ana", clave_publica: ED }, { fillMissing: true });
ok(rendered.endsWith(`' crear-usuario ana '${ED}' '' no no`), `argumentos citados: ${rendered.slice(-140)}`);
CATALOG.filter((c) => c.category === "Usuarios").forEach((c) => ok(/^usuarios\./.test(c.id), "ids de Usuarios"));

// ── Ejecución real del comando del catálogo con herramientas falsas (KU_SH=1) ──
if (process.env.KU_SH) {
  const { execFileSync } = await nodeModule("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } = await nodeModule("node:fs");
  const { tmpdir } = await nodeModule("node:os");
  const { join } = await nodeModule("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ku-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const log = join(dir, "log");
  const passwd = join(dir, "passwd");
  writeFileSync(passwd, "root:x:0:0::/root:/bin/sh\n");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // useradd: añade la línea a un passwd falso y crea la carpeta personal.
  fake("useradd", `eval u=\\$$#; echo "$u:x:1000:1000::${home}/$u:/bin/bash" >> ${passwd}; mkdir -p ${home}/$u`);
  fake("usermod", "");
  fake("chown", "");
  fake("loginctl", "");
  fake("id", `grep -q "^$2:" ${passwd} 2>/dev/null || grep -q "^$1:" ${passwd} || exit 1; echo 1000`);
  writeFileSync(join(dir, "group"), "wheel:x:10:\n");
  const withVars = renderTemplate(KEY_USER_CATALOG_COMMAND, { usuario: "ana", clave_publica: ED, grupo: "sshusers", admin: "si", linger: "si" })
    .replace(/^sudo /, "")
    .replace(/\/etc\/passwd/g, passwd)
    .replace(/\/etc\/group/g, join(dir, "group"));
  const out = execFileSync("sh", ["-c", withVars], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).toString();
  ok(out.includes("Usuario ana creado"), `salida: ${out}`);
  eq(readFileSync(join(home, "ana/.ssh/authorized_keys"), "utf8"), `${ED}\n`, "authorized_keys con la llave literal");
  const calls = readFileSync(log, "utf8");
  ok(calls.includes("useradd -m -s /bin/bash ana") || calls.includes("useradd -m -s /bin/sh ana"), calls);
  ok(calls.includes("usermod -aG sshusers ana") && calls.includes("usermod -aG wheel ana"), calls);
  ok(calls.includes("loginctl enable-linger ana"), calls);
  // Usuario repetido → error.
  let failed = false;
  try {
    execFileSync("sh", ["-c", withVars], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" });
  } catch {
    failed = true;
  }
  ok(failed, "usuario repetido falla");
}

console.log(`keyUser: ${passed} comprobaciones correctas`);
