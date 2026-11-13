// Diálogo «Nuevo servidor / Editar servidor», ligado a useUi().serverEditor.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { AlertTriangle, Check, ChevronDown, CircleCheck, CircleX, FolderOpen, Info, PlugZap } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import { profiles as profilesApi, sshAliases, type SshAliasInfo } from "../api/profiles";
import { errorMessage } from "../api/core";
import { ssh } from "../api/ssh";
import type { AuthMethod, ServerProfile, SudoMode, TmuxMode } from "../api/types";
import { useProfiles } from "../stores/profiles";
import { useUi, type ServerEditorOptions } from "../stores/ui";
import { toast } from "../stores/toasts";
import { ColorPicker } from "./ColorPicker";
import { SSH_CONFIG_LABEL, SSH_KEY_EXAMPLE } from "../lib/platform";
import { SshAliasMatches, describeMatch } from "./sshAliases";
import { TMUX_MODE_HINTS, TMUX_MODE_LABELS } from "./tmux/logic";
import { useSettings } from "../stores/settings";
import { SecretInput } from "./SecretInput";
import { initialProjectFor, projectChanges } from "./projectServers";
import { findMatches, hostSuggestions, serverAddress, type ServerMatches } from "./serverMatches";
import { describeTestOk, testServerConnection, type TestOutcome } from "./serverTest";

/** Dónde van las contraseñas guardadas. */
const SAVE_TIP = "Se guarda cifrada con tu PIN o, si no tienes PIN, en el llavero del sistema.";

export function ServerEditorHost() {
  const editor = useUi((s) => s.serverEditor);
  const close = useUi((s) => s.closeServerEditor);
  if (!editor) return null;
  return (
    <ServerEditor
      key={`${editor.server?.id || "new"}:${editor.projectId ?? ""}`}
      initial={editor.server}
      fromProjectId={editor.projectId ?? null}
      onSaved={editor.onSaved}
      onClose={close}
    />
  );
}

type Errors = Partial<Record<"name" | "host" | "port" | "username" | "keyPath" | "alias", string>>;

const AUTH_OPTIONS: { value: AuthMethod; label: string }[] = [
  { value: "password", label: "Contraseña" },
  { value: "key", label: "Llave SSH" },
  { value: "agent", label: "Agente SSH" },
];

const SUDO_OPTIONS: { value: SudoMode; label: string; hint: string }[] = [
  { value: "ask", label: "Pedir cada vez", hint: "Se pide al administrar y se olvida al cerrar la conexión." },
  { value: "login", label: "La de la conexión", hint: "Usa la contraseña de arriba (tiene que estar guardada)." },
  { value: "saved", label: "Guardar", hint: "Útil si entras con llave SSH: sudo sigue pidiendo tu contraseña." },
];

function ServerEditor({
  initial,
  fromProjectId,
  onSaved,
  onClose,
}: {
  initial: ServerProfile | null;
  /** Abierto desde un proyecto (p. ej. «Añadir servidor nuevo…» en la barra lateral). */
  fromProjectId: string | null;
  onSaved?: ServerEditorOptions["onSaved"];
  onClose: () => void;
}) {
  const isNew = !initial || initial.id === "";
  const projects = useProfiles((s) => s.projects);
  const saveServer = useProfiles((s) => s.saveServer);
  const saveProject = useProfiles((s) => s.saveProject);

  // Proyecto en el que empieza el selector y proyecto en el que está de verdad el servidor
  // (un servidor nuevo aún no está en ninguno).
  const [initialProjectId] = useState(() => initialProjectFor(projects, initial?.id ?? "", fromProjectId));
  const memberProjectId = isNew ? "" : initialProjectId;
  /** Con un proyecto de origen, el selector va arriba y se explica dónde quedará el servidor. */
  const showProjectOnTop = isNew && initialProjectId !== "";

  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? "");
  const [auth, setAuth] = useState<AuthMethod>(initial?.auth ?? "password");
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(true);
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "");
  const [defaultPath, setDefaultPath] = useState(initial?.defaultPath ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  /** null = usar el ajuste general. */
  const [tmux, setTmux] = useState<TmuxMode | null>(initial?.tmux ?? null);
  const globalTmux = useSettings((s) => s.settings.terminalTmux);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  /** null = desconocido (nuevo o llavero no disponible). */
  const [hasSecret, setHasSecret] = useState<boolean | null>(null);
  const [sudoMode, setSudoMode] = useState<SudoMode>(initial?.sudoMode ?? "ask");
  const [sudoSecret, setSudoSecret] = useState("");
  const [hasSudoSecret, setHasSudoSecret] = useState<boolean | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const alias = useSshAlias(initial?.id ?? "", name, host);
  const servers = useProfiles((s) => s.servers);
  const selfId = initial?.id ?? "";
  const matches = useMemo(() => findMatches(servers, selfId, host, port, username), [servers, selfId, host, port, username]);

  // ── Probar conexión ──
  /** Datos de conexión del formulario (sin el secreto): si cambian, hay que volver a probar. */
  const connKey = (h: string, p: string, u: string, a: AuthMethod, k: string) =>
    JSON.stringify([h.trim().toLowerCase(), Number(p) || 22, u.trim(), a, a === "key" ? k.trim() : ""]);
  const [initialConnKey] = useState(() =>
    connKey(initial?.host ?? "", String(initial?.port ?? 22), initial?.username ?? "", initial?.auth ?? "password", initial?.keyPath ?? ""),
  );
  const baseKey = connKey(host, port, username, auth, keyPath);
  /** Firma de lo que se prueba (incluye el secreto escrito; solo vive en memoria). */
  const testSig = JSON.stringify([baseKey, auth === "agent" ? "" : secret]);
  /** Servidor nuevo, o al editar: cambió el host, puerto, usuario, autenticación o el secreto. */
  const connChanged = isNew || baseKey !== initialConnKey || (auth !== "agent" && secret !== "");
  const [test, setTest] = useState<{ sig: string; outcome: TestOutcome } | null>(null);
  /** Prueba en curso: «manual» (botón) o «save» (al guardar). */
  const [testing, setTesting] = useState<"manual" | "save" | null>(null);
  const runRef = useRef<{ id: string | null; canceled: boolean; sig: string } | null>(null);
  const testBoxRef = useRef<HTMLDivElement>(null);
  /** Resultado de la última prueba si sigue valiendo para los datos actuales. */
  const current = test && test.sig === testSig ? test.outcome : null;
  const failedNow = current?.status === "error";

  useEffect(() => {
    firstRef.current?.focus();
    if (isNew || !initial) return;
    let alive = true;
    profilesApi
      .hasSecret(initial.id)
      .then((v) => {
        if (alive) setHasSecret(v);
      })
      .catch(() => alive && setHasSecret(null));
    profilesApi
      .hasSecret(initial.id, "sudo")
      .then((v) => alive && setHasSudoSecret(v))
      .catch(() => alive && setHasSudoSecret(null));
    return () => {
      alive = false;
    };
  }, [isNew, initial]);

  const clearErr = (k: keyof Errors) => setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));

  const validate = (): Errors => {
    const e: Errors = {};
    const h = host.trim();
    if (!h) e.host = "Indica el host o la IP";
    else if (/\s/.test(h)) e.host = "El host no puede tener espacios";
    if (!username.trim()) e.username = "Indica el usuario";
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = "Puerto entre 1 y 65535";
    if (auth === "key" && !keyPath.trim()) e.keyPath = "Elige la llave privada";
    if (alias.error) e.alias = alias.error;
    return e;
  };

  const browseKey = async () => {
    try {
      let defaultPath: string | undefined;
      try {
        defaultPath = await join(await homeDir(), ".ssh");
      } catch {
        defaultPath = undefined;
      }
      const picked = await openFileDialog({ title: "Elegir llave privada", defaultPath, multiple: false, directory: false });
      if (typeof picked === "string") {
        setKeyPath(picked);
        clearErr("keyPath");
      }
    } catch (e) {
      toast.error("No se pudo abrir el selector de archivos", e);
    }
  };

  /** Servidor con los datos del formulario (para guardar o probar). */
  const buildServer = (): ServerProfile => ({
    id: initial?.id ?? "",
    name: name.trim() || host.trim(),
    host: host.trim(),
    port: Number(port),
    username: username.trim(),
    auth,
    keyPath: auth === "key" ? keyPath.trim() : null,
    defaultPath: defaultPath.trim() || null,
    color,
    tmux,
    sudoMode: sudoMode === "login" && auth !== "password" ? "ask" : sudoMode,
  });

  /** Cancela la prueba en curso. Devuelve si había una. */
  const cancelTest = (): boolean => {
    const run = runRef.current;
    if (!run) return false;
    run.canceled = true;
    runRef.current = null;
    if (run.id) ssh.cancelTest(run.id).catch(() => {});
    setTesting(null);
    setTest({ sig: run.sig, outcome: { status: "canceled" } });
    return true;
  };
  // Al cerrar el editor no se deja ninguna prueba en marcha.
  const cancelRef = useRef(cancelTest);
  cancelRef.current = cancelTest;
  useEffect(() => () => void cancelRef.current(), []);

  useEffect(() => {
    if (test) testBoxRef.current?.scrollIntoView({ block: "nearest" });
  }, [test]);

  /** Prueba la conexión con lo escrito (nada se guarda). null = datos incompletos o cancelada. */
  const runTest = async (why: "manual" | "save"): Promise<TestOutcome | null> => {
    const e = validate();
    const connErrors: Errors = { host: e.host, port: e.port, username: e.username, keyPath: e.keyPath };
    if (Object.values(connErrors).some(Boolean)) {
      setErrors((old) => ({ ...old, ...connErrors }));
      return null;
    }
    cancelRef.current();
    const run = { id: null as string | null, canceled: false, sig: testSig };
    runRef.current = run;
    setTesting(why);
    setTest(null);
    const typed = auth === "agent" ? "" : secret;
    const outcome = await testServerConnection(
      buildServer(),
      {
        password: auth === "password" && typed ? typed : undefined,
        passphrase: auth === "key" && typed ? typed : undefined,
        // Al editar sin escribir el secreto: el ya guardado (si es del mismo método).
        useSavedSecret: !isNew && !typed && !!hasSecret && initial?.auth === auth,
      },
      (id) => (run.id = id),
      () => run.canceled,
    );
    if (runRef.current !== run) return null; // cancelada o cerrada
    runRef.current = null;
    setTesting(null);
    setTest({ sig: run.sig, outcome });
    return outcome.status === "canceled" ? null : outcome;
  };

  /** Guarda. Si cambiaron los datos de conexión, antes prueba la conexión (salvo `force`). */
  const save = async (force = false) => {
    if (testing) return;
    const e = validate();
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;

    if (!force && connChanged) {
      // Si ya se probó con estos mismos datos no se repite; si no (o se canceló), se prueba ahora.
      const outcome = current && current.status !== "canceled" ? current : await runTest("save");
      // Fallo: el resultado queda a la vista con «Guardar de todos modos».
      if (!outcome || outcome.status !== "ok") return;
    }

    const server = buildServer();

    // Qué hacer con el llavero: undefined = no tocar, "" = borrar, texto = guardar.
    let newSecret: string | undefined;
    const authChanged = !isNew && initial?.auth !== auth;
    if (auth === "password" || auth === "key") {
      if (secret !== "" && remember) newSecret = secret;
      else if (!remember && hasSecret) newSecret = "";
      else if (authChanged && hasSecret) newSecret = ""; // el secreto antiguo era de otro tipo
    } else if (authChanged && hasSecret) {
      newSecret = "";
    }

    // Contraseña de sudo guardada: solo con «Guardar»; si se cambia a otro modo, se borra.
    let newSudoSecret: string | undefined;
    if (server.sudoMode === "saved") {
      if (sudoSecret !== "") newSudoSecret = sudoSecret;
    } else if (hasSudoSecret) {
      newSudoSecret = "";
    }

    setSaving(true);
    const saved = await saveServer(server, newSecret, newSudoSecret);
    if (!saved) {
      setSaving(false);
      return;
    }
    if (alias.changed) {
      try {
        await sshAliases.set({ [saved.id]: alias.value.trim() || null });
      } catch (err) {
        toast.error(`No se pudo guardar el alias de ${SSH_CONFIG_LABEL}`, err);
      }
    }
    for (const p of projectChanges(useProfiles.getState().projects, saved.id, memberProjectId, projectId)) {
      await saveProject(p);
    }
    setSaving(false);
    onClose();
    onSaved?.(saved, projectId);
  };

  const projectSelect = (
    <select
      className="select"
      value={projectId}
      aria-label="Proyecto"
      onChange={(e) => setProjectId(e.target.value)}
    >
      <option value="">{showProjectOnTop ? "Ninguno (sin proyecto)" : "Ninguno"}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  const chosenProject = projects.find((p) => p.id === projectId);

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      void save(failedNow);
    }
  };

  /** Escape / cerrar con una prueba en marcha: primero se cancela la prueba. */
  const close = () => {
    if (!cancelTest()) onClose();
  };

  /** Abre el servidor ya guardado que coincide (descarta lo escrito aquí). */
  const openExisting = (s: ServerProfile) => {
    cancelTest();
    useUi.getState().openServerEditor(s, { projectId: fromProjectId, onSaved });
  };
  /** Abierto desde un proyecto: añade a él el servidor ya guardado en vez de crear otro igual. */
  const addExistingToProject = async (s: ServerProfile, projectToAdd: string) => {
    const proj = useProfiles.getState().projects.find((x) => x.id === projectToAdd);
    if (!proj || proj.serverIds.includes(s.id)) return;
    cancelTest();
    await saveProject({ ...proj, serverIds: [...proj.serverIds, s.id] });
    onClose();
    onSaved?.(s, proj.id);
  };

  const secretPlaceholder = hasSecret ? "•••••• (guardada; escribe para cambiarla)" : "";

  return (
    <Modal
      open
      title={isNew ? "Nuevo servidor" : "Editar servidor"}
      onClose={close}
      width={520}
      footer={
        <>
          {testing ? (
            <button className="btn cd-footer-left" onClick={() => cancelTest()}>
              Cancelar prueba
            </button>
          ) : (
            <button
              className="btn cd-footer-left"
              onClick={() => void runTest("manual")}
              disabled={saving}
              title="Conecta con estos datos, sin guardar nada, y desconecta (máx. 10 s)"
            >
              <PlugZap size={14} /> Probar conexión
            </button>
          )}
          <button className="btn" onClick={close}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={() => void save(failedNow)} disabled={saving || testing !== null}>
            {saving || testing === "save" ? <span className="spinner cd-btn-spinner" /> : null}
            {testing === "save" ? "Probando conexión…" : failedNow ? "Guardar de todos modos" : "Guardar"}
          </button>
        </>
      }
    >
      <div className="cd-form" onKeyDown={onEnter}>
        {showProjectOnTop && (
          <label className="field">
            <span>Proyecto</span>
            {projectSelect}
            <small className="cd-field-hint">
              {chosenProject ? (
                <>
                  Se añadirá al proyecto <strong>{chosenProject.name}</strong>.
                </>
              ) : (
                "No se añadirá a ningún proyecto; quedará solo en «Servidores»."
              )}
            </small>
          </label>
        )}

        <label className="field">
          <span>Nombre</span>
          <input
            ref={firstRef}
            className="input"
            value={name}
            placeholder={host.trim() || "p. ej. web-prod"}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Alias para ssh (opcional)</span>
          <input
            className="input mono"
            value={alias.value}
            spellCheck={false}
            autoCapitalize="off"
            placeholder={alias.info && !alias.value.trim() ? `${alias.info.alias} (automático)` : "Se genera a partir del nombre"}
            onChange={(e) => {
              alias.setValue(e.target.value);
              clearErr("alias");
            }}
          />
          <AliasNote state={alias} />
        </label>

        <div className="field-row">
          <div className="field cd-grow">
            <span id="cd-host-label">Host</span>
            <HostCombo
              value={host}
              servers={servers}
              selfId={selfId}
              onChange={(v) => {
                setHost(v);
                clearErr("host");
              }}
              onPick={(s) => {
                setHost(s.host.trim());
                setPort(String(s.port || 22));
                clearErr("host");
                clearErr("port");
              }}
            />
            {errors.host && <div className="cd-err">{errors.host}</div>}
          </div>
          <label className="field cd-port">
            <span>Puerto</span>
            <input
              className="input mono"
              inputMode="numeric"
              value={port}
              onChange={(e) => {
                setPort(e.target.value.replace(/[^\d]/g, ""));
                clearErr("port");
              }}
            />
            {errors.port && <div className="cd-err">{errors.port}</div>}
          </label>
        </div>

        <label className="field">
          <span>Usuario</span>
          <input
            className="input mono"
            value={username}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="root"
            onChange={(e) => {
              setUsername(e.target.value);
              clearErr("username");
            }}
          />
          {errors.username && <div className="cd-err">{errors.username}</div>}
        </label>

        <MatchNote
          matches={matches}
          onOpen={openExisting}
          addTo={isNew && projectId ? projects.find((p) => p.id === projectId) ?? null : null}
          onAdd={(s, pid) => void addExistingToProject(s, pid)}
        />

        <div className="field">
          <span>Autenticación</span>
          <div className="cd-segmented" role="radiogroup" aria-label="Autenticación">
            {AUTH_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={auth === o.value}
                className={auth === o.value ? "active" : ""}
                onClick={() => {
                  setAuth(o.value);
                  setSecret("");
                  if (o.value !== "password" && sudoMode === "login") setSudoMode("ask");
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {auth === "password" && (
          <>
            <div className="field">
              <span>Contraseña</span>
              <SecretInput
                profileId={initial?.id ?? ""}
                kind="login"
                stored={!!hasSecret}
                value={secret}
                onChange={setSecret}
                label="Contraseña"
                placeholder={secretPlaceholder || "Opcional: se pedirá al conectar"}
              />
            </div>
            <label className="checkbox cd-check" title={SAVE_TIP}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Guardar contraseña
            </label>
          </>
        )}

        {auth === "key" && (
          <>
            <label className="field">
              <span>Llave privada</span>
              <div className="cd-inline-row">
                <input
                  className="input mono cd-grow"
                  value={keyPath}
                  spellCheck={false}
                  placeholder={SSH_KEY_EXAMPLE}
                  onChange={(e) => {
                    setKeyPath(e.target.value);
                    clearErr("keyPath");
                  }}
                />
                <button type="button" className="btn" onClick={() => void browseKey()}>
                  <FolderOpen size={14} /> Examinar…
                </button>
              </div>
              {errors.keyPath && <div className="cd-err">{errors.keyPath}</div>}
            </label>
            <div className="field">
              <span>Frase de la llave (opcional)</span>
              <SecretInput
                profileId={initial?.id ?? ""}
                kind="login"
                stored={!!hasSecret}
                value={secret}
                onChange={setSecret}
                label="Frase de la llave"
                placeholder={secretPlaceholder || "Si la llave está protegida"}
              />
            </div>
            <label className="checkbox cd-check" title={SAVE_TIP}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Guardar la frase
            </label>
          </>
        )}

        {auth === "agent" && (
          <div className="cd-hint">Se usarán las llaves cargadas en tu agente SSH (ssh-agent).</div>
        )}

        <div ref={testBoxRef}>
          <TestResult testing={testing} outcome={current} auth={auth} onSaveAnyway={() => void save(true)} />
        </div>

        <div className="field">
          <span>Contraseña de sudo</span>
          <div className="cd-segmented" role="radiogroup" aria-label="Contraseña de sudo">
            {SUDO_OPTIONS.filter((o) => o.value !== "login" || auth === "password").map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={sudoMode === o.value}
                className={sudoMode === o.value ? "active" : ""}
                onClick={() => setSudoMode(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {sudoMode === "saved" && (
            <SecretInput
              profileId={initial?.id ?? ""}
              kind="sudo"
              stored={!!hasSudoSecret}
              value={sudoSecret}
              onChange={setSudoSecret}
              label="Contraseña de sudo"
              placeholder={hasSudoSecret ? "•••••• (guardada; escribe para cambiarla)" : "Tu contraseña en el servidor"}
            />
          )}
          <small className="cd-field-hint">
            {sudoMode === "login" && !remember
              ? "Marca «Guardar contraseña» para usarla con sudo."
              : SUDO_OPTIONS.find((o) => o.value === sudoMode)?.hint}
          </small>
        </div>

        <label className="field">
          <span>Carpeta inicial (opcional)</span>
          <input
            className="input mono"
            value={defaultPath}
            spellCheck={false}
            placeholder="Carpeta personal del usuario"
            onChange={(e) => setDefaultPath(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Terminales persistentes (tmux)</span>
          <select
            className="select"
            value={tmux ?? ""}
            onChange={(e) => setTmux(e.target.value === "" ? null : (e.target.value as TmuxMode))}
          >
            <option value="">Como en Ajustes ({TMUX_MODE_LABELS[globalTmux]})</option>
            <option value="auto">{TMUX_MODE_LABELS.auto}: si el servidor tiene tmux</option>
            <option value="always">{TMUX_MODE_LABELS.always}: avisar si falta tmux</option>
            <option value="never">{TMUX_MODE_LABELS.never}</option>
          </select>
          <small className="cd-field-hint">{TMUX_MODE_HINTS[tmux ?? globalTmux]}</small>
        </label>

        <div className="field-row">
          <div className="field">
            <span>Color</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {!showProjectOnTop && (
            <label className="field">
              <span>Proyecto</span>
              {projectSelect}
            </label>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ───────── Host con sugerencias de los servidores guardados ─────────

function HostCombo({
  value,
  servers,
  selfId,
  onChange,
  onPick,
}: {
  value: string;
  servers: readonly ServerProfile[];
  selfId: string;
  onChange: (v: string) => void;
  onPick: (s: ServerProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  /** Al enfocar se ven todos; al escribir, solo los que coinciden. */
  const [filterOn, setFilterOn] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => hostSuggestions(servers, selfId), [servers, selfId]);
  const shown = useMemo(
    () => (filterOn && value.trim() ? hostSuggestions(servers, selfId, value) : all),
    [all, servers, selfId, value, filterOn],
  );
  const show = open && shown.length > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (hi >= 0) listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const pick = (s: ServerProfile) => {
    onPick(s);
    setOpen(false);
    setHi(-1);
  };

  return (
    <div className="cd-combo" ref={wrapRef}>
      <input
        id="cd-host"
        aria-labelledby="cd-host-label"
        className="input mono"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder="servidor.com o 192.168.1.10"
        role="combobox"
        aria-expanded={show}
        aria-controls="cd-host-list"
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setFilterOn(true);
          setOpen(true);
          setHi(-1);
        }}
        onFocus={() => {
          setFilterOn(false);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && shown.length) {
            e.preventDefault();
            e.stopPropagation();
            if (!open) {
              setOpen(true);
              setHi(0);
            } else setHi((h) => Math.min(shown.length - 1, h + 1));
          } else if (e.key === "ArrowUp" && show) {
            e.preventDefault();
            e.stopPropagation();
            setHi((h) => Math.max(0, h - 1));
          } else if (e.key === "Enter" && show && hi >= 0 && shown[hi]) {
            // Elegir la sugerencia, no guardar el formulario.
            e.preventDefault();
            e.stopPropagation();
            pick(shown[hi]);
          } else if (e.key === "Escape" && show) {
            // Cerrar la lista sin cerrar el editor.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {all.length > 0 && (
        <button
          type="button"
          className="cd-combo-btn"
          tabIndex={-1}
          title="Servidores guardados"
          aria-label="Ver servidores guardados"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setFilterOn(false);
            setOpen((o) => !o);
          }}
        >
          <ChevronDown size={14} />
        </button>
      )}
      {show && (
        <div className="cd-combo-list" id="cd-host-list" ref={listRef} role="listbox" aria-label="Servidores guardados">
          {shown.map((s, i) => {
            const sel = s.host.trim().toLowerCase() === value.trim().toLowerCase();
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={sel}
                className={`cd-combo-item${i === hi ? " hi" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                onMouseEnter={() => setHi(i)}
              >
                <span className="cd-combo-name">{s.name || s.host}</span>
                <span className="mono faint">{serverAddress(s)}</span>
                {sel && <Check size={13} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Aviso de servidor repetido (mismo host, puerto y usuario) o del mismo host con otro usuario. */
function MatchNote({
  matches,
  onOpen,
  addTo,
  onAdd,
}: {
  matches: ServerMatches;
  onOpen: (s: ServerProfile) => void;
  /** Proyecto al que se va a añadir el servidor nuevo (para ofrecer añadir el ya guardado). */
  addTo: { id: string; name: string; serverIds: string[] } | null;
  onAdd: (s: ServerProfile, projectId: string) => void;
}) {
  const { exact, sameHost } = matches;
  if (exact) {
    return (
      <div className="ssha-inline warn cd-match" role="status">
        <div className="ssha-inline-row">
          <AlertTriangle size={13} />
          <span>
            Ya tienes este servidor guardado como «<strong>{exact.name || exact.host}</strong>».
          </span>
          <button type="button" className="ssha-linkbtn" onClick={() => onOpen(exact)}>
            Abrir «{exact.name || exact.host}»
          </button>
          {addTo && !addTo.serverIds.includes(exact.id) && (
            <button type="button" className="ssha-linkbtn" onClick={() => onAdd(exact, addTo.id)}>
              Añadirlo a «{addTo.name}»
            </button>
          )}
        </div>
      </div>
    );
  }
  if (sameHost.length === 0) return null;
  const names = sameHost.slice(0, 3).map((s) => `«${s.name || s.host}» (${serverAddress(s)})`);
  return (
    <div className="ssha-inline cd-match" role="status">
      <div className="ssha-inline-row">
        <Info size={13} />
        <span>
          Este host ya está guardado: {names.join(", ")}
          {sameHost.length > 3 ? ` y ${sameHost.length - 3} más` : ""}.
        </span>
      </div>
    </div>
  );
}

/** Resultado de «Probar conexión» dentro del formulario. */
function TestResult({
  testing,
  outcome,
  auth,
  onSaveAnyway,
}: {
  testing: "manual" | "save" | null;
  outcome: TestOutcome | null;
  auth: AuthMethod;
  onSaveAnyway: () => void;
}) {
  if (testing) {
    return (
      <div className="cd-test" role="status">
        <span className="spinner cd-btn-spinner" />
        <span>
          {testing === "save" ? "Probando la conexión antes de guardar…" : "Probando la conexión…"}{" "}
          <span className="faint">(máx. 10 s)</span>
        </span>
      </div>
    );
  }
  if (!outcome) return null;
  if (outcome.status === "canceled") {
    return (
      <div className="cd-test" role="status">
        <span className="faint">Prueba cancelada.</span>
      </div>
    );
  }
  if (outcome.status === "ok") {
    const partial = outcome.result.skipped !== null;
    return (
      <div className={`cd-test ${partial ? "cd-test-partial" : "cd-test-ok"}`} role="status">
        <CircleCheck size={15} />
        <span>{describeTestOk(outcome.result, auth)}</span>
      </div>
    );
  }
  return (
    <div className="cd-test cd-test-error" role="alert">
      <CircleX size={15} />
      <div className="cd-test-body">
        <span>{outcome.message}</span>
        <span className="cd-test-actions">
          <span className="faint">¿Está apagado ahora? Puedes guardarlo igualmente.</span>
          <button type="button" className="ssha-linkbtn" onClick={onSaveAnyway}>
            Guardar de todos modos
          </button>
        </span>
      </div>
    </div>
  );
}

// ───────── Alias de ~/.ssh/config ─────────

interface AliasState {
  /** Alias escrito a mano ("" = automático). */
  value: string;
  setValue: (v: string) => void;
  /** Distinto del guardado. */
  changed: boolean;
  info: SshAliasInfo | null;
  error: string | null;
}

/** Alias elegido a mano para el servidor y, con un pequeño retardo, si choca con un `Host` escrito a mano. */
function useSshAlias(id: string, name: string, host: string): AliasState {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [info, setInfo] = useState<SshAliasInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setSaved("");
      return;
    }
    let alive = true;
    sshAliases
      .list()
      .then((m) => {
        if (!alive) return;
        setSaved(m[id] ?? "");
        setValue((v) => v || (m[id] ?? ""));
      })
      .catch(() => alive && setSaved(""));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    const n = name.trim() || host.trim();
    if (!n && !value.trim()) {
      setInfo(null);
      setError(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      sshAliases
        .info(id, n, host.trim(), value.trim() || null)
        .then((i) => {
          if (!alive) return;
          setInfo(i);
          setError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setInfo(null);
          // Alias inválido: se muestra; otros fallos (p. ej. no se puede leer el archivo) no bloquean.
          setError(value.trim() ? errorMessage(e) : null);
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [id, name, host, value]);

  return { value, setValue, changed: saved !== null && value.trim() !== saved, info, error };
}

function AliasNote({ state }: { state: AliasState }) {
  const { info, error } = state;
  if (error) return <div className="cd-err">{error}</div>;
  if (!info) return null;
  if (info.matches.length === 0) {
    return (
      <div className="ssha-inline">
        Con «ssh <span className="mono">{info.alias}</span>» desde cualquier terminal (si exportas a {SSH_CONFIG_LABEL}).
      </div>
    );
  }
  return (
    <div className="ssha-inline warn" role="status" title={info.matches.map(describeMatch).join("\n")}>
      <div className="ssha-inline-row">
        <AlertTriangle size={13} />
        <span>
          «<span className="mono">{info.alias}</span>» ya aparece en tu {SSH_CONFIG_LABEL} escrito a mano.
        </span>
        {info.suggestion && (
          <button type="button" className="ssha-linkbtn" onClick={() => info.suggestion && state.setValue(info.suggestion)}>
            Usar «{info.suggestion}»
          </button>
        )}
      </div>
      <SshAliasMatches matches={info.matches} />
    </div>
  );
}
