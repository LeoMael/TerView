// Estado del bloqueo con PIN en ESTA ventana. El estado de verdad vive en el motor (Rust): aquí solo
// se refleja (evento `vault://state`) para tapar la interfaz. Aunque alguien quitara la pantalla de
// bloqueo, el motor no da contraseñas guardadas mientras esté bloqueado.
//
// initLock() se llama una vez por ventana (principal y editores aparte), ANTES de montar la interfaz:
// así su filtro de teclado va primero y, con TerView bloqueado, ningún atajo ni la terminal reciben
// teclas.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { EV_VAULT_STATE, vault, type VaultStatus } from "../../api/vault";
import { matchesShortcut } from "../shortcuts/shortcuts";
import { useSettings } from "../../stores/settings";
import { toast } from "../../stores/toasts";

interface LockState {
  status: VaultStatus | null;
  /** La interfaz ya se pudo mostrar alguna vez (no estaba bloqueado o se desbloqueó). */
  everOpen: boolean;
  /** Tras «Olvidé mi PIN»: ofrecer crear uno nuevo aunque antes se dijera «Ahora no». */
  offerSetup: boolean;
  /** Diálogo del PIN abierto desde el candado de la barra de pestañas. */
  pinDialog: PinDialog | null;
}

export type PinDialog = "setup" | "change";

export const useLock = create<LockState>(() => ({ status: null, everOpen: false, offerSetup: false, pinDialog: null }));

export function openPinDialog(d: PinDialog) {
  useLock.setState({ pinDialog: d });
}

/** Clase de la pantalla de bloqueo: lo único que recibe teclas mientras está bloqueado. */
export const LOCK_SCREEN_CLASS = "lock-screen";

/** Cada cuánto, como mucho, se avisa al motor de que el usuario hace algo. */
const ACTIVITY_EVERY_MS = 15_000;

/** Ctrl/⌘ + tecla permitidos al escribir el PIN (seleccionar, copiar, pegar, deshacer). */
const EDIT_KEYS = new Set(["a", "c", "v", "x", "z", "y"]);

function isLockShortcut(e: KeyboardEvent): boolean {
  // Ctrl+Shift+L por defecto (no choca con la terminal: Ctrl+L sin Mayús sigue siendo de la shell).
  return matchesShortcut("app.lock", e);
}

/** Aplica un estado recibido del motor. */
export function applyVaultStatus(s: VaultStatus) {
  const prev = useLock.getState().status;
  useLock.setState((st) => ({ status: s, everOpen: st.everOpen || !s.locked }));
  if (s.locked && !prev?.locked) {
    // Que ninguna tecla siga yendo a la terminal o al editor de debajo.
    (document.activeElement as HTMLElement | null)?.blur?.();
    onLockedCb?.();
  }
}

/** Bloquear ahora (si hay PIN). */
export async function lockNow() {
  const s = useLock.getState().status;
  if (!s?.enabled) {
    toast.info("No hay PIN", "Créalo con el candado de la barra de pestañas.");
    return;
  }
  try {
    await vault.lock();
  } catch (e) {
    toast.error("No se pudo bloquear", e);
  }
}

/** Marca «Ahora no» en los ajustes (esperando a que estén cargados, para no pisarlos). */
export async function dismissVaultPrompt() {
  useLock.setState({ offerSetup: false });
  const st = useSettings.getState();
  if (!st.loaded) {
    await new Promise<void>((resolve) => {
      const un = useSettings.subscribe((s) => {
        if (!s.loaded) return;
        un();
        resolve();
      });
    });
  }
  useSettings.getState().update({ vaultPromptDismissed: true });
}

let started = false;
let onLockedCb: (() => void) | undefined;

/** Escucha el estado del motor, filtra el teclado mientras está bloqueado y avisa de la actividad. */
export function initLock(opts: { onLocked?: () => void } = {}) {
  if (started) return;
  started = true;
  onLockedCb = opts.onLocked;

  void listen<VaultStatus>(EV_VAULT_STATE, (e) => applyVaultStatus(e.payload)).catch(() => {});
  vault
    .status()
    .then(applyVaultStatus)
    // Sin respuesta del motor no se puede bloquear nada: mejor dejar usar la app.
    .catch(() => applyVaultStatus({ enabled: false, locked: false, retryAfterSecs: 0, pinKind: "pin6" }));

  // Fase de captura y registrado antes que nadie: va primero.
  window.addEventListener(
    "keydown",
    (e) => {
      const s = useLock.getState().status;
      if (s?.locked) {
        const inLock = !!(e.target as Element | null)?.closest?.(`.${LOCK_SCREEN_CLASS}`);
        const mod = e.ctrlKey || e.metaKey || e.altKey;
        const editKey = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && EDIT_KEYS.has(e.key.toLowerCase());
        if (inLock && (!mod || editKey)) return; // escribir el PIN
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (isLockShortcut(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void lockNow();
      }
    },
    true,
  );

  // Actividad del usuario (para el bloqueo por inactividad, que decide el motor).
  let last = 0;
  const onActivity = () => {
    const s = useLock.getState().status;
    if (!s?.enabled || s.locked) return;
    const now = Date.now();
    if (now - last < ACTIVITY_EVERY_MS) return;
    last = now;
    vault.activity().catch(() => {});
  };
  for (const ev of ["keydown", "pointerdown", "pointermove", "wheel"]) {
    window.addEventListener(ev, onActivity, { capture: true, passive: true });
  }
}
