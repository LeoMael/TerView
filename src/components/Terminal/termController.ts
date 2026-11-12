// Controlador de una terminal: une una instancia de xterm.js con una shell remota.
// Independiente de React: el componente solo lo crea, le pasa cambios y lo destruye.
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { terminal } from "../../api/terminal";
import { errorMessage } from "../../api/core";
import { toast } from "../../stores/toasts";
import { buildSearchDecorations, buildTermTheme, onAppThemeChange } from "./termTheme";
import { ensureExitListener, onTerminalExit } from "./exitEvents";
import { clipboard } from "../../lib/clipboard";
import { getTerminalGpu, isWebglUnsupported, markWebglUnsupported, onTerminalGpuChange } from "./gpuPref";

export type TermStatus = "opening" | "running" | "exited";
/** Estado de la conexión SSH de la pestaña (de `useTabs`). */
export type ConnState = "connected" | "reconnecting" | "closed";

/** Resultado de abrir la shell respecto a tmux. */
export interface TmuxState {
  /** La shell corre dentro de tmux (sobrevive a cortes de red). */
  persistent: boolean;
  /** Se pidió tmux pero el servidor no lo tiene. */
  missing: boolean;
  problem: string | null;
}

export interface TermControllerOptions {
  sessionId: string;
  /** Sesión tmux de esta terminal (null = shell normal). */
  tmuxName: string | null;
  /** Volcar el historial de la sesión tmux al abrirla por primera vez (se reabre una que ya existía). */
  tmuxReplay: boolean;
  /** Tras cada apertura: si quedó dentro de tmux o no. */
  onTmux?: (s: TmuxState) => void;
  fontSize: number;
  fontFamily: string;
  disabled: boolean;
  connState: ConnState;
  onStatus: (s: TermStatus) => void;
  /** Ctrl+Mayús+F: la vista abre la barra de búsqueda. */
  onSearchRequest: () => void;
}

export interface SearchResults {
  index: number;
  count: number;
}

/** Si la shell termina sin código (posible caída de la conexión), se espera esto antes de
 *  decidir qué mensaje mostrar: el vigilante del motor detecta la caída en ~1,5 s. */
const EXIT_GRACE_MS = 2500;

/** Si el contexto WebGL se pierde más veces que esto, la terminal se queda con el dibujado normal. */
const MAX_WEBGL_LOSSES = 2;

const DIM = (s: string) => `\x1b[0m\x1b[2m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[0m\x1b[31m${s}\x1b[0m`;

export class TermController {
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon({ highlightLimit: 2000 });
  private readonly host: HTMLElement;
  private readonly sessionId: string;
  private readonly onStatus: (s: TermStatus) => void;
  private readonly onSearchRequest: () => void;
  private readonly tmuxName: string | null;
  private tmuxReplay: boolean;
  private readonly onTmux: ((s: TmuxState) => void) | undefined;
  /** La shell actual corre dentro de tmux. */
  private persistent = false;
  private disabled: boolean;
  private connState: ConnState;
  /** La shell murió con la conexión (o no pudo abrirse): se reabre al reconectar. */
  private lost = false;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  /** Hay un aviso de salida esperando a saber si fue la conexión. */
  private exitMsgPending = false;

  private status: TermStatus = "opening";
  private termId: string | null = null;
  /** Generación de shell: invalida respuestas de aperturas viejas. */
  private gen = 0;
  private disposed = false;

  // Escritura ordenada: un solo `term_write` en vuelo, el resto se agrupa.
  private pending = "";
  private inFlight = false;

  private fitTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly ro: ResizeObserver;
  private readonly unTheme: () => void;
  private unExit: (() => void) | null = null;
  private readonly unGpu: () => void;
  /** Dibujado por GPU (null = dibujado normal por DOM). */
  private webgl: WebglAddon | null = null;
  private webglLosses = 0;

  constructor(host: HTMLElement, opts: TermControllerOptions) {
    this.host = host;
    this.sessionId = opts.sessionId;
    this.onStatus = opts.onStatus;
    this.onSearchRequest = opts.onSearchRequest;
    this.tmuxName = opts.tmuxName;
    this.tmuxReplay = opts.tmuxReplay;
    this.onTmux = opts.onTmux;
    this.disabled = opts.disabled;
    this.connState = opts.connState;

    this.term = new Terminal({
      fontSize: opts.fontSize,
      fontFamily: opts.fontFamily,
      lineHeight: 1.1,
      theme: buildTermTheme(),
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      // Las decoraciones de la búsqueda usan la API "experimental".
      allowProposedApi: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        ev.preventDefault();
        openUrl(uri).catch((e) => toast.error("No se pudo abrir el enlace", e));
      }),
    );
    this.term.open(host);
    this.term.attachCustomKeyEventHandler(this.handleKey);
    this.term.onData((d) => this.handleInput(d));
    this.term.onResize(() => this.sendResize());

    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(host);
    this.unTheme = onAppThemeChange(() => {
      if (!this.disposed) this.term.options.theme = buildTermTheme();
    });
    this.unGpu = onTerminalGpuChange((on) => {
      if (on) {
        this.webglLosses = 0;
        this.enableWebgl();
      } else this.disableWebgl();
    });
    this.enableWebgl();
    // Cuando cargan las fuentes cambian las medidas de cada celda.
    document.fonts?.ready.then(() => this.fitNow()).catch(() => {});

    this.fitNow();
    void this.start();
  }

  // ───────── Dibujado por GPU (WebGL) ─────────

  /** Activa el dibujado por GPU si está permitido y disponible; si falla, sigue con el normal (DOM). */
  private enableWebgl() {
    if (this.disposed || this.webgl) return;
    if (!getTerminalGpu() || isWebglUnsupported() || this.webglLosses > MAX_WEBGL_LOSSES) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // La tarjeta gráfica se reinició o hay demasiados contextos abiertos: volver al dibujado normal.
        this.webglLosses++;
        this.disableWebgl();
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch (e) {
      console.warn("Terminal: sin aceleración por GPU, se usa el dibujado normal", e);
      markWebglUnsupported();
    }
  }

  private disableWebgl() {
    const w = this.webgl;
    if (!w) return;
    this.webgl = null;
    try {
      w.dispose();
    } catch {
      /* ya estaba liberado */
    }
    if (!this.disposed) this.term.refresh(0, this.term.rows - 1);
  }

  // ───────── Ciclo de vida de la shell ─────────

  private setStatus(s: TermStatus) {
    this.status = s;
    if (!this.disposed) this.onStatus(s);
  }

  private canOpen(): boolean {
    return !this.disposed && !this.disabled && this.connState === "connected";
  }

  private async start() {
    if (!this.canOpen()) return;
    const gen = ++this.gen;
    this.cancelExitMessage();
    this.setStatus("opening");
    try {
      await ensureExitListener();
    } catch {
      /* sin el evento seguimos: la shell funciona, solo no avisará al salir */
    }
    if (this.disposed || gen !== this.gen) return;
    this.fitNow();
    const { cols, rows } = this.term;
    const tmux = this.tmuxName ? { name: this.tmuxName, replay: this.tmuxReplay } : null;
    try {
      const opened = await terminal.open(
        this.sessionId,
        cols,
        rows,
        (bytes) => {
          if (!this.disposed && gen === this.gen) this.term.write(bytes);
        },
        tmux,
      );
      const id = opened.termId;
      if (this.disposed || gen !== this.gen) {
        terminal.close(id).catch(() => {});
        return;
      }
      this.termId = id;
      this.lost = false;
      // El historial ya está en xterm.js: al reabrir (reconexión) no se vuelve a volcar.
      this.tmuxReplay = false;
      this.persistent = opened.tmux !== null;
      this.onTmux?.({ persistent: this.persistent, missing: opened.tmuxMissing, problem: opened.tmuxProblem });
      this.setStatus("running");
      this.unExit = onTerminalExit(id, (code) => this.handleExit(id, code));
      if (this.term.cols !== cols || this.term.rows !== rows) this.sendResize();
      if (this.pending) void this.pump();
    } catch (e) {
      if (this.disposed || gen !== this.gen) return;
      this.pending = "";
      this.lost = true;
      this.setStatus("exited");
      // Si la conexión se está cayendo, el aviso de la pestaña ya lo explica.
      if (this.connState !== "connected") return;
      this.term.write(`\r\n${RED(`No se pudo abrir la shell: ${errorMessage(e)}`)}\r\n`);
      if (!this.disabled) this.term.write(`${DIM("[Pulsa Enter para reintentar]")}\r\n`);
    }
  }

  private handleExit(id: string, code: number | null) {
    if (this.disposed || id !== this.termId) return;
    this.termId = null;
    this.unExit = null;
    this.pending = "";
    // Sin código de salida = el canal se cortó (normalmente, la conexión cayó).
    this.lost = code === null || this.connState !== "connected";
    this.setStatus("exited");
    if (code === null && this.connState === "connected" && !this.disabled) {
      // Esperar a saber si fue la conexión (llegará "reconectando"/"cerrada") antes de avisar.
      this.cancelExitMessage();
      this.exitMsgPending = true;
      this.exitTimer = setTimeout(() => {
        if (!this.exitMsgPending || this.disposed) return;
        this.exitMsgPending = false;
        if (this.status === "exited") this.writeExitMessage(code);
      }, EXIT_GRACE_MS);
      return;
    }
    this.writeExitMessage(code);
  }

  private cancelExitMessage() {
    clearTimeout(this.exitTimer);
    this.exitMsgPending = false;
  }

  private writeExitMessage(code: number | null) {
    let msg: string;
    if (this.disabled || this.connState === "closed") msg = "[Conexión cerrada]";
    else if (this.connState === "reconnecting") msg = "[Conexión perdida]";
    else if (code !== null && code !== 0)
      msg = `[Proceso terminado (código ${code}) — pulsa Enter para abrir otra shell]`;
    else msg = "[Proceso terminado — pulsa Enter para abrir otra shell]";
    this.term.write(`\r\n${DIM(msg)}\r\n`);
  }

  /** La sesión volvió (mismo sessionId, conexión nueva): reabre la shell si murió con la caída.
   *  Conserva el historial; las shells que el usuario cerró a propósito no se tocan. */
  reconnected() {
    if (this.disposed || this.disabled) return;
    this.connState = "connected";
    if (this.status === "exited" && !this.lost) return;
    // Cualquier shell "viva" pertenecía a la conexión anterior: ya no sirve.
    this.cancelExitMessage();
    this.unExit?.();
    this.unExit = null;
    if (this.termId) terminal.close(this.termId).catch(() => {});
    this.termId = null;
    this.pending = "";
    // Con tmux se vuelve a la misma sesión: lo que corría sigue ahí.
    this.term.write(`\r\n${DIM(this.persistent ? "— reconectado: volviendo a la sesión tmux —" : "— reconectado —")}\r\n`);
    void this.start();
  }

  setConnState(state: ConnState) {
    if (this.connState === state) return;
    const prev = this.connState;
    this.connState = state;
    if (state !== "connected") {
      // Nada se acumula mientras no hay conexión.
      this.pending = "";
      if (prev === "connected" && this.exitMsgPending) {
        this.cancelExitMessage();
        this.writeExitMessage(null);
      }
    }
  }

  // ───────── Entrada del usuario ─────────

  private handleInput(data: string) {
    if (this.connState !== "connected") return; // sin conexión no se acumula nada
    if (this.status === "running" && this.termId) {
      this.pending += data;
      void this.pump();
    } else if (this.status === "opening") {
      // Lo tecleado mientras abre se envía al estar lista.
      this.pending += data;
    } else if (this.status === "exited" && !this.disabled && data.includes("\r")) {
      this.term.write("\r\n");
      void this.start();
    }
  }

  private async pump() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.pending && this.termId && !this.disposed) {
        const id = this.termId;
        const data = this.pending;
        this.pending = "";
        try {
          await terminal.write(id, data);
        } catch {
          /* la shell terminó: el evento de salida lo indicará */
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** Texto desde fuera (Biblioteca de comandos): mismo camino ordenado que el teclado.
   *  Si la shell había terminado, abre otra y lo envía al estar lista. */
  sendText(text: string) {
    if (this.disposed || !text || this.disabled || this.connState !== "connected") return;
    if (this.status === "exited") {
      this.pending = text;
      this.term.write("\r\n");
      void this.start();
      return;
    }
    this.handleInput(text);
  }

  private handleKey = (ev: KeyboardEvent): boolean => {
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === "KeyF") {
      if (ev.type === "keydown") {
        ev.preventDefault();
        this.onSearchRequest();
      }
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.code === "KeyC" || ev.code === "KeyV")) {
      if (ev.type === "keydown") {
        ev.preventDefault();
        if (ev.code === "KeyC") this.copy();
        else this.paste();
      }
      return false;
    }
    return true;
  };

  copy() {
    const sel = this.term.getSelection();
    if (!sel) return;
    clipboard.write(sel).catch((e) => toast.error("No se pudo copiar", e));
  }

  paste() {
    clipboard
      .read()
      .then((text) => {
        if (text && !this.disposed) this.term.paste(text);
      })
      .catch((e) => toast.error("No se pudo leer el portapapeles", e));
    this.term.focus();
  }

  selectAll() {
    this.term.selectAll();
  }

  clear() {
    this.term.clear();
    this.term.focus();
  }

  /** La shell actual corre dentro de tmux. */
  isPersistent(): boolean {
    return this.persistent;
  }

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  // ───────── Búsqueda ─────────

  private searchOpts(caseSensitive: boolean, incremental = false) {
    return { caseSensitive, incremental, decorations: buildSearchDecorations() };
  }

  /** Busca hacia abajo. `incremental`: mientras se escribe (no avanza si la actual sigue valiendo). */
  findNext(query: string, caseSensitive: boolean, incremental = false): boolean {
    if (this.disposed || !query) return false;
    return this.search.findNext(query, this.searchOpts(caseSensitive, incremental));
  }

  findPrevious(query: string, caseSensitive: boolean): boolean {
    if (this.disposed || !query) return false;
    return this.search.findPrevious(query, this.searchOpts(caseSensitive));
  }

  clearSearch() {
    if (this.disposed) return;
    this.search.clearDecorations();
    this.term.clearSelection();
  }

  onSearchResults(cb: (r: SearchResults) => void): () => void {
    const d = this.search.onDidChangeResults((e: ISearchResultChangeEvent) =>
      cb({ index: e.resultIndex, count: e.resultCount }),
    );
    return () => d.dispose();
  }

  // ───────── Tamaño ─────────

  private scheduleFit() {
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => this.fitNow(), 50);
  }

  /** Ajusta columnas/filas al contenedor, solo si está visible. */
  fitNow() {
    if (this.disposed) return;
    if (!this.host.offsetWidth || !this.host.offsetHeight) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    if (dims.cols < 2 || dims.rows < 1) return;
    if (dims.cols !== this.term.cols || dims.rows !== this.term.rows) {
      this.term.resize(dims.cols, dims.rows);
    }
  }

  private sendResize() {
    if (!this.termId || this.disposed) return;
    terminal.resize(this.termId, this.term.cols, this.term.rows).catch(() => {});
  }

  // ───────── Cambios desde React ─────────

  show(focus: boolean) {
    requestAnimationFrame(() => {
      if (this.disposed) return;
      // Si perdió el contexto GPU mientras estaba oculta, reintentar (con límite).
      if (!this.webgl) this.enableWebgl();
      this.fitNow();
      if (focus) this.term.focus();
    });
  }

  focus() {
    this.term.focus();
  }

  setFont(size: number, family: string) {
    if (this.disposed) return;
    if (this.term.options.fontSize === size && this.term.options.fontFamily === family) return;
    this.term.options.fontSize = size;
    this.term.options.fontFamily = family;
    this.fitNow();
  }

  setDisabled(disabled: boolean) {
    this.disabled = disabled;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    clearTimeout(this.fitTimer);
    this.cancelExitMessage();
    this.ro.disconnect();
    this.unTheme();
    this.unGpu();
    this.disableWebgl();
    this.unExit?.();
    if (this.termId) terminal.close(this.termId).catch(() => {});
    this.termId = null;
    this.term.dispose();
  }
}
