// Motor de "Ejecutar en varios servidores": cola con concurrencia limitada, conexión en segundo plano,
// ejecución, cancelación y reintentos. No depende de Tauri: las llamadas reales se inyectan (EngineDeps),
// así se puede probar con un motor simulado.
import type { ExecResult } from "../../api/types";
import { isFinal, type AttentionKind, type PrivilegeHint, type RunSpec, type TargetInput, type TargetState } from "./types";

export interface EngineDeps {
  /** Sesión conectada de una pestaña del usuario para ese servidor (se reutiliza), o null. */
  tabSession(profileId: string): string | null;
  /** Conecta sin interacción con las credenciales guardadas. Devuelve el sessionId. Lanza errores con `.kind`. */
  connect(profileId: string): Promise<string>;
  /** Conecta resolviendo diálogos (contraseña, huella, 2FA). null = el usuario canceló. */
  connectInteractive(profileId: string): Promise<string | null>;
  /** Ejecuta con un identificador (`execId`) para poder cancelarlo con `cancelExec`. */
  exec(sessionId: string, command: string, timeoutSecs: number, execId: string): Promise<ExecResult>;
  /** Identificador nuevo y único para `exec`. */
  newExecId(): string;
  /** Pide detener en el servidor la ejecución `execId`. false = no estaba (aún no empezó o ya terminó). */
  cancelExec(execId: string): Promise<boolean>;
  disconnect(sessionId: string): Promise<void>;
  /** Nivel de privilegios (solo lectura, informativo). */
  privilege(sessionId: string, reused: boolean): Promise<PrivilegeHint | null>;
}

/** Ejecución en curso de un servidor (para poder detenerla al cancelar). */
interface InFlight {
  execId: string;
  sessionId: string;
  /** La sesión la abrió la ejecución: se cierra cuando el comando se haya detenido. */
  owned: boolean;
  /** Se cumple cuando `exec` termina (bien o mal). */
  settled: Promise<void>;
}

/** Espera máxima a que el servidor detenga el comando antes de cerrar la sesión propia igualmente. */
const STOP_WAIT_MS = 15_000;
/** Reintentos de `cancelExec` si la ejecución aún no estaba anotada en el motor (llamadas casi a la vez). */
const CANCEL_TRIES = 4;
const CANCEL_RETRY_MS = 250;

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export interface ConnectFailure {
  attention: AttentionKind | null;
  message: string;
}

function errKind(e: unknown): string | null {
  if (e && typeof e === "object" && "kind" in e && typeof (e as { kind: unknown }).kind === "string") {
    return (e as { kind: string }).kind;
  }
  return null;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Error desconocido";
}

/** Traduce un error de conexión sin interacción a "requiere atención" o a error definitivo. */
export function classifyConnectError(e: unknown, auth: TargetInput["auth"]): ConnectFailure {
  switch (errKind(e)) {
    case "NeedsPassword":
      return { attention: "password", message: "Falta la contraseña (no está guardada)" };
    case "NeedsPassphrase":
      return { attention: "passphrase", message: "Falta la frase de la llave" };
    case "NeedsOtp":
      return { attention: "otp", message: "Pide un código de verificación (2FA)" };
    case "HostKeyUnknown":
      return { attention: "hostkey", message: "Servidor desconocido: hay que confirmar su huella" };
    case "HostKeyChanged":
      return { attention: "hostkey-changed", message: "¡La huella del servidor cambió! Revísala antes de continuar" };
    case "AuthFailed":
      if (auth === "password") return { attention: "auth", message: "La contraseña guardada fue rechazada" };
      return { attention: null, message: `Autenticación fallida: ${errText(e)}` };
    default:
      return { attention: null, message: errText(e) };
  }
}

function blank(t: TargetInput): TargetState {
  return {
    ...t,
    status: "queued",
    detail: null,
    attention: null,
    sessionId: null,
    owned: false,
    reused: false,
    connectStartedAt: null,
    execStartedAt: null,
    finishedAt: null,
    result: null,
    privilege: null,
  };
}

export class RunEngine {
  private list: TargetState[];
  private readonly gen = new Map<string, number>();
  /** Sesiones abiertas por la ejecución y aún sin cerrar (profileId → sessionId). */
  private readonly owned = new Map<string, string>();
  /** Comandos ejecutándose ahora (profileId → ejecución). */
  private readonly inFlight = new Map<string, InFlight>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private disposed = false;

  constructor(
    readonly spec: RunSpec,
    inputs: TargetInput[],
    private readonly deps: EngineDeps,
    private readonly onChange: (targets: TargetState[]) => void,
  ) {
    this.list = inputs.map(blank);
  }

  get targets(): TargetState[] {
    return this.list;
  }

  /** Lanza todos los servidores (respetando la concurrencia). */
  start(): void {
    for (const t of this.list) void this.runOne(t.profileId, false);
  }

  /** Vuelve a ejecutar un servidor terminado (o que requiere atención) sin diálogos. */
  retry(profileId: string): void {
    const t = this.find(profileId);
    if (!t || this.disposed || !(isFinal(t.status) || t.status === "attention")) return;
    void this.runOne(profileId, false);
  }

  /** Reintenta todos los que fallaron, se agotaron o se cancelaron. */
  retryFailed(): void {
    for (const t of this.list) if (t.status === "error" || t.status === "timeout" || t.status === "canceled") this.retry(t.profileId);
  }

  /** Resuelve la conexión con diálogos y continúa. Promesa: termina cuando acaba la fase de conexión. */
  resolve(profileId: string): Promise<void> {
    const t = this.find(profileId);
    if (!t || this.disposed || t.status !== "attention") return Promise.resolve();
    return new Promise((res) => void this.runOne(profileId, true, res));
  }

  /** Resuelve uno tras otro todos los que requieren atención (los diálogos no se mezclan). */
  async resolveAll(): Promise<void> {
    for (const t of this.list.slice()) {
      if (this.disposed) return;
      if (this.find(t.profileId)?.status === "attention") await this.resolve(t.profileId);
    }
  }

  cancel(profileId: string): void {
    const t = this.find(profileId);
    if (!t || isFinal(t.status)) return;
    this.bump(profileId);
    const ex = this.inFlight.get(profileId);
    this.patch(profileId, {
      status: "canceled",
      finishedAt: Date.now(),
      detail: ex ? "Cancelado. Se pidió al servidor detener el comando." : "Cancelado",
    });
    if (ex) {
      this.inFlight.delete(profileId);
      this.stopExec(profileId, ex);
    } else {
      this.closeOwned(profileId);
    }
  }

  cancelAll(): void {
    for (const t of this.list) this.cancel(t.profileId);
  }

  /** ¿Queda algo en marcha (en cola, conectando o ejecutando)? */
  get busy(): boolean {
    return this.list.some((t) => t.status === "queued" || t.status === "connecting" || t.status === "running");
  }

  /**
   * Cancela todo y cierra las sesiones propias. Las que tenían un comando en marcha se cierran
   * cuando el servidor lo haya detenido (sin PTY, desconectar no basta para pararlo).
   */
  dispose(): void {
    this.cancelAll();
    this.disposed = true;
    for (const id of Array.from(this.owned.keys())) this.closeOwned(id);
  }

  // ───────── interno ─────────

  private find(profileId: string): TargetState | undefined {
    return this.list.find((t) => t.profileId === profileId);
  }

  private patch(profileId: string, p: Partial<TargetState>) {
    this.list = this.list.map((t) => (t.profileId === profileId ? { ...t, ...p } : t));
    this.onChange(this.list);
  }

  private bump(profileId: string): number {
    const g = (this.gen.get(profileId) ?? 0) + 1;
    this.gen.set(profileId, g);
    return g;
  }

  /** Cierra la sesión propia del servidor (solo si es `only`, cuando se indica). */
  private closeOwned(profileId: string, only?: string) {
    const sid = this.owned.get(profileId);
    if (!sid || (only !== undefined && sid !== only)) return;
    this.owned.delete(profileId);
    this.deps.disconnect(sid).catch(() => {
      /* ya estaba cerrada */
    });
  }

  /**
   * Detiene en el servidor un comando en marcha (pestaña o sesión propia). La sesión propia se cierra
   * después, cuando `exec` termine (el motor necesita la sesión para mandar TERM/KILL), o como mucho
   * a los STOP_WAIT_MS.
   */
  private stopExec(profileId: string, ex: InFlight) {
    void this.requestCancel(ex);
    if (!ex.owned) return;
    // Se quita de la lista ya: un reintento puede abrir otra sesión para el mismo servidor.
    if (this.owned.get(profileId) === ex.sessionId) this.owned.delete(profileId);
    void Promise.race([ex.settled, delay(STOP_WAIT_MS)]).then(() =>
      this.deps.disconnect(ex.sessionId).catch(() => {
        /* ya estaba cerrada */
      }),
    );
  }

  /** Pide cancelar; si el motor aún no conocía la ejecución, lo vuelve a intentar unas veces. */
  private async requestCancel(ex: InFlight) {
    let done = false;
    void ex.settled.then(() => {
      done = true;
    });
    for (let i = 0; i < CANCEL_TRIES && !done; i++) {
      if (await this.deps.cancelExec(ex.execId).catch(() => false)) return;
      await delay(CANCEL_RETRY_MS);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < Math.max(1, this.spec.concurrency)) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((res) =>
      this.waiting.push(() => {
        this.active++;
        res();
      }),
    );
  }

  private release() {
    this.active--;
    this.waiting.shift()?.();
  }

  private async runOne(profileId: string, interactive: boolean, onConnectDone?: () => void): Promise<void> {
    const g = this.bump(profileId);
    const stale = () => this.disposed || this.gen.get(profileId) !== g;
    let connectDone = false;
    const doneConnecting = () => {
      if (!connectDone) {
        connectDone = true;
        onConnectDone?.();
      }
    };
    const prev = this.find(profileId);
    if (!prev) return doneConnecting();
    this.patch(profileId, {
      ...blank(prev),
      // Al resolver, se conserva el motivo hasta que se conecte.
      status: interactive ? "connecting" : "queued",
      attention: interactive ? prev.attention : null,
      detail: interactive ? prev.detail : null,
      connectStartedAt: interactive ? Date.now() : null,
    });

    if (!interactive) await this.acquire();
    try {
      if (stale()) return;
      const t = this.find(profileId);
      if (!t) return;
      this.patch(profileId, { status: "connecting", connectStartedAt: t.connectStartedAt ?? Date.now() });

      let sessionId: string | null = this.deps.tabSession(profileId);
      const reused = sessionId !== null;
      if (sessionId === null) {
        try {
          sessionId = interactive ? await this.deps.connectInteractive(profileId) : await this.deps.connect(profileId);
        } catch (e) {
          if (stale()) return;
          const f = classifyConnectError(e, t.auth);
          if (f.attention && !interactive) {
            this.patch(profileId, { status: "attention", attention: f.attention, detail: f.message });
          } else {
            this.patch(profileId, { status: "error", attention: null, detail: f.message, finishedAt: Date.now() });
          }
          return;
        }
        if (sessionId === null) {
          // El usuario cerró el diálogo: sigue requiriendo atención.
          if (!stale()) this.patch(profileId, { status: "attention", connectStartedAt: null });
          return;
        }
        if (stale()) {
          this.deps.disconnect(sessionId).catch(() => {});
          return;
        }
        this.owned.set(profileId, sessionId);
      }
      doneConnecting();
      this.patch(profileId, { sessionId, owned: !reused, reused, attention: null, detail: null });

      try {
        if (this.spec.usesSudo) {
          const p = await this.deps.privilege(sessionId, reused).catch(() => null);
          if (stale()) return;
          this.patch(profileId, { privilege: p });
        }
        if (stale()) return;
        this.patch(profileId, { status: "running", execStartedAt: Date.now() });
        const execId = this.deps.newExecId();
        const pending = this.deps.exec(sessionId, this.spec.command, this.spec.timeoutSecs, execId);
        const ex: InFlight = {
          execId,
          sessionId,
          owned: !reused,
          settled: pending.then(
            () => {},
            () => {},
          ),
        };
        this.inFlight.set(profileId, ex);
        let r: ExecResult;
        try {
          r = await pending;
        } finally {
          if (this.inFlight.get(profileId) === ex) this.inFlight.delete(profileId);
        }
        if (stale()) return;
        const status = r.timedOut ? "timeout" : r.exitCode === 0 ? "ok" : "error";
        const detail = r.timedOut
          ? `Sin terminar tras ${this.spec.timeoutSecs} s`
          : r.exitCode === null
            ? "El comando terminó sin código de salida"
            : null;
        this.patch(profileId, { status, result: r, detail, finishedAt: Date.now() });
      } catch (e) {
        if (stale()) return;
        this.patch(profileId, { status: "error", detail: errText(e), finishedAt: Date.now() });
      } finally {
        if (!reused) this.closeOwned(profileId, sessionId);
      }
    } finally {
      doneConnecting();
      if (!interactive) this.release();
    }
  }
}
