// Ejecución de comandos del motor como su dueño (tú, root u otro usuario). Nunca lanza.
// Para otro usuario, el script lo arma el motor (`as_owner_script`, el mismo que usa el escáner para
// «Actualizar imagen»): entra como él con su HOME y su XDG_RUNTIME_DIR, nunca como root por error.
import { vulnscan } from "../../api/vulnscan";
import type { ExecResult } from "../../api/types";
import { errorMessage } from "../../api/core";
import { wrapScript, type Elevation } from "../privileges";
import { groupByOwner, multiOwnerScript, ownerKey, parseMultiOwner, type CtOwner } from "./owner";
import { failureMessage, runRaw, scriptFor, type EngineRun } from "./run";
import type { Cmd } from "./shell";
import type { Engine } from "./types";

export interface OwnerRunner {
  sessionId: string;
  engine: Engine;
  /** Clave del dueño para los comandos sin dueño (el elegido arriba). */
  fallback: string;
  resolve: (key: string) => CtOwner | null;
  /** Elevación con la que se ejecuta ese dueño (null = hace falta sudo y aún no hay). */
  elevationFor: (o: CtOwner) => Elevation | null;
  label: (o: CtOwner) => string;
}

const NEED_SUDO: EngineRun = { ok: false, result: null, error: "Hace falta sudo", needSudo: true };

/** Script para el dueño: tal cual (tú o root) o envuelto para entrar como otro usuario. */
export async function ownerWrap(engine: Engine, o: CtOwner, inner: string): Promise<string> {
  if (o.kind !== "user") return inner;
  const { name, uid, home } = o.user;
  return vulnscan.script({ kind: "asOwner", engine, user: { name, uid, home }, script: inner });
}

function fail(error: string): EngineRun {
  return { ok: false, result: null, error, needSudo: false };
}

/** Ejecuta comandos (cada uno como su dueño), en orden; se para en el primer grupo que falle. */
export async function runOwned(r: OwnerRunner, cmds: Cmd[], timeoutSecs: number): Promise<EngineRun> {
  const groups = groupByOwner(cmds, r.fallback);
  const outs: string[] = [];
  let last: EngineRun | null = null;
  for (const g of groups) {
    const o = r.resolve(g.owner);
    if (!o) return fail("No se encontró el usuario dueño de esto. Vuelve a buscar los usuarios (botón de recargar).");
    const el = r.elevationFor(o);
    if (!el) return NEED_SUDO;
    let res: EngineRun;
    try {
      res = await runRaw(r.sessionId, await ownerWrap(r.engine, o, scriptFor(g.cmds)), el, timeoutSecs);
    } catch (e) {
      return fail(errorMessage(e));
    }
    if (!res.ok) {
      if (groups.length > 1 && res.error) return { ...res, error: `${r.label(o)}: ${res.error}` };
      return res;
    }
    outs.push(res.result?.stdout ?? "");
    last = res;
  }
  if (!last) return fail("No hay nada que ejecutar");
  if (groups.length === 1 || !last.result) return last;
  return { ...last, result: { ...last.result, stdout: outs.join("\n") } };
}

/** Script completo que se envía (sin secretos), para «Script completo enviado al servidor». */
export async function ownedFullScript(r: OwnerRunner, cmds: Cmd[]): Promise<string> {
  const parts: string[] = [];
  for (const g of groupByOwner(cmds, r.fallback)) {
    const o = r.resolve(g.owner);
    if (!o) continue;
    const el = r.elevationFor(o);
    const inner = await ownerWrap(r.engine, o, scriptFor(g.cmds));
    parts.push(el ? wrapScript(inner, el) : inner);
  }
  return parts.join("\n\n");
}

function asResult(out: string, err: string, rc: number | null): ExecResult {
  return { stdout: out, stderr: err, exitCode: rc, durationMs: 0, truncated: false, timedOut: rc === 124 };
}

/**
 * Ejecuta el mismo script de lectura (`inner`) para varios dueños, a la vez: un script por elevación
 * (tú sin sudo; root y los demás usuarios, juntos, con sudo). Devuelve el resultado de cada dueño.
 */
export async function readOwners(r: OwnerRunner, owners: CtOwner[], inner: string, timeoutSecs: number): Promise<Map<string, EngineRun>> {
  const out = new Map<string, EngineRun>();
  const groups = new Map<string, { el: Elevation | null; owners: CtOwner[] }>();
  for (const o of owners) {
    const el = r.elevationFor(o);
    const k = el ? el.kind : "missing";
    const g = groups.get(k) ?? { el, owners: [] };
    g.owners.push(o);
    groups.set(k, g);
  }
  await Promise.all(
    [...groups.values()].map(async ({ el, owners: list }) => {
      if (!el) {
        for (const o of list) out.set(ownerKey(o), NEED_SUDO);
        return;
      }
      try {
        if (list.length === 1) {
          const o = list[0];
          out.set(ownerKey(o), await runRaw(r.sessionId, await ownerWrap(r.engine, o, inner), el, timeoutSecs));
          return;
        }
        const parts = await Promise.all(list.map(async (o) => ({ owner: ownerKey(o), script: await ownerWrap(r.engine, o, inner) })));
        const res = await runRaw(r.sessionId, multiOwnerScript(parts, timeoutSecs), el, timeoutSecs + 10);
        if (!res.result || !res.result.stdout.includes("@@tvo:")) {
          for (const o of list) out.set(ownerKey(o), res.ok ? fail("El servidor no devolvió nada") : res);
          return;
        }
        const parsed = parseMultiOwner(res.result.stdout);
        for (const o of list) {
          const p = parsed.get(ownerKey(o));
          if (!p) out.set(ownerKey(o), fail(res.result.truncated ? "La salida era demasiado grande y se cortó" : "Sin respuesta del servidor"));
          else if (p.rc === 0) out.set(ownerKey(o), { ok: true, result: asResult(p.out, p.err, 0), error: null, needSudo: false });
          else {
            const er = asResult(p.out, p.err, p.rc);
            out.set(ownerKey(o), { ok: false, result: er, error: failureMessage(er), needSudo: false });
          }
        }
      } catch (e) {
        for (const o of list) out.set(ownerKey(o), fail(errorMessage(e)));
      }
    }),
  );
  return out;
}
