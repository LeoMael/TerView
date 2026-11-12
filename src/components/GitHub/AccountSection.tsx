// Cuenta: conectar con un token personal (o con código si la versión lo trae), ver permisos y desconectar.
import { useEffect, useRef, useState } from "react";
import { Check, CircleHelp, KeyRound, LogOut, RefreshCw, X } from "lucide-react";
import { github, type GhDeviceCode } from "../../api/github";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { useGitHub } from "../../features/github/store";
import {
  CAPABILITIES,
  CLASSIC_SCOPES,
  CLASSIC_TOKEN_URL,
  FINE_GRAINED_TOKEN_URL,
  TOKENS_SETTINGS_URL,
  hasCapability,
  tokenKindLabel,
} from "../../features/github/tokens";
import { Card, ErrorBox, Link, SectionHead, openLink } from "./parts";

function ConnectForm() {
  const setAccount = useGitHub((s) => s.setAccount);
  const deviceFlow = useGitHub((s) => s.deviceFlow);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const acc = await github.connect(token);
      setToken("");
      setAccount(acc);
      toast.success("Cuenta de GitHub conectada", `@${acc.login}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Conectar con un token personal">
        <ol className="gh-steps">
          <li>
            Crea un token en GitHub. Lo más sencillo es un <b>token clásico</b> con los permisos ya marcados:{" "}
            <Link href={CLASSIC_TOKEN_URL}>crear token clásico</Link>
            <div className="gh-hint">
              Permisos: <span className="mono">{CLASSIC_SCOPES.join(", ")}</span>. Elige una caducidad (p. ej. 90 días).
            </div>
          </li>
          <li>
            O, si prefieres limitarlo a ciertos repos, un <b>token de grano fino</b>:{" "}
            <Link href={FINE_GRAINED_TOKEN_URL}>crear token de grano fino</Link>
            <div className="gh-hint">
              Repos: Contents (lectura), Administration (escritura, para llaves de despliegue), Actions (lectura y
              escritura). Cuenta: Git SSH keys y Gists (escritura).
            </div>
          </li>
          <li>Copia el token (solo se muestra una vez) y pégalo aquí:</li>
        </ol>
        <form
          className="gh-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim() && !busy) void connect();
          }}
        >
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ghp_… o github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Token de GitHub"
          />
          <button className="btn btn-primary" type="submit" disabled={!token.trim() || busy}>
            {busy ? <span className="spinner" /> : <KeyRound size={14} />} Conectar
          </button>
        </form>
        <ErrorBox error={error} />
        <p className="gh-hint">
          El token se guarda solo en el llavero del sistema (nunca en archivos) y puedes borrarlo con «Desconectar».
        </p>
      </Card>
      {deviceFlow && <DeviceFlow />}
    </>
  );
}

/** Inicio de sesión con código (solo si la versión trae client_id). */
function DeviceFlow() {
  const setAccount = useGitHub((s) => s.setAccount);
  const [code, setCode] = useState<GhDeviceCode | null>(null);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const start = async () => {
    setError(null);
    try {
      const c = await github.deviceStart();
      setCode(c);
      openLink(c.verificationUri);
      let interval = c.interval;
      const deadline = Date.now() + c.expiresIn * 1000;
      const tick = async () => {
        try {
          const r = await github.devicePoll(c.deviceCode);
          if (r.status === "done" && r.account) {
            setCode(null);
            setAccount(r.account);
            toast.success("Cuenta de GitHub conectada", `@${r.account.login}`);
            return;
          }
          if (r.status === "expired" || r.status === "denied" || Date.now() > deadline) {
            setCode(null);
            setError(new Error(r.status === "denied" ? "Se canceló la autorización" : "El código caducó"));
            return;
          }
          if (r.status === "slowDown") interval += 5;
          timer.current = window.setTimeout(tick, interval * 1000);
        } catch (e) {
          setCode(null);
          setError(e);
        }
      };
      timer.current = window.setTimeout(tick, interval * 1000);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Card title="O inicia sesión con un código">
      {code ? (
        <div className="gh-device">
          <span>Escribe este código en GitHub:</span>
          <span className="gh-device-code mono">{code.userCode}</span>
          <Link href={code.verificationUri}>{code.verificationUri}</Link>
          <span className="spinner" />
        </div>
      ) : (
        <button className="btn" onClick={() => void start()}>
          Iniciar sesión en GitHub
        </button>
      )}
      <ErrorBox error={error} />
    </Card>
  );
}

function AccountView() {
  const account = useGitHub((s) => s.account);
  const accountError = useGitHub((s) => s.accountError);
  const loading = useGitHub((s) => s.loadingAccount);
  const refresh = useGitHub((s) => s.refresh);
  const disconnect = useGitHub((s) => s.disconnect);
  const [replacing, setReplacing] = useState(false);

  const onDisconnect = async () => {
    const ok = await confirmDialog({
      title: "¿Desconectar GitHub?",
      message:
        "Se borrará el token del llavero de este equipo. Para revocarlo del todo, bórralo también en GitHub → Settings → Tokens.",
      confirmText: "Desconectar",
      danger: true,
    });
    if (!ok) return;
    try {
      await disconnect();
      toast.success("Cuenta de GitHub desconectada");
    } catch (e) {
      toast.error("No se pudo borrar el token del llavero", e);
    }
  };

  return (
    <>
      <SectionHead title="Cuenta">
        <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={13} /> Actualizar
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => void onDisconnect()}>
          <LogOut size={13} /> Desconectar
        </button>
      </SectionHead>
      {accountError && (
        <div className="gh-error">
          {accountError}{" "}
          <button className="btn btn-sm" onClick={() => setReplacing(true)}>
            Pegar otro token
          </button>
        </div>
      )}
      {loading && !account && <span className="spinner" />}
      {account && (
        <div className="gh-account">
          {account.avatarData ? (
            <img className="gh-avatar" src={account.avatarData} alt="" />
          ) : (
            <div className="gh-avatar gh-avatar-empty">{account.login.slice(0, 1).toUpperCase()}</div>
          )}
          <div className="gh-account-info">
            <div className="gh-account-name">{account.name ?? account.login}</div>
            <Link href={account.htmlUrl}>@{account.login}</Link>
            <div className="gh-hint">
              {account.publicRepos} repos públicos
              {account.privateRepos !== null && ` · ${account.privateRepos} privados`}
              {account.rateRemaining !== null &&
                ` · ${account.rateRemaining}/${account.rateLimit ?? "?"} peticiones restantes esta hora`}
            </div>
          </div>
        </div>
      )}
      {account && (
        <Card
          title={`Permisos · ${tokenKindLabel(account.tokenKind)}`}
          actions={<Link href={TOKENS_SETTINGS_URL}>Gestionar tokens</Link>}
        >
          {account.tokenExpires && <p className="gh-hint">Caduca: {account.tokenExpires}</p>}
          {account.scopes !== null && (
            <p className="gh-hint">
              Permisos del token: <span className="mono">{account.scopes.length ? account.scopes.join(", ") : "ninguno"}</span>
            </p>
          )}
          <ul className="gh-caps">
            {CAPABILITIES.map((c) => {
              const has = hasCapability(account, c);
              return (
                <li key={c.id}>
                  {has === true ? (
                    <Check size={14} className="gh-ok" aria-label="Disponible" />
                  ) : has === false ? (
                    <X size={14} className="gh-bad" aria-label="Falta permiso" />
                  ) : (
                    <CircleHelp size={14} className="gh-muted" aria-label="Desconocido" />
                  )}
                  <span>{c.label}</span>
                  <span className="gh-hint mono">{account.scopes === null ? c.fine : c.classic[0]}</span>
                </li>
              );
            })}
          </ul>
          {account.scopes === null && (
            <p className="gh-hint">
              GitHub no informa los permisos de los tokens de grano fino: si una función falla por permisos, edita el
              token en GitHub.
            </p>
          )}
        </Card>
      )}
      {replacing && <ConnectForm />}
    </>
  );
}

export function AccountSection() {
  const connected = useGitHub((s) => s.connected);
  if (connected === null) return <span className="spinner" />;
  if (!connected)
    return (
      <>
        <SectionHead title="Conectar tu cuenta de GitHub" />
        <ConnectForm />
      </>
    );
  return <AccountView />;
}

