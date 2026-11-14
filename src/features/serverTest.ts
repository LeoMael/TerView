// «Probar conexión» del editor de servidor: prueba los datos escritos (sin guardarlos) y traduce el
// resultado a lenguaje simple. La huella nueva o cambiada se confirma con el diálogo de siempre.
import { ssh, type ConnectionTest } from "../api/ssh";
import { isApiError, errorMessage } from "../api/core";
import type { AuthMethod, ServerProfile } from "../api/types";
import { newExecId } from "../api/snippets";
import { confirmHostKey } from "./ConnectDialogs";

export type TestOutcome =
  | { status: "ok"; result: ConnectionTest }
  | { status: "error"; message: string }
  | { status: "canceled" };

export interface TestSecrets {
  password?: string;
  passphrase?: string;
  /** Si no se escribió nada, usar el secreto ya guardado del servidor (al editar). */
  useSavedSecret?: boolean;
}

/** Vueltas máximas (cada huella aceptada repite la prueba una vez). */
const MAX_TRIES = 3;

/**
 * Prueba la conexión con un servidor aún sin guardar. `onTestId` recibe el id de cada intento para
 * poder cancelarlo con `ssh.cancelTest`; `canceled()` corta el bucle entre intentos.
 */
export async function testServerConnection(
  draft: ServerProfile,
  secrets: TestSecrets,
  onTestId: (id: string) => void,
  canceled: () => boolean,
): Promise<TestOutcome> {
  for (let i = 0; i < MAX_TRIES; i++) {
    if (canceled()) return { status: "canceled" };
    const id = newExecId();
    onTestId(id);
    try {
      const result = await ssh.testConnection(id, draft, secrets);
      return { status: "ok", result };
    } catch (e) {
      if (canceled() || isApiError(e, "Canceled")) return { status: "canceled" };
      if (isApiError(e) && (e.kind === "HostKeyUnknown" || e.kind === "HostKeyChanged") && e.hostKey) {
        const changed = e.kind === "HostKeyChanged";
        const trust = await confirmHostKey(e.hostKey, changed);
        if (canceled()) return { status: "canceled" };
        if (!trust) {
          return {
            status: "error",
            message: changed
              ? "La huella del servidor cambió y no la aceptaste: no se probó la conexión."
              : "No confirmaste la huella del servidor: no se probó la conexión.",
          };
        }
        try {
          await ssh.trustHost(e.hostKey.host, e.hostKey.port, e.hostKey.keyOpenssh);
        } catch (err) {
          return { status: "error", message: `No se pudo guardar la huella del servidor: ${errorMessage(err)}` };
        }
        continue;
      }
      return { status: "error", message: describeTestError(e, draft.auth) };
    }
  }
  return { status: "error", message: "No se pudo verificar la huella del servidor." };
}

/** Quita el prefijo genérico de los errores del motor («No se pudo conectar: …»). */
function detail(message: string, prefix: string): string {
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/** Error de la prueba en lenguaje simple. */
export function describeTestError(e: unknown, auth: AuthMethod): string {
  if (!isApiError(e)) return errorMessage(e);
  switch (e.kind) {
    case "Network":
      return detail(e.message, "No se pudo conectar: ");
    case "AuthFailed": {
      const d = detail(e.message, "Autenticación fallida: ");
      if (d.includes("frase")) return "La frase de la llave es incorrecta.";
      if (d.includes("segundo método")) return `Llave aceptada, pero ${d}.`;
      if (auth === "password") return "El servidor rechazó el usuario o la contraseña.";
      if (auth === "key") return "El servidor rechazó la llave (¿está su parte pública en ~/.ssh/authorized_keys de ese usuario?).";
      if (auth === "agent") return "El servidor rechazó las llaves del agente SSH.";
      return d;
    }
    case "NeedsPassword":
      return "El servidor pide contraseña: escríbela arriba para probar.";
    case "NeedsPassphrase":
      return "La llave está protegida con frase: escríbela arriba para probar.";
    case "Locked":
      return "SSHorus está bloqueado: escribe tu PIN (o la contraseña aquí) para probar con la guardada.";
    case "HostKeyChanged":
      return "¡La huella del servidor cambió! Podría ser un ataque: no se probó la conexión.";
    default:
      return e.message;
  }
}

/** Texto del resultado correcto. */
export function describeTestOk(r: ConnectionTest, auth: AuthMethod): string {
  const secs = `${(r.elapsedMs / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} s`;
  switch (r.skipped) {
    case "password":
      return `El servidor responde y la huella es correcta (${secs}). No se probó la contraseña porque no la escribiste.`;
    case "passphrase":
      return `El servidor responde y la huella es correcta (${secs}). No se probó la llave: tiene frase y no la escribiste.`;
    case "otp":
      return `El servidor responde (${secs}). Al conectar pedirá un código de verificación (2FA).`;
    default: {
      const what = auth === "password" ? "contraseña aceptada" : auth === "key" ? "llave aceptada" : "agente SSH aceptado";
      return `Conectado: ${what} (${secs}).`;
    }
  }
}
