// «Nuevo contenedor»: plantillas rápidas + formulario (imagen, nombre, puertos, volúmenes, variables,
// reinicio, red, comando) → `run -d`. Muestra el comando exacto mientras se rellena.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Rocket, TerminalSquare } from "lucide-react";
import { TEMPLATES, emptyRunForm, runCmd, validateRunForm, type RunForm } from "../../features/containers";
import { toast } from "../../stores/toasts";
import { AdmModal } from "../Admin/AdmModal";
import { useCt } from "./context";
import { RunFormFields } from "./RunFormFields";

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

          <RunFormFields
            f={f}
            setF={setF}
            engine={engine}
            errors={errors}
            touched={touched}
            imageTags={imageTags}
            volumeNames={(res.volumes.data ?? []).filter((v) => !v.anonymous).map((v) => v.name)}
            networkNames={(res.networks.data ?? []).map((n) => n.name)}
            lingerHint={!ct.needsSudo}
            afterName={
              <>
                {nameTaken && <div className="field-error">Ya hay un contenedor con ese nombre</div>}
                {imageMissing && <div className="ct-hint-line faint">La imagen no está en el servidor: se descargará al crear el contenedor (puede tardar).</div>}
              </>
            }
          />

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
