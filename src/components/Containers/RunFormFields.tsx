// Campos del formulario «Nuevo contenedor» (imagen, nombre, puertos, volúmenes, variables, reinicio,
// red y comando). Los usan «Nuevo contenedor» (Contenedores) y «Reemplazar contenedor» (escáner →
// Actualizar imagen).
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Plus, Trash2 } from "lucide-react";
import { RESTART_LABELS, type Engine, type EnvRow, type PortRow, type RestartPolicy, type RunForm, type VolumeRow } from "../../features/containers";

interface Props {
  f: RunForm;
  setF: Dispatch<SetStateAction<RunForm>>;
  engine: Engine;
  /** Errores de `validateRunForm`. */
  errors: Record<string, string>;
  /** Mostrar todos los errores (tras intentar enviar). */
  touched: boolean;
  /** Etiquetas de imágenes del servidor (sugerencias). */
  imageTags: string[];
  /** Volúmenes con nombre (sugerencias). */
  volumeNames: string[];
  /** Redes que se pueden elegir (además de «Por defecto»). */
  networkNames: string[];
  /** Aviso de «loginctl enable-linger» (Podman sin root). */
  lingerHint: boolean;
  /** No se puede cambiar el nombre (reemplazar un contenedor). */
  nameLocked?: boolean;
  /** Avisos debajo de imagen y nombre. */
  afterName?: ReactNode;
}

export function RunFormFields({ f, setF, engine, errors, touched, imageTags, volumeNames, networkNames, lingerHint, nameLocked, afterName }: Props) {
  const set = <K extends keyof RunForm>(k: K, v: RunForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const setRow = <K extends "ports" | "volumes" | "env">(k: K, i: number, patch: Partial<RunForm[K][number]>) =>
    setF((s) => ({ ...s, [k]: (s[k] as RunForm[K][number][]).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRow = <K extends "ports" | "volumes" | "env">(k: K, row: RunForm[K][number]) => setF((s) => ({ ...s, [k]: [...s[k], row] }));
  const delRow = (k: "ports" | "volumes" | "env", i: number) => setF((s) => ({ ...s, [k]: s[k].filter((_, j) => j !== i) }));
  const err = (k: string) => (touched || k === "image" ? errors[k] : undefined);
  const networks = [...new Set([...networkNames.filter((n) => n !== "none"), ...(f.network ? [f.network] : [])])];

  return (
    <>
      <div className="field-row">
        <label className="field ct-grow2">
          <span>Imagen</span>
          <input
            className="input mono"
            list="ct-image-list"
            value={f.image}
            onChange={(e) => set("image", e.target.value)}
            placeholder="docker.io/library/nginx:alpine"
            spellCheck={false}
            autoFocus
            aria-invalid={!!(touched && errors.image)}
          />
          <datalist id="ct-image-list">
            {imageTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Nombre (opcional)</span>
          <input
            className="input mono"
            value={f.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="mi-servicio"
            spellCheck={false}
            disabled={nameLocked}
            title={nameLocked ? "El contenedor nuevo se llama igual que el que sustituye" : undefined}
          />
        </label>
      </div>
      {touched && errors.image && <div className="field-error">{errors.image}</div>}
      {err("name") && <div className="field-error">{errors.name}</div>}
      {afterName}

      <div className="ct-rows">
        <div className="ct-rows-head">
          <span className="section-label">Puertos</span>
          <span className="faint">servidor → contenedor</span>
          <button type="button" className="btn btn-sm" onClick={() => addRow("ports", { host: "", container: "", protocol: "tcp", localOnly: false } as PortRow)}>
            <Plus size={12} /> Puerto
          </button>
        </div>
        {f.ports.map((p, i) => (
          <div key={i}>
            <div className="ct-row">
              <input className="input mono ct-w-port" value={p.host} onChange={(e) => setRow("ports", i, { host: e.target.value })} placeholder="8080" aria-label="Puerto del servidor" inputMode="numeric" />
              <span className="faint">→</span>
              <input className="input mono ct-w-port" value={p.container} onChange={(e) => setRow("ports", i, { container: e.target.value })} placeholder="80" aria-label="Puerto del contenedor" inputMode="numeric" />
              <select className="select ct-select-sm" value={p.protocol} onChange={(e) => setRow("ports", i, { protocol: e.target.value as "tcp" | "udp" })} aria-label="Protocolo">
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
              <label className="checkbox" title="Publicar solo en 127.0.0.1: no se puede entrar desde fuera del servidor (usa un túnel)">
                <input type="checkbox" checked={p.localOnly} onChange={(e) => setRow("ports", i, { localOnly: e.target.checked })} /> Solo local
              </label>
              <span className="ct-grow" />
              <button type="button" className="icon-btn" onClick={() => delRow("ports", i)} aria-label="Quitar puerto">
                <Trash2 size={13} />
              </button>
            </div>
            {err(`port${i}`) && <div className="field-error">{errors[`port${i}`]}</div>}
          </div>
        ))}
      </div>

      <div className="ct-rows">
        <div className="ct-rows-head">
          <span className="section-label">Volúmenes y carpetas</span>
          <span className="faint">carpeta del servidor o volumen → ruta dentro</span>
          <button type="button" className="btn btn-sm" onClick={() => addRow("volumes", { source: "", target: "", readOnly: false } as VolumeRow)}>
            <Plus size={12} /> Volumen
          </button>
        </div>
        {f.volumes.map((v, i) => (
          <div key={i}>
            <div className="ct-row">
              <input
                className="input mono ct-grow"
                list="ct-volume-list"
                value={v.source}
                onChange={(e) => setRow("volumes", i, { source: e.target.value })}
                placeholder="/srv/datos  o  mis_datos"
                aria-label="Carpeta del servidor o volumen"
              />
              <span className="faint">→</span>
              <input className="input mono ct-grow" value={v.target} onChange={(e) => setRow("volumes", i, { target: e.target.value })} placeholder="/datos" aria-label="Ruta dentro del contenedor" />
              <label className="checkbox" title="Solo lectura">
                <input type="checkbox" checked={v.readOnly} onChange={(e) => setRow("volumes", i, { readOnly: e.target.checked })} /> Lectura
              </label>
              <button type="button" className="icon-btn" onClick={() => delRow("volumes", i)} aria-label="Quitar volumen">
                <Trash2 size={13} />
              </button>
            </div>
            {err(`vol${i}`) && <div className="field-error">{errors[`vol${i}`]}</div>}
          </div>
        ))}
        <datalist id="ct-volume-list">
          {volumeNames.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        {engine === "podman" && f.volumes.some((v) => v.source.startsWith("/")) && (
          <label className="checkbox ct-hint-line" title="Necesario en servidores con SELinux (Fedora, RHEL…) para que el contenedor pueda leer la carpeta">
            <input type="checkbox" checked={f.selinuxLabel} onChange={(e) => set("selinuxLabel", e.target.checked)} /> Etiquetar carpetas para SELinux (:Z)
          </label>
        )}
      </div>

      <div className="ct-rows">
        <div className="ct-rows-head">
          <span className="section-label">Variables de entorno</span>
          <button type="button" className="btn btn-sm" onClick={() => addRow("env", { key: "", value: "" } as EnvRow)}>
            <Plus size={12} /> Variable
          </button>
        </div>
        {f.env.map((e, i) => (
          <div key={i}>
            <div className="ct-row">
              <input className="input mono ct-w-key" value={e.key} onChange={(ev) => setRow("env", i, { key: ev.target.value })} placeholder="NOMBRE" aria-label="Nombre de la variable" spellCheck={false} />
              <span className="faint">=</span>
              <input className="input mono ct-grow" value={e.value} onChange={(ev) => setRow("env", i, { value: ev.target.value })} placeholder="valor" aria-label="Valor" spellCheck={false} />
              <button type="button" className="icon-btn" onClick={() => delRow("env", i)} aria-label="Quitar variable">
                <Trash2 size={13} />
              </button>
            </div>
            {err(`env${i}`) && <div className="field-error">{errors[`env${i}`]}</div>}
          </div>
        ))}
      </div>

      <div className="field-row">
        <label className="field">
          <span>Reinicio automático</span>
          <select className="select" value={f.restart} onChange={(e) => set("restart", e.target.value as RestartPolicy)}>
            {(Object.keys(RESTART_LABELS) as RestartPolicy[]).map((k) => (
              <option key={k} value={k}>
                {RESTART_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Red</span>
          <select className="select" value={f.network} onChange={(e) => set("network", e.target.value)}>
            <option value="">Por defecto</option>
            {networks.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Comando (opcional, sustituye al de la imagen)</span>
        <input className="input mono" value={f.command} onChange={(e) => set("command", e.target.value)} placeholder="(vacío: el de la imagen)" spellCheck={false} />
      </label>
      {err("command") && <div className="field-error">{errors.command}</div>}
      {engine === "podman" && f.restart !== "no" && lingerHint && (
        <div className="ct-hint-line faint">
          En Podman sin root, para que arranque solo al reiniciar el servidor hace falta «loginctl enable-linger» y el servicio podman-restart.
        </div>
      )}
    </>
  );
}
