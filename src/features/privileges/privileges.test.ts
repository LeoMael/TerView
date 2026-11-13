// Pruebas de funciones puras de privilegios: de dónde sale la contraseña de sudo y el envoltorio de sudo -S.
// Ejecutar: npx rolldown src/features/privileges/privileges.test.ts -p node -f esm -o /tmp/pt.mjs && node /tmp/pt.mjs
import { buildExec, elevationFailure, EXIT_SUDO_BAD_PASSWORD } from "./elevate";
import {
  defaultSaveChecked,
  otherSessionPasswords,
  storedFailed,
  storedStateAfterConfirm,
  sudoLookupPlan,
  type SudoLookupInput,
} from "./lookup";

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: esperaba ${JSON.stringify(want)}, llegó ${JSON.stringify(got)}`);
  passed++;
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
  passed++;
}

const base: SudoLookupInput = { hasMemory: false, stored: undefined, mode: "saved", otherSessions: 0 };

// ── Orden de búsqueda ──
eq(sudoLookupPlan({ ...base, hasMemory: true }), ["memory"], "en memoria: no se busca nada más");
eq(sudoLookupPlan({ ...base, hasMemory: true, stored: "off" }), ["memory"], "en memoria aunque se olvidara la guardada antes");
eq(sudoLookupPlan(base), ["stored", "ask"], "guardada sin leer: primero la guardada");
eq(sudoLookupPlan({ ...base, mode: "login" }), ["stored", "ask"], "«La de la conexión» también se lee");
eq(sudoLookupPlan({ ...base, stored: "loading" }), ["stored", "ask"], "leyéndose: se espera a esa lectura");
eq(sudoLookupPlan({ ...base, stored: "ok" }), ["stored", "ask"], "«ok» sin memoria (rechazada y olvidada): se vuelve a leer");
eq(sudoLookupPlan({ ...base, mode: "ask" }), ["ask"], "«Pedir cada vez»: se pregunta");
eq(sudoLookupPlan({ ...base, stored: "none" }), ["ask"], "no había guardada: no se relee");
eq(sudoLookupPlan({ ...base, stored: "failed" }), ["ask"], "la guardada falló: no se reintenta (sin bucle)");
eq(sudoLookupPlan({ ...base, stored: "rejected" }), ["ask"], "falló y ya se avisó: no se reintenta");
eq(sudoLookupPlan({ ...base, stored: "off", otherSessions: 2 }), ["ask"], "«Olvidar»: ni guardada ni otras pestañas");
eq(sudoLookupPlan({ ...base, otherSessions: 1 }), ["stored", "other-session", "ask"], "guardada, luego otra pestaña");
eq(sudoLookupPlan({ ...base, mode: "ask", otherSessions: 1 }), ["other-session", "ask"], "«Pedir cada vez» con otra pestaña");
eq(sudoLookupPlan({ ...base, stored: "failed", otherSessions: 1 }), ["other-session", "ask"], "guardada mala: otra pestaña");

// ── Estado tras comprobar la guardada ──
eq(storedStateAfterConfirm({ ok: true }), "ok", "correcta");
eq(storedStateAfterConfirm({ ok: false, badPassword: true }), "failed", "incorrecta");
eq(storedStateAfterConfirm({ ok: false }), "none", "otro fallo (tty, sin permiso, tiempo): no se marca como incorrecta");
ok(storedFailed("failed") && storedFailed("rejected"), "failed y rejected cuentan como fallida");
ok(!storedFailed("ok") && !storedFailed("none") && !storedFailed(undefined) && !storedFailed("off"), "el resto no");

// ── «Guardar para este servidor» marcado de entrada ──
eq(defaultSaveChecked({ change: false, failed: false, mode: "ask" }), false, "pedir cada vez, sin fallo");
eq(defaultSaveChecked({ change: false, failed: false, mode: "saved" }), true, "ya guardaba");
eq(defaultSaveChecked({ change: false, failed: false, mode: "login" }), true, "usa la de la conexión");
eq(defaultSaveChecked({ change: false, failed: true, mode: "ask" }), true, "la guardada falló");
eq(defaultSaveChecked({ change: true, failed: false, mode: "ask" }), true, "«Cambiar contraseña de sudo…»");

// ── Otras pestañas del mismo servidor ──
const tabs = [
  { sessionId: "a", profileId: "srv1", status: "connected" },
  { sessionId: "b", profileId: "srv1", status: "connected" },
  { sessionId: "c", profileId: "srv1", status: "closed" },
  { sessionId: "d", profileId: "srv2", status: "connected" },
  { sessionId: "e", profileId: "srv1", status: "reconnecting" },
  { sessionId: "f", profileId: "srv1", status: "connected" },
];
const mem = { a: "yo", b: "uno", c: "cerrada", d: "otro-servidor", e: "uno" };
eq(otherSessionPasswords(tabs, mem, "a", "srv1"), ["uno"], "mismo servidor, sin repetir, sin la propia ni cerradas");
eq(otherSessionPasswords(tabs, mem, "f", "srv1"), ["yo", "uno"], "desde una pestaña sin contraseña");
eq(otherSessionPasswords(tabs, mem, "d", "srv2"), [], "otro servidor: nada (la clave es el perfil, no la pestaña)");
eq(otherSessionPasswords(tabs, {}, "a", "srv1"), [], "nadie la tiene");

// ── sudo -S: la contraseña va por stdin, nunca en el comando ──
const req = buildExec("id -u", { kind: "password", password: "s3cr'eto" });
ok(!req.command.includes("s3cr") && !req.script.includes("s3cr"), "ni en el comando ni en el script mostrado");
ok(req.stdin.endsWith("s3cr'eto\n"), "va por stdin, tras el script");
ok(req.script.includes("sudo -k -S -p '' -v"), "se comprueba con sudo -v antes de ejecutar");
eq(elevationFailure(EXIT_SUDO_BAD_PASSWORD, "__TV_SUDO_BAD__\n"), "bad-password", "contraseña incorrecta reconocida");
eq(elevationFailure(EXIT_SUDO_BAD_PASSWORD, "otra cosa"), null, "sin la marca no se confunde con el script");

console.log(`privileges: ${passed} comprobaciones correctas`);
