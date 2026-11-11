// Flujo de conexión interactivo. DUEÑO: agente Almacenamiento/Sidebar.
import { ssh } from "../api/ssh";
import { isApiError } from "../api/core";
import type { ServerProfile } from "../api/types";
import { useProfiles } from "../stores/profiles";
import { useTabs } from "../stores/tabs";
import { toast } from "../stores/toasts";
import { askOtp, askPassphrase, askPassword, confirmHostKey } from "./ConnectDialogs";

/** Límite de vueltas para no quedar en bucle si el motor repite siempre el mismo error. */
const MAX_STEPS = 12;

/**
 * Conecta a un servidor resolviendo diálogos (contraseña, frase, código 2FA, huella) y abre su pestaña.
 * Lo escrito en un diálogo se reutiliza en los reintentos del mismo flujo (no se vuelve a pedir).
 * Devuelve true si se conectó.
 */
export async function connectToServer(
  profile: ServerProfile,
  opts: { initialPath?: string | null } = {},
): Promise<boolean> {
  const store = useProfiles.getState();
  if (store.connecting[profile.id]) return false; // ya hay un intento en curso
  store.setConnecting(profile.id, true);

  let password: string | undefined;
  let passphrase: string | undefined;
  let saveSecret: boolean | undefined;
  /** Código de un solo uso (2FA). Se manda solo en el intento siguiente a pedirlo. */
  let otp: string | undefined;
  /** Pregunta del servidor para el código (se repite si hay que volver a pedirlo). */
  let otpPrompt: string | null = null;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const sentOtp = otp;
      otp = undefined;
      try {
        const info = await ssh.connect(profile.id, { password, passphrase, otp: sentOtp, saveSecret });
        useTabs.getState().openSession(info, {
          color: profile.color,
          initialPath: opts.initialPath ?? profile.defaultPath,
        });
        return true;
      } catch (e) {
        if (!isApiError(e)) {
          toast.error(`No se pudo conectar a ${profile.name}`, e);
          return false;
        }
        switch (e.kind) {
          case "NeedsOtp": {
            otpPrompt = e.message || otpPrompt;
            const code = await askOtp(profile, otpPrompt, sentOtp !== undefined ? "Código incorrecto" : null);
            if (code === null) return false;
            otp = code;
            continue;
          }
          case "NeedsPassword": {
            const r = await askPassword(profile, password !== undefined ? "Contraseña incorrecta" : null);
            if (!r) return false;
            password = r.value;
            saveSecret = r.remember;
            continue;
          }
          case "AuthFailed": {
            if (sentOtp !== undefined) {
              // Se rechazó el intento con código: se vuelve a pedir el código (la contraseña se reutiliza).
              const code = await askOtp(profile, otpPrompt, "Código incorrecto");
              if (code === null) return false;
              otp = code;
              continue;
            }
            if (profile.auth === "password" || password !== undefined) {
              const r = await askPassword(profile, "Contraseña incorrecta");
              if (!r) return false;
              password = r.value;
              saveSecret = r.remember;
              continue;
            }
            toast.error(`Autenticación fallida en ${profile.name}`, e);
            return false;
          }
          case "NeedsPassphrase": {
            const r = await askPassphrase(profile, passphrase !== undefined ? "Frase incorrecta" : null);
            if (!r) return false;
            passphrase = r.value;
            saveSecret = r.remember;
            continue;
          }
          case "HostKeyUnknown":
          case "HostKeyChanged": {
            if (!e.hostKey) {
              toast.error(`No se pudo verificar la huella de ${profile.name}`, e);
              return false;
            }
            const trust = await confirmHostKey(e.hostKey, e.kind === "HostKeyChanged");
            if (!trust) return false;
            try {
              await ssh.trustHost(e.hostKey.host, e.hostKey.port, e.hostKey.keyOpenssh);
            } catch (err) {
              toast.error("No se pudo guardar la huella del servidor", err);
              return false;
            }
            continue;
          }
          case "Canceled":
            return false;
          default:
            toast.error(`No se pudo conectar a ${profile.name}`, e);
            return false;
        }
      }
    }
    toast.error(`No se pudo conectar a ${profile.name}`, "Demasiados intentos");
    return false;
  } finally {
    useProfiles.getState().setConnecting(profile.id, false);
  }
}

/** Conecta a varios servidores, uno tras otro (los diálogos no se pisan). */
export async function connectToMany(servers: ServerProfile[]): Promise<void> {
  for (const s of servers) await connectToServer(s);
}
