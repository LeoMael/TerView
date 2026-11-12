// «Nuevo contenedor»: plantillas rápidas + formulario (imagen, nombre, puertos, volúmenes, variables,
// reinicio, red, comando) → `run -d`. Muestra el comando exacto mientras se rellena.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, Rocket, TerminalSquare, Trash2 } from "lucide-react";
import {
  RESTART_LABELS,
  TEMPLATES,
  emptyRunForm,
  runCmd,
  validateRunForm,
  type EnvRow,
  type PortRow,
  type RestartPolicy,
  type RunForm,
  type VolumeRow,
} from "../../features/containers";
import { toast } from "../../stores/toasts";
import { AdmModal } from "../Admin/AdmModal";
import { useCt } from "./context";

const RUN_TIMEOUT = 600;

export function RunDialog({ prefill, onClose }: { prefill?: Partial<RunForm>; onClose: () => void }) {
  const ct = useCt();
  const { engine, res } = ct;
  const [f, setF] = useState<RunForm>(() => ({ ...emptyRunForm(), ...prefill }));
  const [template, setTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const started = useRef(0);

  useEffect(() => {
    const missing = (["images", "networks", "volumes"] as const).filter((k) => res[k].loadedAt === 0 && !res[k].loading);
    if (missing.length) void ct.reload(...missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [busy]);

  const errors = validateRunForm(f);
  const valid = Object.keys(errors).length === 0;
  const cmd = useMemo(() => runCmd(engine, f), [engine, f]);
  const shown = ct.render(cmd);

  const imageTags = useMemo(() => {
    const out = new Set<string>();
    for (const i of res.images.data ?? []) for (const t of i.tags) out.add(t);
    return [...out].sort();
  }, [res.images.data]);
  const names = new Set((res.containers.data ?? []).map((c) => c.name));
  const nameTaken = f.name.trim() !== "" && names.has(f.name.trim());
  const imageMissing = f.image.trim() !== "" && res.images.data !== null && !imageTags.includes(f.image.trim()) && !imageTags.includes(`${f.image.trim()}:latest`);

  const set = <K extends keyof RunForm>(k: K, v: RunForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const setRow = <K extends "ports" | "volumes" | "env">(k: K, i: number, patch: Partial<RunForm[K][number]>) =>
    setF((s) => ({ ...s, [k]: (s[k] as RunForm[K][number][]).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRow = <K extends "ports" | "volumes" | "env">(k: K, row: RunForm[K][number]) => setF((s) => ({ ...s, [k]: [...s[k], row] }));
  const delRow = (k: "ports" | "volumes" | "env", i: number) => setF((s) => ({ ...s, [k]: s[k].filter((_, j) => j !== i) }));

  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    let next = t.build();
    // Si el nombre ya existe, se sugiere otro.
    if (names.has(next.name)) {
      let n = 2;
      while (names.has(`${next.name}-${n}`)) n++;
      next = { ...next, name: `${next.name}-${n}` };
    }
    setF(next);
    setTemplate(id);
    setError(null);
  };

  const submit = async () => {
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    started.current = Date.now();
    setElapsed(0);
    const r = await ct.run([cmd], RUN_TIMEOUT);
    setBusy(false);
    if (r.ok) {
      toast.success("Contenedor creado y en marcha", f.name || f.image);
      void ct.reload("containers", "images");
      onClose();
    } else setError(r.error);
  };

  const err = (k: string) => (touched || k === "image" ? errors[k] : undefined);

  return (
    <AdmModal title="Nuevo contenedor" onClose={busy ? () => {} : onClose} width={760}>
      <form
        className="ct-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="modal-body">
          <div className="ct-templates" role="group" aria-label="Plantillas rápidas">
            <span className="section-label">Plantillas</span>
            {TEMPLATES.filter((t) => !t.dockerOnly || engine === "docker").map((t) => (
              <button
                type="button"
                key={t.id}
                className={template === t.id ? "ct-tpl on" : "ct-tpl"}
                title={t.description}
                onClick={() => applyTemplate(t.id)}
                disabled={busy}
              >
                {t.label}
              </button>
            ))}
          </div>

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
              <input className="input mono" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="mi-servicio" spellCheck={false} />
            </label>
          </div>
          {touched && errors.image && <div className="field-error">{errors.image}</div>}
          {err("name") && <div className="field-error">{errors.name}</div>}
          {nameTaken && <div className="field-error">Ya hay un contenedor con ese nombre</div>}
          {imageMissing && <div className="ct-hint-line faint">La imagen no está en el servidor: se descargará al crear el contenedor (puede tardar).</div>}

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
              {(res.volumes.data ?? []).filter((v) => !v.anonymous).map((v) => (
                <option key={v.name} value={v.name} />
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
                {(res.networks.data ?? [])
                  .filter((n) => n.name !== "none")
                  .map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name}
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
          {engine === "podman" && f.restart !== "no" && !ct.needsSudo && (
            <div className="ct-hint-line faint">
              En Podman sin root, para que arranque solo al reiniciar el servidor hace falta «loginctl enable-linger» y el servicio podman-restart.
            </div>
          )}

          <div className="ct-review-label">Se ejecutará:</div>
          <pre className="ct-cmd">{shown}</pre>
          {error && (
            <div className="ct-error" role="alert">
              <AlertTriangle size={14} />
              <pre>{error}</pre>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn ct-footer-left"
            disabled={!valid || busy}
            title="Escribe el comando en la terminal para ver el progreso de la descarga"
            onClick={() => {
              if (ct.toTerminal(cmd, true)) onClose();
            }}
          >
            <TerminalSquare size={13} /> En la terminal
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || (touched && !valid) || nameTaken}>
            {busy ? <span className="spinner ct-spinner-sm" /> : <Rocket size={13} />}
            {busy ? (imageMissing ? `Descargando y creando… ${elapsed} s` : `Creando… ${elapsed} s`) : "Crear y arrancar"}
          </button>
        </div>
      </form>
    </AdmModal>
  );
}
