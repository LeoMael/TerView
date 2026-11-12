// Diálogo «Nuevo servidor / Editar servidor», ligado a useUi().serverEditor.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { AlertTriangle, FolderOpen } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import { profiles as profilesApi, sshAliases, type SshAliasInfo } from "../api/profiles";
import { errorMessage } from "../api/core";
import type { AuthMethod, ServerProfile } from "../api/types";
import { useProfiles } from "../stores/profiles";
import { useUi } from "../stores/ui";
import { toast } from "../stores/toasts";
import { ColorPicker } from "./ColorPicker";
import { SSH_CONFIG_LABEL, SSH_KEY_EXAMPLE } from "../lib/platform";
import { SshAliasMatches, describeMatch } from "./sshAliases";

export function ServerEditorHost() {
  const editor = useUi((s) => s.serverEditor);
  const close = useUi((s) => s.closeServerEditor);
  if (!editor) return null;
  return <ServerEditor key={editor.server?.id || "new"} initial={editor.server} onClose={close} />;
}

type Errors = Partial<Record<"name" | "host" | "port" | "username" | "keyPath" | "alias", string>>;

const AUTH_OPTIONS: { value: AuthMethod; label: string }[] = [
  { value: "password", label: "Contraseña" },
  { value: "key", label: "Llave SSH" },
  { value: "agent", label: "Agente SSH" },
];

function ServerEditor({ initial, onClose }: { initial: ServerProfile | null; onClose: () => void }) {
  const isNew = !initial || initial.id === "";
  const projects = useProfiles((s) => s.projects);
  const saveServer = useProfiles((s) => s.saveServer);
  const saveProject = useProfiles((s) => s.saveProject);

  const initialProjectId = initial?.id ? (projects.find((p) => p.serverIds.includes(initial.id))?.id ?? "") : "";

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
  const [projectId, setProjectId] = useState(initialProjectId);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  /** null = desconocido (nuevo o llavero no disponible). */
  const [hasSecret, setHasSecret] = useState<boolean | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const alias = useSshAlias(initial?.id ?? "", name, host);

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

  const save = async () => {
    const e = validate();
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;

    const server: ServerProfile = {
      id: initial?.id ?? "",
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      auth,
      keyPath: auth === "key" ? keyPath.trim() : null,
      defaultPath: defaultPath.trim() || null,
      color,
    };

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

    setSaving(true);
    const saved = await saveServer(server, newSecret);
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
    if (projectId !== initialProjectId) {
      const st = useProfiles.getState();
      const oldP = st.projects.find((p) => p.id === initialProjectId);
      if (oldP) {
        await saveProject({
          ...oldP,
          serverIds: oldP.serverIds.filter((x) => x !== saved.id),
          bookmarks: oldP.bookmarks.filter((b) => b.serverId !== saved.id),
        });
      }
      const newP = useProfiles.getState().projects.find((p) => p.id === projectId);
      if (newP && !newP.serverIds.includes(saved.id)) {
        await saveProject({ ...newP, serverIds: [...newP.serverIds, saved.id] });
      }
    }
    setSaving(false);
    onClose();
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      void save();
    }
  };

  const secretPlaceholder = hasSecret ? "•••••• (guardada; escribe para cambiarla)" : "";

  return (
    <Modal
      open
      title={isNew ? "Nuevo servidor" : "Editar servidor"}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? <span className="spinner cd-btn-spinner" /> : null}
            Guardar
          </button>
        </>
      }
    >
      <div className="cd-form" onKeyDown={onEnter}>
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
          <label className="field cd-grow">
            <span>Host</span>
            <input
              className="input mono"
              value={host}
              spellCheck={false}
              autoCapitalize="off"
              placeholder="servidor.com o 192.168.1.10"
              onChange={(e) => {
                setHost(e.target.value);
                clearErr("host");
              }}
            />
            {errors.host && <div className="cd-err">{errors.host}</div>}
          </label>
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
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {auth === "password" && (
          <>
            <label className="field">
              <span>Contraseña</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={secret}
                placeholder={secretPlaceholder || "Opcional: se pedirá al conectar"}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <label className="checkbox cd-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Guardar en el llavero del sistema
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
            <label className="field">
              <span>Frase de la llave (opcional)</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={secret}
                placeholder={secretPlaceholder || "Si la llave está protegida"}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <label className="checkbox cd-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Guardar la frase en el llavero del sistema
            </label>
          </>
        )}

        {auth === "agent" && (
          <div className="cd-hint">Se usarán las llaves cargadas en tu agente SSH (ssh-agent).</div>
        )}

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

        <div className="field-row">
          <div className="field">
            <span>Color</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <label className="field">
            <span>Proyecto</span>
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Ninguno</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </Modal>
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
