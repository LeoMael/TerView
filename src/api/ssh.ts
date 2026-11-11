import { call } from "./core";
import type { SessionInfo } from "./types";

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
  disconnect: (sessionId: string) => call<void>("ssh_disconnect", { sessionId }),
  listSessions: () => call<SessionInfo[]>("ssh_list_sessions"),
};
