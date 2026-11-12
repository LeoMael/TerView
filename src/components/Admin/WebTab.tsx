// Sub-pestaña «Sitios web»: sitios de nginx y Caddy (dominios, puertos, HTTPS, a qué sirve cada ruta),
// con comprobar configuración (solo lectura), recargar (como root, con confirmación) y abrir en el editor.
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode,
  FileText,
  Globe,
  KeyRound,
  Lock,
  LockOpen,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { errorMessage } from "../../api/core";
import {
  certStatus,
  checkScript,
  findListener,
  isLocalHost,
  readElevated,
  reloadSteps,
  uniqueListens,
  type ListenPort,
  type Plan,
  type ServerInfo,
  type Site,
  type SiteRoute,
} from "../../features/admin";
import { useProfiles } from "../../stores/profiles";
import { useAdmin } from "./context";
import { AdmModal } from "./AdmModal";
import { PlanModal } from "./PlanReview";

const SERVER_NAME: Record<ServerInfo["server"], string> = { nginx: "nginx", caddy: "Caddy" };

const SOURCE_TEXT: Record<ServerInfo["source"], string> = {
  dump: "configuración completa («nginx -T»)",
  files: "leída de los archivos de configuración",
  api: "configuración en marcha (API local de Caddy)",
  adapt: "Caddyfile convertido con «caddy adapt»",
};

const WRITE_NOTE = "Para guardar cambios necesitas permiso de escritura en el archivo (normalmente solo root).";

function statusTag(status: string | null) {
  if (status === null) return <span className="faint">sin servicio systemd</span>;
  if (status === "active") return <span className="adm-tag adm-tag-green">En marcha</span>;
  if (status === "failed") return <span className="adm-tag adm-tag-red">Con fallo</span>;
  if (status === "inactive") return <span className="adm-tag adm-tag-yellow">Parado</span>;
  return <span className="adm-tag adm-tag-yellow">{status}</span>;
}

/** ¿Tiene sentido buscar este destino entre los puertos del servidor? */
function localDest(host: string | null, ports: ListenPort[], serverHost: string | null): boolean {
  if (host === null) return true;
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return isLocalHost(h) || h === serverHost?.toLowerCase() || ports.some((p) => p.ip === h);
}

/** Indicador «alguien escucha en :3000» que lleva a Puertos. */
function ListenerBadge({ host, port }: { host: string | null; port: number | null }) {
  const { ports, goToPort, profileId } = useAdmin();
  const serverHost = useProfiles((s) => s.servers.find((x) => x.id === profileId)?.host ?? null);
  if (port === null) return null;
  const list = ports.data?.ports;
  if (!list) return ports.loading ? <span className="faint">comprobando…</span> : null;
  if (!localDest(host, list, serverHost))
    return (
      <span className="faint" title="El destino está en otro equipo">
        otro equipo
      </span>
    );
  const l = findListener(list, host ?? "127.0.0.1", port);
  const who = l ? (l.procs[0]?.name ?? l.container ?? l.unit?.replace(/\.service$/, "") ?? null) : null;
  return (
    <button
      className={`adm-listen ${l ? "ok" : "bad"}`}
      onClick={() => goToPort(port)}
      title={l ? `Ver el puerto ${port} en Puertos` : `Nadie escucha en el puerto ${port}: el sitio dará error. Ver en Puertos`}
    >
      {l ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {l ? `escuchando${who ? ` · ${who}` : ""}` : `nadie escucha en :${port}`}
    </button>
  );
}

function RouteTarget({ route }: { route: SiteRoute }) {
  const t = route.target;
  switch (t.kind) {
    case "proxy":
      return (
        <>
          <span className="adm-route-kind">proxy →</span>
          <span className="mono adm-ellipsis" title={t.url}>
            {t.socket ? `socket ${t.socket}` : t.url}
          </span>
          {!t.socket && <ListenerBadge host={t.host} port={t.port} />}
        </>
      );
    case "fastcgi":
      return (
        <>
          <span className="adm-route-kind">FastCGI →</span>
          <span className="mono adm-ellipsis" title={t.addr}>
            {t.addr}
          </span>
          {t.port !== null && <ListenerBadge host={t.host} port={t.port} />}
        </>
      );
    case "files":
      return (
        <>
          <span className="adm-route-kind">archivos en</span>
          <span className="mono adm-ellipsis" title={t.root}>
            {t.root}
          </span>
        </>
      );
    case "redirect":
      return (
        <>
          <span className="adm-route-kind">redirige{t.code ? ` (${t.code})` : ""} a</span>
          <span className="mono adm-ellipsis" title={t.to}>
            {t.to || "—"}
          </span>
        </>
      );
    default:
      return <span className="muted">{t.text}</span>;
  }
}

function SiteCard({ site }: { site: Site }) {
  const { openFile, goToPort } = useAdmin();
  const cs = certStatus(site.certExpires);
  const title = site.names[0] ?? (site.server === "caddy" ? "Cualquier dominio" : "Sitio por defecto");
  const where = site.file ? `${site.file}${site.line ? `:${site.line}` : ""}` : null;
  return (
    <article className="adm-site" aria-label={title}>
      <header className="adm-site-head">
        {site.https ? <Lock size={14} className="adm-ok" /> : <LockOpen size={14} className="faint" />}
        <span className="adm-site-name" title={site.names.join(" ")}>
          {title}
        </span>
        {site.isDefault && site.names.length > 0 && <span className="adm-tag adm-tag-accent">por defecto</span>}
        <span className={`adm-tag ${site.https ? "adm-tag-green" : "adm-tag-yellow"}`}>{site.https ? "HTTPS" : "HTTP"}</span>
      </header>
      {site.names.length > 1 && <div className="adm-site-alias mono">{site.names.slice(1).join(" · ")}</div>}

      <dl className="adm-site-info">
        <dt>Puertos</dt>
        <dd className="adm-site-ports">
          {uniqueListens(site.listens).map((l, i) => (
            <button
              key={i}
              className="adm-port-chip"
              onClick={() => l.port > 0 && goToPort(l.port)}
              disabled={l.port <= 0}
              title={l.port > 0 ? `Ver el puerto ${l.port} en Puertos` : undefined}
            >
              {l.host ? `${l.host}:` : ""}
              {l.port || "socket"}
              {l.https && " HTTPS"}
            </button>
          ))}
        </dd>
        {site.https && (
          <>
            <dt>Certificado</dt>
            <dd className="adm-cell-flex">
              {site.cert ? (
                <>
                  <span className="mono adm-ellipsis" title={site.cert}>
                    {site.cert}
                  </span>
                  {cs ? (
                    <span
                      className={`adm-tag ${cs.level === "ok" ? "adm-tag-green" : cs.level === "warn" ? "adm-tag-yellow" : "adm-tag-red"}`}
                    >
                      {cs.text}
                    </span>
                  ) : (
                    <span className="faint" title="Hace falta openssl en el servidor y permiso para leer el certificado">
                      caducidad desconocida
                    </span>
                  )}
                </>
              ) : site.server === "caddy" ? (
                <span className="muted">automático (lo gestiona Caddy)</span>
              ) : (
                <span className="faint">no indicado</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {site.routes.length > 0 ? (
        <ul className="adm-routes" aria-label="Rutas">
          {site.routes.map((r, i) => (
            <li key={i}>
              <span className="mono adm-route-path" title={r.path}>
                {r.path}
              </span>
              <RouteTarget route={r} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="faint adm-routes-none">Sin rutas reconocidas</div>
      )}

      {where && (
        <footer className="adm-site-foot">
          <FileText size={12} />
          <span className="mono adm-ellipsis" title={where}>
            {where}
          </span>
          <button
            className="btn btn-sm adm-row-btn"
            disabled={!openFile}
            onClick={() => site.file && openFile?.(site.file)}
            title={`${site.line ? `Abrir en el editor (el sitio empieza en la línea ${site.line}). ` : "Abrir en el editor. "}${WRITE_NOTE}`}
          >
            Abrir
          </button>
        </footer>
      )}
    </article>
  );
}

/** Resultado de «Comprobar configuración» (solo lectura). */
function CheckDialog({ info, onClose }: { info: ServerInfo; onClose: () => void }) {
  const { sessionId, elevation } = useAdmin();
  const [state, setState] = useState<{ busy: boolean; ok: boolean | null; text: string; elevated: boolean }>({
    busy: false,
    ok: null,
    text: "",
    elevated: false,
  });
  const script = checkScript(info);
  const run = useCallback(async () => {
    setState((s) => ({ ...s, busy: true }));
    try {
      // El código de salida del comando va en su propia sección (readElevated exige «@@end» al final).
      const r = await readElevated(sessionId, `${script}\nrc=$?\necho @@rc\necho $rc\necho @@end`, elevation, 40);
      const m = /\n?@@rc\n(\d+)\n@@end\s*$/.exec(r.result.stdout);
      const out = (m ? r.result.stdout.slice(0, m.index) : r.result.stdout).trim();
      setState({ busy: false, ok: m?.[1] === "0", text: out || "(sin salida)", elevated: r.elevated });
    } catch (e) {
      setState({ busy: false, ok: false, text: errorMessage(e), elevated: false });
    }
  }, [sessionId, script, elevation]);
  useEffect(() => {
    void run();
    // Solo al abrir; «Repetir» vuelve a lanzarlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <AdmModal title={`Comprobar configuración de ${SERVER_NAME[info.server]}`} onClose={onClose} width={620}>
      <div className="modal-body adm-review">
        <div className="adm-review-label">Solo comprueba, no cambia nada. Se ejecuta:</div>
        <pre className="adm-cmd">{script.split("\n").slice(1).join("\n")}</pre>
        {state.busy ? (
          <div className="adm-loading">
            <span className="spinner" /> Comprobando…
          </div>
        ) : state.ok === null ? null : (
          <>
            <div className={`adm-check-result ${state.ok ? "ok" : "bad"}`} role="status">
              {state.ok ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              {state.ok ? "La configuración es correcta" : "La configuración tiene errores o no se pudo comprobar"}
            </div>
            <pre className="adm-cmd adm-cmd-sm adm-check-out">{state.text}</pre>
            {!state.elevated && !state.ok && (
              <div className="adm-note adm-note-warn">
                Se comprobó sin root: suele fallar por permisos (archivo de PID, certificados o registros) aunque la configuración
                esté bien. Con sudo el resultado es fiable.
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={() => void run()} disabled={state.busy}>
          <RefreshCw size={13} /> Repetir
        </button>
        <button className="btn btn-primary" onClick={onClose} autoFocus>
          Cerrar
        </button>
      </div>
    </AdmModal>
  );
}

function ServerGroup({ info, onCheck, onReload }: { info: ServerInfo; onCheck: () => void; onReload: () => void }) {
  const { elevation, disabled, openFile, elev, askSudo, web } = useAdmin();
  const name = SERVER_NAME[info.server];
  // Como root «nginx -T» solo falla si la configuración no es válida (o falta algún archivo).
  const warning =
    info.server === "nginx" && info.source === "files" && web.elevated && info.sites.length > 0
      ? "«nginx -T» falló aunque se leyó como root: puede que la configuración tenga errores (usa «Comprobar configuración»). Se muestran los archivos tal cual."
      : info.warning;
  const reloadBlock = disabled ? "Sin conexión con el servidor" : !elevation ? "Necesitas root o sudo para recargar" : null;
  return (
    <section className="adm-web-group" aria-label={name}>
      <div className="adm-web-head">
        <Globe size={16} />
        <h3>{name}</h3>
        {statusTag(info.status)}
        <span className="muted adm-web-src">{SOURCE_TEXT[info.source]}</span>
        <span className="adm-spacer" />
        <button
          className="btn btn-sm"
          onClick={onCheck}
          disabled={disabled}
          title={`Comprueba la configuración sin aplicar nada (${info.server === "nginx" ? "nginx -t" : "caddy validate"})`}
        >
          <ShieldCheck size={13} /> Comprobar configuración
        </button>
        <button
          className="btn btn-sm"
          onClick={onReload}
          disabled={!!reloadBlock}
          title={reloadBlock ?? "Comprueba la configuración y, si es correcta, la aplica sin cortar las conexiones"}
        >
          <RotateCw size={13} /> Recargar
        </button>
        <button
          className="btn btn-sm"
          onClick={() => openFile?.(info.configPath)}
          disabled={!openFile}
          title={`Abrir ${info.configPath} en el editor. ${WRITE_NOTE}`}
        >
          <FileCode size={13} /> Abrir archivo principal
        </button>
      </div>
      <div className="adm-web-path faint mono" title="Archivo principal">
        {info.configPath}
      </div>
      {warning && (
        <div className="adm-note adm-note-warn adm-web-warn" role="status">
          <AlertTriangle size={13} />
          <span>
            {warning}
            {web.elevationError && ` (sudo: ${web.elevationError})`}
          </span>
          {!web.elevated && elev.canAskSudo && (
            <button className="btn btn-sm" onClick={askSudo}>
              <KeyRound size={13} /> Leer con sudo
            </button>
          )}
        </div>
      )}
      {info.sites.length === 0 ? (
        !warning && <div className="muted adm-web-none">No hay sitios configurados.</div>
      ) : (
        <div className="adm-sites">
          {info.sites.map((s) => (
            <SiteCard key={s.key} site={s} />
          ))}
        </div>
      )}
    </section>
  );
}

export function WebTab() {
  const { web, loadWeb, disabled, ports } = useAdmin();
  const [check, setCheck] = useState<ServerInfo | null>(null);
  const [reload, setReload] = useState<ServerInfo | null>(null);

  if (web.error && !web.data) {
    return (
      <div className="empty-state">
        <ShieldAlert size={22} />
        <div>No se pudo leer la configuración de los servidores web</div>
        <div className="faint adm-pre-wrap">{web.error}</div>
        <button className="btn btn-sm" onClick={loadWeb} disabled={disabled}>
          <RefreshCw size={13} /> Reintentar
        </button>
      </div>
    );
  }
  if (!web.data) {
    return (
      <div className="empty-state">
        <span className="spinner" />
        <div>Buscando nginx y Caddy…</div>
      </div>
    );
  }
  if (web.data.servers.length === 0) {
    return (
      <div className="empty-state">
        <Globe size={22} />
        <div>No se encontró nginx ni Caddy en este servidor</div>
        <div className="faint adm-pre-wrap">
          Se buscan los programas «nginx» y «caddy» (también en /usr/sbin y /usr/local/sbin). Si el servidor web está dentro de un
          contenedor, revísalo en la pestaña Contenedores. Apache y otros servidores aún no se muestran aquí.
        </div>
        <button className="btn btn-sm" onClick={loadWeb} disabled={disabled}>
          <RefreshCw size={13} /> Volver a buscar
        </button>
      </div>
    );
  }

  const plan: Plan | null = reload ? { action: `Recargar ${SERVER_NAME[reload.server]}`, steps: reloadSteps(reload) } : null;
  const total = web.data.servers.reduce((n, s) => n + s.sites.length, 0);

  return (
    <div className="adm-pane">
      <div className="adm-web-scroll">
        {web.data.servers.map((s) => (
          <ServerGroup key={s.server} info={s} onCheck={() => setCheck(s)} onReload={() => setReload(s)} />
        ))}
      </div>
      <div className="adm-statusbar">
        {total} {total === 1 ? "sitio" : "sitios"}
        <span className="faint">·</span>
        <span>{web.elevated ? "leídos como root" : "leídos sin privilegios"}</span>
        {ports.error && (
          <span className="adm-bad" title={ports.error}>
            · no se pudieron leer los puertos
          </span>
        )}
        {(web.loading || ports.loading) && <span className="spinner adm-spinner-btn" aria-label="Actualizando" />}
      </div>
      {check && <CheckDialog info={check} onClose={() => setCheck(null)} />}
      {plan && reload && (
        <PlanModal
          title={plan.action}
          plan={plan}
          runLabel="Recargar"
          onCancel={() => setReload(null)}
          onDone={() => {
            setReload(null);
            loadWeb();
          }}
        >
          <p className="dialog-message">
            Primero se comprueba la configuración; si tiene errores, no se aplica nada. Si es correcta,{" "}
            {SERVER_NAME[reload.server]} la vuelve a cargar sin cortar las conexiones abiertas.
          </p>
        </PlanModal>
      )}
    </div>
  );
}
