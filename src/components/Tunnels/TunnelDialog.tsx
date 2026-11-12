// Crear / editar un túnel, con plantillas rápidas y explicación de cada tipo.
import { useState, type FormEvent } from "react";
import { Laptop, Server, TriangleAlert } from "lucide-react";
import type { TunnelDef, TunnelKind } from "../../api/tunnels";
import { Modal } from "../ui/Modal";
import { isOpenBind, KIND_INFO, TUNNEL_TEMPLATES, type TunnelTemplate } from "../../features/tunnels/useTunnels";

export interface TunnelDialogProps {
  /** Definición a editar (id "" = nueva). */
  initial: TunnelDef;
  /** Se puede ofrecer "Guardar y activar" (hay conexión y el túnel no está activo). */
  canActivate: boolean;
  onClose: () => void;
  /** Debe lanzar si falla (el diálogo muestra el error). */
  onSave: (def: TunnelDef, activate: boolean) => Promise<void>;
}

const KINDS: TunnelKind[] = ["local", "remote", "socks"];

function defaultBind(kind: TunnelKind): string {
  return kind === "remote" ? "localhost" : "127.0.0.1";
}

function parsePort(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

export function TunnelDialog({ initial, canActivate, onClose, onSave }: TunnelDialogProps) {
  const isNew = initial.id === "";
  const [kind, setKind] = useState<TunnelKind>(initial.kind);
  const [name, setName] = useState(initial.name);
  const [bindHost, setBindHost] = useState(initial.bindHost || defaultBind(initial.kind));
  const [bindPort, setBindPort] = useState(initial.bindPort ? String(initial.bindPort) : "");
  const [destHost, setDestHost] = useState(initial.destHost || "127.0.0.1");
  const [destPort, setDestPort] = useState(initial.destPort ? String(initial.destPort) : "");
  const [autoStart, setAutoStart] = useState(initial.autoStart);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const changeKind = (k: TunnelKind) => {
    if (k === kind) return;
    // Mantener la intención "solo este equipo" al cambiar de lado.
    if (bindHost === defaultBind(kind)) setBindHost(defaultBind(k));
    setKind(k);
    setError(null);
  };

  const applyTemplate = (t: TunnelTemplate) => {
    changeKind(t.kind);
    if (t.kind === "socks") {
      setBindHost("127.0.0.1");
    } else {
      setBindHost(defaultBind(t.kind));
      setDestHost("127.0.0.1");
      setDestPort(String(t.port));
    }
    setBindPort(String(t.port));
    setName(t.name);
    setError(null);
  };

  const open = isOpenBind(bindHost.trim());
  const bp = parsePort(bindPort);
  const dp = parsePort(destPort);
  const needsDest = kind !== "socks";

  const submit = async (activate: boolean, e?: FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    if (bp === null) return setError("El puerto de escucha debe ser un número entre 1 y 65535");
    if (needsDest && !destHost.trim()) return setError("Indica el equipo de destino");
    if (needsDest && dp === null) return setError("El puerto de destino debe ser un número entre 1 y 65535");
    setSaving(true);
    setError(null);
    try {
      await onSave(
        {
          ...initial,
          kind,
          name: name.trim(),
          bindHost: bindHost.trim() || defaultBind(kind),
          bindPort: bp,
          destHost: needsDest ? destHost.trim() : "",
          destPort: needsDest ? (dp ?? 0) : 0,
          autoStart,
        },
        activate,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const bindLabel = kind === "remote" ? "En el servidor" : "En tu PC";
  const BindIcon = kind === "remote" ? Server : Laptop;
  const DestIcon = kind === "remote" ? Laptop : Server;

  const warnings: string[] = [];
  if (open && kind !== "remote")
    warnings.push("Cualquier equipo de tu red podrá usar este túnel (y llegar al servidor a través de él).");
  if (open && kind === "remote")
    warnings.push("Será visible desde fuera del servidor solo si el servidor tiene activado GatewayPorts.");
  if (bp !== null && bp < 1024)
    warnings.push(
      kind === "remote"
        ? "En el servidor, los puertos menores que 1024 solo los puede abrir root."
        : "Los puertos menores que 1024 suelen necesitar permisos de administrador en tu PC.",
    );

  const footer = (
    <>
      <button className="btn" onClick={onClose} disabled={saving}>
        Cancelar
      </button>
      {canActivate && (
        <button className="btn" onClick={() => void submit(true)} disabled={saving}>
          Guardar y activar
        </button>
      )}
      <button className="btn btn-primary" type="submit" form="tn-form" disabled={saving}>
        {saving ? "Guardando…" : "Guardar"}
      </button>
    </>
  );

  return (
    <Modal open title={isNew ? "Nuevo túnel" : "Editar túnel"} onClose={onClose} footer={footer} width={520}>
      <form id="tn-form" className="tn-form" onSubmit={(e) => void submit(false, e)}>
        {isNew && (
          <div className="tn-templates" aria-label="Plantillas rápidas">
            <span className="tn-templates-label">Plantillas:</span>
            {TUNNEL_TEMPLATES.map((t) => (
              <button key={t.label} type="button" className="tn-chip" onClick={() => applyTemplate(t)}>
                {t.label} <span className="tn-chip-port">{t.port}</span>
              </button>
            ))}
          </div>
        )}

        <div className="tn-kinds" role="radiogroup" aria-label="Tipo de túnel">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={kind === k ? "tn-kind-opt on" : "tn-kind-opt"}
              onClick={() => changeKind(k)}
            >
              {KIND_INFO[k].label}
            </button>
          ))}
        </div>
        <p className="tn-help">{KIND_INFO[kind].help}</p>

        <label className="field">
          <span>Nombre</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "socks" ? "Proxy SOCKS" : "Base de datos"}
            autoFocus={!isNew}
            maxLength={120}
          />
        </label>

        <div className="tn-side">
          <div className="tn-side-title">
            <BindIcon size={14} /> {bindLabel} <span className="faint">(dónde se escucha)</span>
          </div>
          <div className="field-row">
            <label className="field tn-host">
              <span>Dirección</span>
              <input
                className="input mono"
                value={bindHost}
                onChange={(e) => setBindHost(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="field tn-port">
              <span>Puerto</span>
              <input
                className="input mono"
                value={bindPort}
                onChange={(e) => setBindPort(e.target.value)}
                inputMode="numeric"
                placeholder={kind === "socks" ? "1080" : "5432"}
                autoFocus={isNew}
              />
            </label>
          </div>
          <label className="checkbox tn-open">
            <input
              type="checkbox"
              checked={open}
              onChange={(e) => setBindHost(e.target.checked ? "0.0.0.0" : defaultBind(kind))}
            />
            {kind === "remote" ? "Accesible desde fuera del servidor (0.0.0.0)" : "Permitir desde otros equipos de tu red (0.0.0.0)"}
          </label>
        </div>

        {needsDest && (
          <div className="tn-side">
            <div className="tn-side-title">
              <DestIcon size={14} /> {kind === "remote" ? "Destino en tu PC" : "Destino"}{" "}
              <span className="faint">{kind === "remote" ? "(o en tu red)" : "(visto desde el servidor)"}</span>
            </div>
            <div className="field-row">
              <label className="field tn-host">
                <span>Equipo</span>
                <input
                  className="input mono"
                  value={destHost}
                  onChange={(e) => setDestHost(e.target.value)}
                  placeholder="127.0.0.1"
                  spellCheck={false}
                />
              </label>
              <label className="field tn-port">
                <span>Puerto</span>
                <input
                  className="input mono"
                  value={destPort}
                  onChange={(e) => setDestPort(e.target.value)}
                  inputMode="numeric"
                  placeholder="5432"
                />
              </label>
            </div>
            {kind === "local" && (
              <p className="tn-hint faint">127.0.0.1 es el propio servidor; también puedes poner otro equipo de su red (p. ej. «db»).</p>
            )}
          </div>
        )}

        {warnings.map((w) => (
          <div key={w} className="tn-warning">
            <TriangleAlert size={14} />
            <span>{w}</span>
          </div>
        ))}

        <label className="checkbox tn-auto-check">
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
          Activar automáticamente al conectar a este servidor
        </label>

        {error && <div className="field-error tn-error">{error}</div>}
      </form>
    </Modal>
  );
}
