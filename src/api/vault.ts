// Bóveda de contraseñas y bloqueo con PIN (motor: src-tauri/src/storage/vault.rs y lock.rs).
import { call } from "./core";

/** Payload: `VaultStatus`. Llega a todas las ventanas cuando se bloquea, desbloquea, crea o quita. */
export const EV_VAULT_STATE = "vault://state";

export interface VaultStatus {
  /** Hay bóveda (si no, las contraseñas van al llavero del sistema). */
  enabled: boolean;
  /** Hay bóveda y falta el PIN. */
  locked: boolean;
  /** Segundos que faltan para poder volver a probar un PIN (0 = ya). */
  retryAfterSecs: number;
}

export interface MoveReport {
  /** Contraseñas movidas. */
  moved: number;
  /** Al activar: copias que no se pudieron borrar del llavero (siguen allí). */
  leftInKeyring: number;
}

/** Largo mínimo del PIN o contraseña maestra. */
export const MIN_PIN = 6;

export const vault = {
  status: () => call<VaultStatus>("vault_status"),
  unlock: (pin: string) => call<VaultStatus>("vault_unlock", { pin }),
  lock: () => call<void>("vault_lock"),
  /** El usuario hizo algo: reinicia la cuenta de inactividad. */
  activity: () => call<void>("vault_activity"),
  /** Crea la bóveda y mueve a ella las contraseñas del llavero. */
  enable: (pin: string) => call<MoveReport>("vault_enable", { pin }),
  /** Quita la bóveda y devuelve las contraseñas al llavero. */
  disable: (pin: string) => call<MoveReport>("vault_disable", { pin }),
  changePin: (oldPin: string, newPin: string) => call<void>("vault_change_pin", { oldPin, newPin }),
  /** «Olvidé mi PIN»: borra la bóveda (se pierden las contraseñas guardadas). */
  reset: () => call<void>("vault_reset"),
};
