// Llaves SSH: de GitHub → authorized_keys de un servidor conectado, y de tu PC → GitHub.
import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { FolderOpen, Search, Server, Upload } from "lucide-react";
import { github, type GhSshKey, type LocalPubKey } from "../../api/github";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { useGitHub } from "../../features/github/store";
import { addAuthorizedKeysScript, parseAddResult, shortKey } from "../../features/github/shell";
import { execOk } from "../../features/github/session";
import { Card, ErrorBox, SectionHead, SessionPicker, formatDate } from "./parts";

function KeysToServer() {
  const connected = useGitHub((s) => s.connected);
  const account = useGitHub((s) => s.account);
  const [login, setLogin] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [keys, setKeys] = useState<GhSshKey[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (who: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const list = who ? await github.userKeys(who) : await github.myKeys();
      setKeys(list);
      setOwner(who);
      setPicked(new Set(list.map((k) => k.id)));
    } catch (e) {
      setError(e);
      setKeys(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) void load(null);
  }, [connected, load]);

  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const addToServer = async () => {
    if (!sessionId || !keys) return;
    const chosen = keys.filter((k) => picked.has(k.id));
    if (chosen.length === 0) return;
    let script: string;
    try {
      script = addAuthorizedKeysScript(chosen.map((k) => k.key));
    } catch (e) {
      toast.error("No se pueden añadir", e);
      return;
    }
    const ok = await confirmDialog({
      title: `¿Añadir ${chosen.length === 1 ? "1 llave" : `${chosen.length} llaves`} al servidor?`,
      message: (
        <>
          Se añadirán a <span className="mono">~/.ssh/authorized_keys</span> del usuario conectado (sin duplicar; carpeta
          700 y archivo 600). Quien tenga la llave privada podrá entrar con ese usuario.
          <ul className="gh-keylist">
            {chosen.map((k) => (
              <li key={k.id} className="mono">
                {shortKey(k.key)}
              </li>
            ))}
          </ul>
        </>
      ),
      confirmText: "Añadir",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await execOk(sessionId, script, 30);
      const { added, skipped } = parseAddResult(r.stdout);
      toast.success(
        added ? `Añadidas ${added} llaves` : "No se añadió nada",
        skipped ? `${skipped} ya estaban en authorized_keys` : undefined,
      );
    } catch (e) {
      toast.error("No se pudieron añadir las llaves", e);
    } finally {
      setBusy(false);
    }
  };

  const whose = owner ? `@${owner}` : account ? `@${account.login}` : "";

  return (
    <Card title="Llaves de GitHub → servidor">
      <form
        className="gh-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const v = login.trim().replace(/^@/, "");
          if (v) void load(v);
        }}
      >
        <input
          className="input"
          placeholder="Usuario de GitHub (vacío = tu cuenta)"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          aria-label="Usuario de GitHub"
        />
        <button className="btn btn-sm" type="submit" disabled={!login.trim() || loading}>
          <Search size={13} /> Ver sus llaves
        </button>
        {connected && owner && (
          <button className="btn btn-sm" type="button" onClick={() => void load(null)}>
            Mis llaves
          </button>
        )}
      </form>
      <ErrorBox error={error} />
      {loading && <span className="spinner" />}
      {!connected && !keys && !loading && (
        <p className="gh-hint">Escribe un usuario para ver sus llaves públicas, o conecta tu cuenta para ver las tuyas.</p>
      )}
      {keys && (
        <>
          <div className="gh-hint">
            {keys.length === 0 ? `${whose} no tiene llaves públicas en GitHub.` : `Llaves públicas de ${whose}:`}
          </div>
          <div className="gh-list gh-list-short">
            {keys.map((k) => (
              <label key={k.id} className="gh-row gh-row-check">
                <input type="checkbox" checked={picked.has(k.id)} onChange={() => toggle(k.id)} />
                <span className="gh-row-main">
                  <span className="gh-row-title">{k.title ?? "(sin título)"}</span>
                  <span className="mono gh-row-sub">{shortKey(k.key)}</span>
                </span>
                <span className="gh-hint">{formatDate(k.createdAt)}</span>
              </label>
            ))}
          </div>
          {keys.length > 0 && (
            <div className="gh-inline">
              <SessionPicker value={sessionId} onChange={setSessionId} />
              <button
                className="btn btn-primary btn-sm"
                disabled={!sessionId || picked.size === 0 || busy}
                onClick={() => void addToServer()}
              >
                {busy ? <span className="spinner" /> : <Server size={13} />} Añadir a authorized_keys
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function PcToGitHub() {
  const connected = useGitHub((s) => s.connected);
  const [local, setLocal] = useState<LocalPubKey[] | null>(null);
  const [chosen, setChosen] = useState<LocalPubKey | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    github
      .localPubkeys()
      .then(setLocal)
      .catch((e) => {
        setLocal([]);
        setError(e);
      });
  }, []);

  const pick = (k: LocalPubKey) => {
    setChosen(k);
    setTitle((t) => t || k.comment || "SSHorus");
  };

  const browse = async () => {
    setError(null);
    try {
      let defaultPath: string | undefined;
      try {
        defaultPath = await join(await homeDir(), ".ssh");
      } catch {
        defaultPath = undefined;
      }
      const path = await openFileDialog({
        title: "Elegir llave pública (.pub)",
        multiple: false,
        directory: false,
        defaultPath,
        filters: [{ name: "Llave pública", extensions: ["pub"] }],
      });
      if (typeof path !== "string") return;
      pick(await github.readPubkey(path));
    } catch (e) {
      setError(e);
    }
  };

  const upload = async () => {
    if (!chosen) return;
    const ok = await confirmDialog({
      title: "¿Subir la llave a GitHub?",
      message: (
        <>
          Se añadirá a tu cuenta como «{title.trim() || "SSHorus"}». Con ella podrás usar git por SSH con GitHub.
          <div className="mono gh-keylist">{shortKey(chosen.line)}</div>
        </>
      ),
      confirmText: "Subir",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await github.addKey(title, chosen.line);
      toast.success("Llave subida a GitHub");
      setChosen(null);
      setTitle("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Llave de tu PC → GitHub">
      {!connected && <p className="gh-hint">Conecta tu cuenta para subir llaves.</p>}
      <div className="gh-list gh-list-short">
        {local?.length === 0 && <div className="gh-hint">No hay llaves .pub en ~/.ssh.</div>}
        {local?.map((k) => (
          <button
            key={k.path}
            className={`gh-row ${chosen?.path === k.path ? "gh-row-active" : ""}`}
            onClick={() => pick(k)}
          >
            <span className="gh-row-main">
              <span className="gh-row-title mono">{k.path.split(/[\\/]/).pop()}</span>
              <span className="gh-row-sub mono">{shortKey(k.line)}</span>
            </span>
            <span className="gh-hint">{k.comment}</span>
          </button>
        ))}
      </div>
      <div className="gh-inline">
        <button className="btn btn-sm" onClick={() => void browse()}>
          <FolderOpen size={13} /> Elegir otro archivo .pub…
        </button>
      </div>
      {chosen && (
        <div className="gh-inline">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título en GitHub"
            aria-label="Título de la llave en GitHub"
          />
          <button className="btn btn-primary btn-sm" disabled={!connected || busy} onClick={() => void upload()}>
            {busy ? <span className="spinner" /> : <Upload size={13} />} Subir a GitHub
          </button>
        </div>
      )}
      <ErrorBox error={error} />
      <p className="gh-hint">Solo se leen archivos .pub (llaves públicas). La llave privada nunca sale de tu PC.</p>
    </Card>
  );
}

export function KeysSection() {
  return (
    <>
      <SectionHead title="Llaves SSH" />
      <KeysToServer />
      <PcToGitHub />
    </>
  );
}
