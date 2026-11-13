// «Nuevo usuario con clave»: usuario sin contraseña que solo entra con su llave SSH.
// Formulario → revisión del plan (comandos exactos) → resultado: prueba de conexión con esa llave y
// opción de guardar el servidor en TerView. No toca sshd_config salvo que se pida aparte (AllowUsers).
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, KeyRound, PlugZap, Save, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { errorMessage } from "../../api/core";
import { localkeys, type LocalPublicKey } from "../../api/localkeys";
import { ssh } from "../../api/ssh";
import type { ServerProfile } from "../../api/types";
import {
  accessAdvice,
  allowUsersPlan,
  checkPublicKey,
  createKeyUserPlan,
  parseSshdAccess,
  readElevated,
  splitSections,
  SSHD_ACCESS_SCRIPT,
  suggestKeyName,
  validateKeyName,
  validateName,
  type Plan,
  type SshdAccess,
} from "../../features/admin";
import { describeTestOk, testServerConnection } from "../../features/serverTest";
import { useProfiles } from "../../stores/profiles";
import { useUi } from "../../stores/ui";
import { useAdmin } from "./context";
import { AdmModal } from "./AdmModal";
import { PlanModal, PlanReview } from "./PlanReview";
import { Segmented } from "./Segmented";

type Source = "paste" | "local" | "generate";
type Step = "form" | "review" | "done";
type TestState = { status: "idle" | "running" } | { status: "ok" | "error"; message: string };

export function KeyUserWizard({ onClose, onCreated }: { onClose: () => void; onCreated?: (name: string) => void }) {
  const { env, read, users, sessionId, profileId, elevation, serverName } = useAdmin();
  const profile = useProfiles((s) => s.servers.find((x) => x.id === profileId) ?? null);
  const openServerEditor = useUi((s) => s.openServerEditor);

  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("paste");
  const [pasted, setPasted] = useState("");
  const [locals, setLocals] = useState<LocalPublicKey[] | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [genName, setGenName] = useState("");
  const [genPass, setGenPass] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [generated, setGenerated] = useState<{ line: string; privatePath: string; passphrase: string } | null>(null);
  const [access, setAccess] = useState<SshdAccess | null>(null);
  const [accessNote, setAccessNote] = useState<string | null>(null);
  const [addAllowGroup, setAddAllowGroup] = useState(true);
  const [extraGroups, setExtraGroups] = useState("");
  const [admin, setAdmin] = useState(false);
  const [linger, setLinger] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [allowUsersOpen, setAllowUsersOpen] = useState(false);
  const [allowUsersDone, setAllowUsersDone] = useState(false);
  const testId = useRef<string | null>(null);
  const closed = useRef(false);

  // Quién deja entrar sshd (AllowGroups/AllowUsers): mejor con sudo («sshd -T» lee las llaves del servidor).
  useEffect(() => {
    let alive = true;
    readElevated(sessionId, SSHD_ACCESS_SCRIPT, elevation, 20)
      .then((r) => {
        if (!alive) return;
        const a = parseSshdAccess(splitSections(r.result.stdout));
        setAccess(a);
        if (a.source === "archivos") setAccessNote("Leído de /etc/ssh/sshd_config (sin «sshd -T»): puede no incluir bloques Match.");
      })
      .catch((e) => alive && setAccessNote(`No se pudo leer la configuración de sshd: ${errorMessage(e)}`));
    return () => {
      alive = false;
    };
  }, [sessionId, elevation]);

  useEffect(() => {
    if (source !== "local" || locals) return;
    localkeys.listPublic().then(
      (l) => {
        setLocals(l);
        if (l[0]) setLocalPath(l[0].path);
      },
      (e) => setErrors((x) => ({ ...x, key: errorMessage(e) })),
    );
  }, [source, locals]);

  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (testId.current) void ssh.cancelTest(testId.current).catch(() => {});
    };
  }, []);

  const shell = useMemo(() => {
    const list = read?.shells ?? [];
    return list.find((s) => s.endsWith("/bash")) ?? list.find((s) => s.endsWith("/sh")) ?? "/bin/sh";
  }, [read]);

  const groupList = extraGroups
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  const advice = access ? accessAdvice(access, name || "-", [name, ...groupList, ...(admin && env ? [env.adminGroup] : [])]) : null;
  const allowGroup = access ? accessAdvice(access, name || "-", [name]).needGroup : null;

  const keyLine = (): { line: string; privatePath: string } | string => {
    if (source === "generate") return generated ? { line: generated.line, privatePath: generated.privatePath } : "Genera la llave primero";
    if (source === "local") {
      const k = locals?.find((l) => l.path === localPath);
      return k ? { line: k.line, privatePath: k.privatePath ?? "" } : "Elige una llave de ~/.ssh";
    }
    return { line: pasted, privatePath: "" };
  };

  const generate = async () => {
    const n = genName || suggestKeyName(name || "usuario", profile?.host ?? serverName);
    const ne = validateKeyName(n);
    if (ne) return setErrors((x) => ({ ...x, gen: ne }));
    setGenBusy(true);
    setErrors((x) => ({ ...x, gen: "", key: "" }));
    try {
      const k = await localkeys.generate(n, `${name || "usuario"}@${profile?.host ?? serverName}`, genPass);
      setGenerated({ line: k.publicLine, privatePath: k.privatePath, passphrase: genPass });
      setGenName(n);
    } catch (e) {
      setErrors((x) => ({ ...x, gen: errorMessage(e) }));
    } finally {
      setGenBusy(false);
    }
  };

  const review = () => {
    if (!env) return;
    const errs: Record<string, string> = {};
    const ne = validateName(name);
    if (ne) errs.name = ne;
    else if (users.some((u) => u.name === name)) errs.name = "Ya existe un usuario con ese nombre";
    else if (read?.groups.some((g) => g.name === name) && env.toolset === "shadow")
      errs.name = "Ya existe un grupo con ese nombre (useradd crea uno igual para el usuario)";
    const k = keyLine();
    let line = "";
    if (typeof k === "string") errs.key = k;
    else {
      const c = checkPublicKey(k.line);
      if (!c.ok) errs.key = c.error;
      else line = c.line;
    }
    const known = new Set((read?.groups ?? []).map((g) => g.name));
    for (const g of groupList) {
      const ge = validateName(g, "grupo");
      if (ge) errs.groups = `«${g}»: ${ge}`;
      else if (known.size && !known.has(g)) errs.groups = `El grupo «${g}» no existe en el servidor`;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const groups = [...groupList, ...(allowGroup && addAllowGroup ? [allowGroup] : [])];
    setPlan(createKeyUserPlan(env, { name, publicKey: line, shell, groups, admin, linger }));
    if (typeof k !== "string") setKeyPath(k.privatePath);
    setStep("review");
  };

  const runTest = async () => {
    if (!profile) return;
    setTest({ status: "running" });
    const draft: ServerProfile = { ...profile, id: "", username: name, auth: keyPath ? "key" : "agent", keyPath: keyPath || null };
    const passphrase = source === "generate" ? generated?.passphrase : undefined;
    const out = await testServerConnection(draft, { passphrase }, (id) => (testId.current = id), () => closed.current);
    testId.current = null;
    if (closed.current) return;
    if (out.status === "ok") setTest({ status: "ok", message: describeTestOk(out.result, draft.auth) });
    else if (out.status === "error") setTest({ status: "error", message: out.message });
    else setTest({ status: "idle" });
  };

  // Al terminar, se prueba sola la conexión con la llave (si se sabe dónde está la privada o hay agente).
  useEffect(() => {
    if (step === "done" && profile && test.status === "idle") void runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const saveServer = () => {
    if (!profile) return;
    openServerEditor({
      ...profile,
      id: "",
      name: `${profile.name} (${name})`,
      username: name,
      auth: keyPath ? "key" : "agent",
      keyPath: keyPath || null,
      sudoMode: "ask",
    });
    onClose();
  };

  const title = "Nuevo usuario con clave SSH";
  if (!env) return null;

  if (step === "review" && plan) {
    return (
      <AdmModal title={title} onClose={onClose} width={660}>
        <PlanReview
          plan={plan}
          onBack={() => setStep("form")}
          onCancel={onClose}
          onDone={() => {
            onCreated?.(name);
            setStep("done");
          }}
          runLabel="Crear usuario"
        >
          <p className="dialog-message">
            Se creará <strong>{name}</strong> sin contraseña: solo podrá entrar con su llave SSH. No se cambia
            PasswordAuthentication ni ninguna otra opción de sshd.
          </p>
        </PlanReview>
      </AdmModal>
    );
  }

  if (step === "done") {
    return (
      <AdmModal title={title} onClose={onClose} width={620}>
        <div className="modal-body">
          <p className="dialog-message">
            <CheckCircle2 size={14} className="adm-ok" /> Usuario <strong>{name}</strong> creado con su llave en
            ~/.ssh/authorized_keys.
          </p>
          {advice?.needAllowUsers && !allowUsersDone && (
            <div className="adm-note adm-note-warn">
              <ShieldAlert size={13} /> sshd solo deja entrar a los usuarios de <span className="mono">AllowUsers</span> (
              {access?.allowUsers.join(", ")}): <strong>{name}</strong> no podrá entrar hasta añadirlo.{" "}
              <button className="btn btn-sm" onClick={() => setAllowUsersOpen(true)}>
                Añadir a AllowUsers…
              </button>
            </div>
          )}
          {advice?.denied && <div className="adm-note adm-note-warn">{advice.denied}</div>}
          <label className="field">
            <span>Llave privada para probar (en este equipo; vacío = agente SSH)</span>
            <input
              className="input mono"
              value={keyPath}
              spellCheck={false}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
            />
          </label>
          {!profile && <div className="adm-note">No se encontró el servidor guardado de esta pestaña: no se puede probar.</div>}
          {test.status === "running" && (
            <div className="adm-loading">
              <span className="spinner" /> Probando {name}@{profile?.host}…
            </div>
          )}
          {(test.status === "ok" || test.status === "error") && (
            <div className={test.status === "ok" ? "adm-note" : "adm-error"} role="status">
              {test.status === "ok" ? <CheckCircle2 size={14} className="adm-ok" /> : <XCircle size={14} />}
              <span> {test.message}</span>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn adm-footer-left" onClick={runTest} disabled={!profile || test.status === "running"}>
            <PlugZap size={13} /> Probar conexión
          </button>
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn btn-primary" onClick={saveServer} disabled={!profile}>
            <Save size={13} /> Guardar servidor en TerView…
          </button>
        </div>
        {allowUsersOpen && (
          <PlanModal
            title={`Añadir ${name} a AllowUsers`}
            plan={allowUsersPlan(name)}
            onCancel={() => setAllowUsersOpen(false)}
            onDone={() => {
              setAllowUsersOpen(false);
              setAllowUsersDone(true);
              setTest({ status: "idle" });
            }}
            runLabel="Cambiar sshd"
          >
            <p className="dialog-message">
              Cambio global de sshd: se crea un archivo en /etc/ssh/sshd_config.d con «AllowUsers {name}», se comprueba
              con <span className="mono">sshd -t</span> (si falla se deshace) y se recarga sshd. Las sesiones abiertas no
              se cortan.
            </p>
          </PlanModal>
        )}
      </AdmModal>
    );
  }

  const err = (k: string) =>
    errors[k] ? (
      <div className="field-error" role="alert">
        {errors[k]}
      </div>
    ) : null;

  return (
    <AdmModal title={title} onClose={onClose} width={660}>
      <form
        className="adm-form"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
      >
        <div className="modal-body">
          <label className="field">
            <span>Nombre de usuario</span>
            <input
              className="input mono"
              value={name}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              maxLength={32}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="p. ej. deploy"
              aria-invalid={!!errors.name}
            />
            {err("name")}
          </label>

          <div className="field">
            <span className="adm-field-label">Llave pública</span>
            <Segmented
              label="Origen de la llave"
              value={source}
              onChange={setSource}
              options={[
                { value: "paste", label: "Pegar" },
                { value: "local", label: "De este equipo" },
                { value: "generate", label: "Generar nueva" },
              ]}
            />
          </div>
          {source === "paste" && (
            <textarea
              className="textarea mono adm-key-input"
              rows={3}
              value={pasted}
              spellCheck={false}
              placeholder="ssh-ed25519 AAAA… usuario@equipo"
              onChange={(e) => setPasted(e.target.value)}
              aria-label="Llave pública"
            />
          )}
          {source === "local" &&
            (locals === null ? (
              <div className="adm-loading">
                <span className="spinner" /> Leyendo ~/.ssh…
              </div>
            ) : locals.length === 0 ? (
              <div className="adm-note">No hay llaves públicas (*.pub) en ~/.ssh de este equipo.</div>
            ) : (
              <select className="select mono" value={localPath} onChange={(e) => setLocalPath(e.target.value)} aria-label="Llave de este equipo">
                {locals.map((l) => (
                  <option key={l.path} value={l.path}>
                    {l.path.split(/[\\/]/).pop()} · {l.line.split(/\s+/)[0]} {l.line.split(/\s+/).slice(2).join(" ")}
                  </option>
                ))}
              </select>
            ))}
          {source === "generate" &&
            (generated ? (
              <div className="adm-note">
                <KeyRound size={13} /> Llave ed25519 guardada en <span className="mono">{generated.privatePath}</span> (permisos
                600{generated.passphrase ? ", con frase" : ""}). La privada no sale de este equipo; al servidor solo va:
                <pre className="adm-cmd adm-cmd-sm">{generated.line}</pre>
              </div>
            ) : (
              <div className="field-row">
                <label className="field">
                  <span>Archivo en ~/.ssh</span>
                  <input
                    className="input mono"
                    value={genName}
                    spellCheck={false}
                    placeholder={suggestKeyName(name || "usuario", profile?.host ?? serverName)}
                    onChange={(e) => setGenName(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Frase (opcional)</span>
                  <input
                    className="input"
                    type="password"
                    value={genPass}
                    autoComplete="new-password"
                    onChange={(e) => setGenPass(e.target.value)}
                  />
                </label>
                <div className="field adm-field-check">
                  <button type="button" className="btn btn-sm" onClick={generate} disabled={genBusy}>
                    {genBusy ? <span className="spinner adm-spinner-btn" /> : <Sparkles size={13} />} Generar
                  </button>
                </div>
              </div>
            ))}
          {err("gen")}
          {err("key")}

          {access && (access.allowGroups.length > 0 || access.allowUsers.length > 0) && (
            <div className="adm-note">
              sshd ({access.source}) solo deja entrar a
              {access.allowGroups.length > 0 && (
                <>
                  {" "}
                  los grupos <span className="mono">{access.allowGroups.join(", ")}</span>
                </>
              )}
              {access.allowGroups.length > 0 && access.allowUsers.length > 0 && " y"}
              {access.allowUsers.length > 0 && (
                <>
                  {" "}
                  los usuarios <span className="mono">{access.allowUsers.join(", ")}</span>
                </>
              )}
              .
            </div>
          )}
          {accessNote && <div className="faint">{accessNote}</div>}
          {allowGroup && (
            <label className="checkbox adm-check adm-mb">
              <input type="checkbox" checked={addAllowGroup} onChange={(e) => setAddAllowGroup(e.target.checked)} />
              Añadir al grupo <span className="mono">{allowGroup}</span> (AllowGroups de sshd)
            </label>
          )}
          {advice?.needAllowUsers && (
            <div className="adm-note adm-note-warn">
              AllowUsers no incluye a {name || "este usuario"}: al terminar podrás añadirlo (cambio aparte, con confirmación). Línea:{" "}
              <span className="mono">AllowUsers {name || "usuario"}</span>
            </div>
          )}
          <label className="field">
            <span>Otros grupos (opcional, separados por comas)</span>
            <input
              className="input mono"
              value={extraGroups}
              spellCheck={false}
              onChange={(e) => setExtraGroups(e.target.value)}
              placeholder="p. ej. docker"
            />
            {err("groups")}
          </label>
          <label className="checkbox adm-check adm-mb">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            Dar sudo (grupo <span className="mono">{env.adminGroup}</span>). Sin contraseña, sudo solo funcionará si se
            configura NOPASSWD.
          </label>
          <label className="checkbox adm-check">
            <input type="checkbox" checked={linger} onChange={(e) => setLinger(e.target.checked)} />
            Activar linger (sus servicios de usuario y contenedores siguen activos sin sesión abierta)
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary">
            Revisar comandos…
          </button>
        </div>
      </form>
    </AdmModal>
  );
}
