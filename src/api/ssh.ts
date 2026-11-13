import { call } from "./core";
import type { ServerProfile, SessionInfo } from "./types";

/** Resultado correcto de «Probar conexión». */
export interface ConnectionTest {
  /**
   * null = se comprobó todo. Si no: lo que no se pudo probar (contraseña o frase sin escribir, o el
   * servidor pide un código 2FA); la red y la huella sí se comprobaron.
   */
  skipped: "password" | "passphrase" | "otp" | null;
  elapsedMs: number;
}

export const ssh = {
  /** Errores esperados: NeedsOtp (pedir código 2FA y reintentar con otp + la misma contraseña), NeedsPassword, NeedsPassphrase, AuthFailed, HostKeyUnknown, HostKeyChanged, Network. */
  connect: (
    profileId: string,
    opts: { password?: string; passphrase?: string; otp?: string; saveSecret?: boolean } = {},
  ) =>
    call<SessionInfo>("ssh_connect", {
      profileId,
      password: opts.password ?? null,
      passphrase: opts.passphrase ?? null,
      otp: opts.otp ?? null,
      saveSecret: opts.saveSecret ?? null,
    }),
  trustHost: (host: string, port: number, keyOpenssh: string) =>
    call<void>("ssh_trust_host", { host, port, keyOpenssh }),
  /**
   * «Probar conexión» del editor de servidor: conecta y autentica con los datos del formulario (sin
   * guardar nada) y desconecta. Máx. 10 s. Errores: los de `connect` (sin NeedsPassword/NeedsOtp:
   * van en `skipped`) y Canceled.
   */
  testConnection: (
    testId: string,
    profile: ServerProfile,
    opts: { password?: string; passphrase?: string; useSavedSecret?: boolean } = {},
  ) =>
    call<ConnectionTest>("ssh_test_connection", {
      testId,
      profile,
      password: opts.password ?? null,
      passphrase: opts.passphrase ?? null,
      useSavedSecret: opts.useSavedSecret ?? null,
    }),
  cancelTest: (testId: string) => call<void>("ssh_cancel_test", { testId }),
  disconnect: (sessionId: string) => call<void>("ssh_disconnect", { sessionId }),
  listSessions: () => call<SessionInfo[]>("ssh_list_sessions"),
};
