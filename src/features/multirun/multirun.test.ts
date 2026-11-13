// Pruebas de «Ejecutar en varios servidores» con sudo: motor con llamadas simuladas.
// Ejecutar: npx rolldown src/features/multirun/multirun.test.ts -p node -f esm -o /tmp/mr.mjs && node /tmp/mr.mjs
import type { SudoExecResult } from "../../api/snippets";
import type { ExecResult } from "../../api/types";
import { wantsSudoPassword } from "./danger";
import { RunEngine, type EngineDeps } from "./engine";
import type { RunSpec, TargetInput, TargetState } from "./types";

let passed = 0;
function eq<T>(got: T, want: T, what: string) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${what}: ${a} ≠ ${b}`);
  passed++;
}

const ok: ExecResult = { stdout: "hecho\n", stderr: "", exitCode: 0, durationMs: 1, truncated: false, timedOut: false };

type Answer = { password: string } | { need: false } | null;

function setup(answers: Record<string, Answer>, failure: SudoExecResult["sudoFailure"] = null) {
  const calls: string[] = [];
  const rejected: string[] = [];
  const deps: EngineDeps = {
    tabSession: () => null,
    connect: async (id) => `s-${id}`,
    connectInteractive: async (id) => `s-${id}`,
    exec: async (sid) => {
      calls.push(`exec ${sid}`);
      return ok;
    },
    newExecId: () => "x",
    cancelExec: async () => false,
    disconnect: async () => {},
    privilege: async () => "sudo",
    sudoPassword: async (_sid, profileId) => answers[profileId] ?? null,
    execSudo: async (sid, _cmd, password) => {
      calls.push(`sudo ${sid} ${password}`);
      return failure
        ? { ...ok, stdout: "", exitCode: 97, stderr: "__TV_SUDO_BAD__", sudoFailure: failure }
        : { ...ok, sudoFailure: null };
    },
    sudoRejected: (sid) => rejected.push(sid),
  };
  return { deps, calls, rejected };
}

const spec: RunSpec = {
  command: "sudo apt update && sudo apt upgrade -y",
  label: null,
  timeoutSecs: 30,
  concurrency: 4,
  usesSudo: true,
  sudoPassword: true,
};
const targets: TargetInput[] = ["a", "b", "c"].map((id) => ({ profileId: id, name: id, address: id, auth: "password" }));

async function run(answers: Record<string, Answer>, failure: SudoExecResult["sudoFailure"] = null) {
  const s = setup(answers, failure);
  let last: TargetState[] = [];
  const e = new RunEngine(spec, targets, s.deps, (l) => (last = l));
  e.start();
  for (let i = 0; i < 50 && e.busy; i++) await new Promise((r) => setTimeout(r, 1));
  return { ...s, targets: last };
}

// Cada servidor según lo que haga falta: tal cual, con contraseña o saltado.
{
  const r = await run({ a: { need: false }, b: { password: "pw-b" }, c: null });
  eq(r.calls.sort(), ["exec s-a", "sudo s-b pw-b"], "llamadas");
  eq(r.targets.map((t) => t.status), ["ok", "ok", "canceled"], "estados");
  eq(r.targets[2].detail, "Saltado: sin contraseña de sudo", "saltado");
}

// Contraseña incorrecta: error claro y se marca rechazada.
{
  const r = await run({ a: { password: "mala" }, b: { need: false }, c: { need: false } }, "bad-password");
  eq(r.targets[0].status, "error", "error");
  eq(r.targets[0].detail?.startsWith("Contraseña de sudo incorrecta"), true, "mensaje");
  eq(r.rejected, ["s-a"], "rechazada");
}

// Qué comandos piden la contraseña.
eq(wantsSudoPassword("sudo systemctl restart nginx"), true, "sudo");
eq(wantsSudoPassword("echo x | sudo tee /etc/y"), true, "tubería");
eq(wantsSudoPassword("sudo -n true"), false, "sudo -n");
eq(wantsSudoPassword("doas ls"), false, "doas");
eq(wantsSudoPassword("uptime"), false, "sin sudo");

console.log(`multirun: ${passed} comprobaciones correctas`);
