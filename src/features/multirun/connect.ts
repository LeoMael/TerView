// Conexión con diálogos (contraseña, frase, 2FA, huella) SIN abrir pestaña.
// Misma lógica que features/connect.ts (connectToServer), reutilizando sus diálogos.
import { ssh } from "../../api/ssh";
import { isApiError } from "../../api/core";
import type { ServerProfile } from "../../api/types";
import { toast } from "../../stores/toasts";
import { askOtp, askPassphrase, askPassword, confirmHostKey } from "../ConnectDialogs";

const MAX_STEPS = 12;

/**
 * Devuelve el sessionId, o null si el usuario canceló un diálogo.
 * Lanza el error del motor si no se puede resolver con un diálogo (red, autenticación con llave…).
 */
export async function connectInBackground(profile: ServerProfile): Promise<string | null> {
  let password: string | undefined;
  let passphrase: string | undefined;
  let saveSecret: boolean | undefined;
  let otp: string | undefined;
  let otpPrompt: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const sentOtp = otp;
    otp = undefined;
    try {
      const info = await ssh.connect(profile.id, { password, passphrase, otp: sentOtp, saveSecret });
      return info.id;
    } catch (e) {
      if (!isApiError(e)) throw e;
      switch (e.kind) {
        case "NeedsOtp": {
          otpPrompt = e.message || otpPrompt;
          const code = await askOtp(profile, otpPrompt, sentOtp !== undefined ? "Código incorrecto" : null);
          if (code === null) return null;
          otp = code;
          continue;
        }
        case "NeedsPassword": {
          const r = await askPassword(profile, password !== undefined ? "Contraseña incorrecta" : null);
          if (!r) return null;
          password = r.value;
          saveSecret = r.remember;
          continue;
        }
        case "AuthFailed": {
          if (sentOtp !== undefined) {
            const code = await askOtp(profile, otpPrompt, "Código incorrecto");
            if (code === null) return null;
            otp = code;
            continue;
          }
          if (profile.auth === "password" || password !== undefined) {
            const r = await askPassword(profile, "Contraseña incorrecta");
            if (!r) return null;
            password = r.value;
            saveSecret = r.remember;
            continue;
          }
          throw e;
        }
        case "NeedsPassphrase": {
          const r = await askPassphrase(profile, passphrase !== undefined ? "Frase incorrecta" : null);
          if (!r) return null;
          passphrase = r.value;
          saveSecret = r.remember;
          continue;
        }
        case "HostKeyUnknown":
        case "HostKeyChanged": {
          if (!e.hostKey) throw e;
          const trust = await confirmHostKey(e.hostKey, e.kind === "HostKeyChanged");
          if (!trust) return null;
          try {
            await ssh.trustHost(e.hostKey.host, e.hostKey.port, e.hostKey.keyOpenssh);
          } catch (err) {
            toast.error("No se pudo guardar la huella del servidor", err);
            return null;
          }
          continue;
        }
        case "Canceled":
          return null;
        default:
          throw e;
      }
    }
  }
  throw new Error("Demasiados intentos de conexión");
}
