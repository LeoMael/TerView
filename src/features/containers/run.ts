// Ejecución de comandos del motor por el canal exec (con sudo si hace falta) y traducción de errores.
import type { ExecResult } from "../../api/types";
import { errorMessage } from "../../api/core";
import { runScript, ElevationError } from "../admin/run";
import type { Elevation } from "../privileges";
import { PATH_PREFIX } from "./detect";
import { displayPrefix, renderCmd, type Cmd } from "./shell";

/** Script interior: PATH ampliado + los comandos; `set -e` para pararse en el primero que falle. */
export function scriptFor(cmds: Cmd[]): string {
  return [PATH_PREFIX, "set -e", ...cmds.map(renderCmd)].join("\n");
}

/** Prefijo visible según la elevación. */
export function elevationPrefix(el: Elevation): string {
  switch (el.kind) {
    case "nopasswd":
      return `${el.tool} `;
    case "password":
      return "sudo ";
    default:
      return "";
  }
}

/** Comandos tal y como se muestran al usuario (con «sudo » delante si aplica). */
export function displayCmds(cmds: Cmd[], el: Elevation): string[] {
  const p = elevationPrefix(el);
  return cmds.map((c) => displayPrefix(p, c));
}

export interface EngineRun {
  ok: boolean;
  result: ExecResult | null;
  /** Mensaje en español listo para mostrar. */
  error: string | null;
  /** Hay que (volver a) pedir la contraseña de sudo. */
  needSudo: boolean;
}

/** Traduce los errores habituales de Podman/Docker (deja el original debajo). */
export function translateError(stderr: string): string {
  const raw = stderr
    .split("\n")
    .filter((l) => !/Executing external compose provider|Please see podman-compose|^\s*$/.test(l))
    .join("\n")
    .trim();
  const e = raw.toLowerCase();
  const rules: [RegExp, string][] = [
    [/permission denied.*docker|docker\.sock.*permission denied|got permission denied/, "Sin permiso para usar Docker: hace falta sudo o estar en el grupo «docker»"],
    [/cannot connect to the docker daemon|is the docker daemon running/, "El servicio Docker no está en marcha"],
    [/no such container/, "El contenedor ya no existe (puede que lo hayan borrado)"],
    [/no such image|image not known|image not found/, "La imagen no existe en el servidor"],
    [/no such volume|volume .* not found|no volume with name/, "El volumen no existe"],
    [/no such network|network .* not found|unable to find network/, "La red no existe"],
    [/is already in use by|name .* is already in use|already in use by container|name is already in use/, "Ya existe un contenedor con ese nombre"],
    [/port is already allocated|address already in use|bind: address already in use|ports are not available/, "Ese puerto del servidor ya está en uso por otro programa o contenedor"],
    [/rootlessport cannot expose privileged port|privileged port|permission denied.*bind/, "Sin root no se pueden publicar puertos por debajo de 1024: usa uno mayor (p. ej. 8080)"],
    [/image is being used|image used by|is in use by container|conflict: unable to (remove|delete).*(container|being used)|image is in use/, "La imagen está en uso por algún contenedor: elimínalo antes o fuerza el borrado"],
    [/volume is (being )?used|volume .* is in use|being used by/, "El volumen está en uso por algún contenedor"],
    [/has active endpoints|is being used|network .* in use/, "La red está en uso por algún contenedor"],
    [/cannot remove container .* running|stop the container before|container is running|you cannot remove a running container/, "El contenedor está en marcha: páralo antes o marca «Forzar»"],
    [/manifest unknown|not found: manifest|manifest for .* not found/, "Esa etiqueta de imagen no existe en el registro"],
    [/requested access to the resource is denied|unauthorized|authentication required/, "El registro no permite descargarla: la imagen no existe o es privada (inicia sesión con «login»)"],
    [/short-name .* did not resolve|short-name resolution enforced/, "Usa el nombre completo de la imagen (p. ej. docker.io/library/nginx)"],
    [/no such host|temporary failure in name resolution|dial tcp|i\/o timeout|tls handshake timeout/, "El servidor no pudo conectarse al registro de imágenes (¿tiene internet?)"],
    [/no space left on device/, "No queda espacio en el disco del servidor"],
    [/container .* is not running|is not running/, "El contenedor no está en marcha"],
    [/is not paused|not paused/, "El contenedor no está en pausa"],
    [/is already paused|already paused/, "El contenedor ya está en pausa"],
    [/no configuration file provided|can't find a suitable configuration file|no compose file/, "No se encontró el archivo compose en esa carpeta"],
    [/looking up compose provider failed|no compose provider/, "Podman no encuentra un proveedor de Compose (instala podman-compose o docker-compose)"],
    [/command not found|executable file not found/, "El programa no está instalado en el servidor"],
  ];
  for (const [re, msg] of rules) if (re.test(e)) return raw ? `${msg}\n\n${raw}` : msg;
  return raw;
}

/** Texto de error a partir del resultado. */
export function failureMessage(r: ExecResult): string {
  if (r.timedOut) return "El comando tardó demasiado y se canceló";
  const t = translateError(r.stderr);
  if (t) return t;
  // Comandos con «2>&1» (logs, pull): el error llega por stdout.
  const out = r.stdout.trim();
  if (out) return translateError(out.split("\n").slice(-20).join("\n"));
  return `El comando terminó con código ${r.exitCode ?? "desconocido"}`;
}

/** Ejecuta comandos del motor. Nunca lanza. */
export async function runEngine(sessionId: string, cmds: Cmd[], el: Elevation, timeoutSecs = 60): Promise<EngineRun> {
  try {
    const r = await runScript(sessionId, scriptFor(cmds), el, "", timeoutSecs);
    if (r.exitCode === 0 && !r.timedOut) return { ok: true, result: r, error: null, needSudo: false };
    return { ok: false, result: r, error: failureMessage(r), needSudo: false };
  } catch (e) {
    if (e instanceof ElevationError) {
      return {
        ok: false,
        result: null,
        error: e.message,
        needSudo: e.failure === "bad-password" || e.failure === "need-password",
      };
    }
    return { ok: false, result: null, error: errorMessage(e), needSudo: false };
  }
}

/** Ejecuta un script libre (ya citado) como lecturas: varias secciones marcadas. */
export async function runRaw(sessionId: string, script: string, el: Elevation, timeoutSecs = 30): Promise<EngineRun> {
  try {
    const r = await runScript(sessionId, `${PATH_PREFIX}\n${script}`, el, "", timeoutSecs);
    if (r.timedOut) return { ok: false, result: r, error: "El comando tardó demasiado y se canceló", needSudo: false };
    return { ok: r.exitCode === 0, result: r, error: r.exitCode === 0 ? null : failureMessage(r), needSudo: false };
  } catch (e) {
    if (e instanceof ElevationError) {
      return { ok: false, result: null, error: e.message, needSudo: e.failure === "bad-password" || e.failure === "need-password" };
    }
    return { ok: false, result: null, error: errorMessage(e), needSudo: false };
  }
}
