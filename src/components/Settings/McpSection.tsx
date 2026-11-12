// Ajustes → Asistentes de IA (MCP): encender el servidor, puerto, token, permisos por servidor,
// reglas «Permitir siempre» y la configuración lista para copiar en Claude Code o Claude Desktop.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, Copy, Eye, EyeOff, RefreshCw, Trash2, X } from "lucide-react";
import { mcp, type McpAccess, type McpClientConfig, type McpConfig } from "../../api/mcp";
import { clipboard } from "../../lib/clipboard";
import { useProfiles } from "../../stores/profiles";
import { toast } from "../../stores/toasts";
import { confirmDialog } from "../ui/dialogs";
import { openActivity, refreshStatus, useMcp } from "../../features/mcp/store";
import "../../features/mcp/Mcp.css";

const ACCESS: { v: McpAccess; label: string }[] = [
  { v: "none", label: "Sin acceso" },
  { v: "read", label: "Solo lectura" },
  { v: "full", label: "Completo" },
];

const TIMEOUTS = [30, 60, 120, 300];

const DESKTOP_CONFIG_PATH: Record<string, string> = {
  mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
  win: "%APPDATA%\\Claude\\claude_desktop_config.json",
  linux: "~/.config/Claude/claude_desktop_config.json",
};

function desktopConfigPath(): string {
  const p = navigator.userAgent.toLowerCase();
  if (p.includes("mac")) return DESKTOP_CONFIG_PATH.mac;
  if (p.includes("win")) return DESKTOP_CONFIG_PATH.win;
  return DESKTOP_CONFIG_PATH.linux;
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

async function copy(text: string, what: string) {
  try {
    await clipboard.write(text);
    toast.success(`${what} copiado`);
  } catch (e) {
    toast.error("No se pudo copiar", e);
  }
}

function CopyBlock({ title, hint, text }: { title: string; hint?: ReactNode; text: string }) {
  return (
    <div className="mcp-copy">
      <div className="mcp-copy-head">
        <span>{title}</span>
        <button className="btn btn-sm" onClick={() => void copy(text, title)}>
          <Copy size={12} /> Copiar
        </button>
      </div>
      {hint && <small className="muted">{hint}</small>}
      <pre className="mcp-copy-text">{text}</pre>
    </div>
  );
}

/** «run_command\nuptime» → «run_command: uptime». */
function ruleLabel(key: string): string {
  const [tool, ...rest] = key.split("\n");
  return rest.length ? `${tool}: ${rest.join(" · ")}` : tool;
}

export function McpSection() {
  const status = useMcp((s) => s.status);
  const servers = useProfiles((s) => s.servers);
  const [cfg, setCfg] = useState<McpConfig | null>(null);
  const [client, setClient] = useState<McpClientConfig | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [openRules, setOpenRules] = useState<string | null>(null);
  const enabled = !!status?.enabled;

  const loadClient = useCallback(async () => {
    try {
      setClient(await mcp.clientConfig());
    } catch (e) {
      setClient(null);
      toast.error("No se pudo leer el token", e);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void mcp.config().then(setCfg).catch(() => {});
  }, []);
  useEffect(() => {
    if (status) setPort(String(status.port));
  }, [status]);
  useEffect(() => {
    if (enabled) void loadClient();
    else setClient(null);
  }, [enabled, loadClient, status?.port]);

  const toggle = async () => {
    setBusy(true);
    try {
      const st = await mcp.setEnabled(!enabled);
      useMcp.setState({ status: st });
      setCfg(await mcp.config());
      if (st.enabled && st.error) toast.error("El servidor MCP no pudo arrancar", st.error);
    } catch (e) {
      toast.error("No se pudo cambiar el servidor MCP", e);
    } finally {
      setBusy(false);
    }
  };

  const applyPort = async () => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      toast.error("Puerto no válido", "Usa un número entre 1024 y 65535");
      return;
    }
    try {
      const st = await mcp.setPort(n);
      useMcp.setState({ status: st });
      if (st.error) toast.error("No se pudo usar ese puerto", st.error);
      else toast.success(`Escuchando en el puerto ${n}`, "Actualiza la configuración en tu asistente.");
    } catch (e) {
      toast.error("No se pudo cambiar el puerto", e);
    }
  };

  const regenerate = async () => {
    const ok = await confirmDialog({
      title: "Regenerar token",
      message: "Los asistentes configurados con el token actual dejarán de funcionar hasta que copies la configuración nueva.",
      confirmText: "Regenerar",
    });
    if (!ok) return;
    try {
      await mcp.regenerateToken();
      await loadClient();
      toast.success("Token nuevo creado", "Copia otra vez la configuración en tu asistente.");
    } catch (e) {
      toast.error("No se pudo regenerar el token", e);
    }
  };

  const setAccess = async (serverId: string, access: McpAccess) => {
    try {
      setCfg(await mcp.setAccess(serverId, access));
    } catch (e) {
      toast.error("No se pudo guardar el permiso", e);
    }
  };

  const forget = async (serverId: string, key: string | null) => {
    try {
      setCfg(await mcp.forgetRule(serverId, key));
    } catch (e) {
      toast.error("No se pudo quitar la regla", e);
    }
  };

  const setTimeoutSecs = async (secs: number) => {
    try {
      setCfg(await mcp.setApprovalTimeout(secs));
      void refreshStatus();
    } catch (e) {
      toast.error("No se pudo guardar", e);
    }
  };

  const stateText = !status
    ? "…"
    : !enabled
      ? "Apagado. Ningún asistente puede usar TerView."
      : status.running
        ? `Encendido en ${status.url} (solo en este equipo).`
        : status.error ?? "Encendido, pero el servidor no está en marcha.";

  return (
    <>
      <h3 className="st-title">Asistentes de IA (MCP)</h3>
      <p className="mcp-intro">
        Un asistente como Claude Code o Claude Desktop puede trabajar con tus servidores a través de TerView. Usa las
        conexiones guardadas y <strong>nunca ve contraseñas ni llaves</strong>. Todo lo que cambie algo te lo pregunta
        aquí, y cada acción queda registrada.
      </p>

      <Row label="Activar el servidor MCP" hint={stateText}>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Activar el servidor MCP"
          className={enabled ? "st-switch on" : "st-switch"}
          onClick={() => void toggle()}
          disabled={busy || !status}
        >
          <span />
        </button>
      </Row>

      {enabled && (
        <>
          <Row label="Puerto" hint="Solo escucha en 127.0.0.1 (este equipo).">
            <input
              className="input st-num mcp-port"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && void applyPort()}
              aria-label="Puerto"
            />
            <button className="btn" onClick={() => void applyPort()} disabled={port === String(status?.port)}>
              Aplicar
            </button>
          </Row>

          <Row label="Tiempo para responder" hint="Si no respondes a un permiso en este tiempo, se deniega.">
            <div className="st-segmented" role="radiogroup" aria-label="Tiempo para responder">
              {TIMEOUTS.map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={cfg?.approvalTimeoutSecs === s}
                  className={cfg?.approvalTimeoutSecs === s ? "active" : ""}
                  onClick={() => void setTimeoutSecs(s)}
                >
                  {s < 60 ? `${s} s` : `${s / 60} min`}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Token"
            hint="Lo usa el asistente para hablar con TerView. Se guarda como tus contraseñas (en la bóveda si tienes PIN)."
          >
            <code className="mcp-token">{client ? (showToken ? client.token : "tv_" + "•".repeat(16)) : "…"}</code>
            <button className="icon-btn" onClick={() => setShowToken((v) => !v)} title={showToken ? "Ocultar" : "Ver"} aria-label={showToken ? "Ocultar token" : "Ver token"}>
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button className="icon-btn" onClick={() => client && void copy(client.token, "Token")} title="Copiar" aria-label="Copiar token">
              <Copy size={14} />
            </button>
            <button className="btn btn-sm" onClick={() => void regenerate()}>
              <RefreshCw size={12} /> Regenerar
            </button>
          </Row>
        </>
      )}

      <h4 className="st-subtitle">Permisos por servidor</h4>
      <p className="mcp-note">
        <strong>Sin acceso</strong>: el asistente ni lo ve. <strong>Solo lectura</strong>: listar, leer archivos y comandos
        📊 de la Biblioteca. <strong>Completo</strong>: también cambios, siempre con tu permiso. Lo peligroso (rm -rf, prune,
        sudo, reboot…) se pregunta siempre.
      </p>
      {servers.length === 0 ? (
        <div className="empty-state">Aún no tienes servidores guardados.</div>
      ) : (
        <div className="mcp-servers">
          {servers.map((s) => {
            const access = cfg?.access[s.id] ?? "none";
            const rules = cfg?.remembered[s.id] ?? [];
            return (
              <div key={s.id} className="mcp-server">
                <div className="mcp-server-row">
                  <div className="mcp-server-name">
                    <span>{s.name}</span>
                    <small className="faint">
                      {s.username}@{s.host}
                    </small>
                  </div>
                  {rules.length > 0 && (
                    <button className="btn btn-sm" onClick={() => setOpenRules(openRules === s.id ? null : s.id)}>
                      {rules.length === 1 ? "1 regla «siempre»" : `${rules.length} reglas «siempre»`}
                    </button>
                  )}
                  <div className="st-segmented" role="radiogroup" aria-label={`Acceso a ${s.name}`}>
                    {ACCESS.map((o) => (
                      <button
                        key={o.v}
                        role="radio"
                        aria-checked={access === o.v}
                        className={access === o.v ? `active mcp-acc-${o.v}` : ""}
                        onClick={() => void setAccess(s.id, o.v)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                {openRules === s.id && rules.length > 0 && (
                  <div className="mcp-rules">
                    {rules.map((k) => (
                      <div key={k} className="mcp-rule">
                        <code title={k}>{ruleLabel(k)}</code>
                        <button className="icon-btn" onClick={() => void forget(s.id, k)} title="Quitar regla" aria-label="Quitar regla">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button className="btn btn-sm" onClick={() => void forget(s.id, null)}>
                      <Trash2 size={12} /> Quitar todas
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {enabled && client && status && (
        <>
          <h4 className="st-subtitle">Conectar tu asistente</h4>
          <p className="mcp-note">
            TerView tiene que estar abierto mientras el asistente trabaja. La configuración lleva el token: no la compartas.
          </p>
          {!status.bridgeFound && (
            <p className="mcp-warn">
              No se encontró el programa puente en {status.bridgePath}. Usa la opción por HTTP o instala TerView con su
              instalador.
            </p>
          )}
          {status.appImage && (
            <p className="mcp-warn">
              Con la AppImage la ruta del puente cambia en cada arranque: usa la opción por HTTP.
            </p>
          )}
          <CopyBlock
            title="Claude Code (puente stdio)"
            hint="Pégalo en una terminal. Añade «--scope user» para usarlo en todos tus proyectos."
            text={client.claudeCodeStdio}
          />
          <CopyBlock title="Claude Code (HTTP directo)" hint="Alternativa sin puente." text={client.claudeCodeHttp} />
          <CopyBlock
            title="Claude Desktop"
            hint={
              <>
                Añádelo a <span className="mono">{desktopConfigPath()}</span> y reinicia Claude Desktop.
              </>
            }
            text={client.claudeDesktopJson}
          />
        </>
      )}

      <Row label="Actividad del asistente" hint="Cada acción, en qué servidor, el resultado y quién la aprobó.">
        <button className="btn" onClick={openActivity}>
          <Activity size={14} /> Ver actividad
        </button>
      </Row>
    </>
  );
}
