// Flujo de conexión interactivo. DUEÑO: agente Almacenamiento/Sidebar.
import { ssh } from "../api/ssh";
import { isApiError } from "../api/core";
import type { ServerProfile } from "../api/types";
import { useProfiles } from "../stores/profiles";
import { useTabs, type SessionTab } from "../stores/tabs";
import { toast } from "../stores/toasts";
import { askOtp, askPassphrase, askPassword, confirmHostKey } from "./ConnectDialogs";
import { reconnectTab } from "../components/Session/sessionState";

/** Límite de vueltas para no quedar en bucle si el motor repite siempre el mismo error. */
const MAX_STEPS = 12;

/**
 * Conecta a un servidor resolviendo diálogos (contraseña, frase, código 2FA, huella) y abre su pestaña.
 * Lo escrito en un diálogo se reutiliza en los reintentos del mismo flujo (no se vuelve a pedir).
 * Devuelve true si se conectó.
 */
export async function connectToServer(
  profile: ServerProfile,
  opts: { initialPath?: string | null; restoreTerminals?: string[] } = {},
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
          restoreTerminals: opts.restoreTerminals,
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

// ───────── Ir a la pestaña ya abierta de un servidor ─────────

/** Orden de uso de las pestañas (tabId → contador creciente) para elegir «la última usada». */
const lastUsed = new Map<string, number>();
let useCounter = 0;
function markUsed(id: string | null) {
  if (id) lastUsed.set(id, ++useCounter);
}
markUsed(useTabs.getState().activeTabId);
useTabs.subscribe((s, prev) => {
  if (s.activeTabId !== prev.activeTabId) markUsed(s.activeTabId);
  if (s.tabs !== prev.tabs && s.tabs.length < prev.tabs.length) {
    const alive = new Set(s.tabs.map((t) => t.id));
    for (const id of lastUsed.keys()) if (!alive.has(id)) lastUsed.delete(id);
  }
});

/**
 * Pestaña a la que ir para un servidor, o null si no tiene ninguna.
 * 1) La activa, si ya es de ese servidor. 2) Una viva (conectada o reconectando) antes que una
 * cerrada. 3) Entre ellas, la última usada; si nunca se usó ninguna, la de más a la derecha.
 */
export function pickTabForProfile(
  tabs: readonly SessionTab[],
  activeTabId: string | null,
  profileId: string,
  used: ReadonlyMap<string, number> = lastUsed,
): SessionTab | null {
  const mine = tabs.filter((t) => t.profileId === profileId);
  if (mine.length === 0) return null;
  const active = mine.find((t) => t.id === activeTabId);
  if (active) return active;
  const live = mine.filter((t) => t.status !== "closed");
  const pool = live.length > 0 ? live : mine;
  let best = pool[pool.length - 1];
  let bestUse = used.get(best.id) ?? 0;
  for (const t of pool) {
    const u = used.get(t.id) ?? 0;
    if (u > bestUse) {
      best = t;
      bestUse = u;
    }
  }
  return best;
}

/** Servidores con una apertura/enfoque en curso (incluye el diálogo de «cambios sin guardar» al reconectar). */
const opening = new Set<string>();

/**
 * Abre un servidor «como el usuario espera»: si ya tiene una pestaña, va a ella (y la reconecta si
 * estaba cerrada); si no, conecta. Con `forceNew` abre siempre una conexión más.
 * Mientras haya una conexión en curso a ese servidor no hace nada (evita conexiones dobles).
 */
export async function openOrFocusServer(
  profile: ServerProfile,
  opts: { initialPath?: string | null; forceNew?: boolean } = {},
): Promise<boolean> {
  if (opening.has(profile.id) || useProfiles.getState().connecting[profile.id]) return false;
  const connectOpts = opts.initialPath ? { initialPath: opts.initialPath } : {};
  if (opts.forceNew) return connectToServer(profile, connectOpts);

  const { tabs, activeTabId, setActive } = useTabs.getState();
  const tab = pickTabForProfile(tabs, activeTabId, profile.id);
  if (!tab) return connectToServer(profile, connectOpts);

  setActive(tab.id);
  if (tab.status !== "closed") return true; // conectada o reconectando sola: basta con mostrarla
  opening.add(profile.id);
  try {
    await reconnectTab(tab.id);
  } finally {
    opening.delete(profile.id);
  }
  return true;
}

/**
 * «Conectar a todos» (proyecto): conecta, uno tras otro, solo los servidores SIN pestaña viva.
 * Los que ya están abiertos no se duplican; si su pestaña estaba cerrada, se reconecta.
 * Si no hizo falta abrir nada, se muestra la pestaña del primero.
 */
export async function connectToMany(servers: ServerProfile[]): Promise<void> {
  let firstOpen: string | null = null;
  let changed = false;
  for (const s of servers) {
    if (opening.has(s.id) || useProfiles.getState().connecting[s.id]) continue;
    const tab = pickTabForProfile(useTabs.getState().tabs, null, s.id);
    if (!tab) {
      if (await connectToServer(s)) changed = true;
    } else if (tab.status === "closed") {
      await openOrFocusServer(s);
      changed = true;
    } else {
      firstOpen ??= tab.id;
    }
  }
  if (!changed && firstOpen && useTabs.getState().tabs.some((t) => t.id === firstOpen)) {
    useTabs.getState().setActive(firstOpen);
  }
}
