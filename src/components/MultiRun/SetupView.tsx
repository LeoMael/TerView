// Paso 1: elegir servidores y comando (con variables), opciones y avisos de seguridad.
import { useMemo, useState } from "react";
import { createElement } from "react";
import { AlertTriangle, BookOpen, Info, Play, ShieldAlert, X } from "lucide-react";
import { CATALOG, varHint, type CatalogVar } from "../Commands/catalog";
import { missingVars, parseVars, renderTemplate, varLabel } from "../Commands/template";
import { dangerReasons, looksInteractive, usesSudo, usesSudoNonInteractive } from "../../features/multirun/danger";
import { startMultiRun, updateDraft, useMultiRun } from "../../features/multirun/store";
import { useProfiles } from "../../stores/profiles";
import { promptDialog } from "../ui/dialogs";
import { LibraryPicker } from "./LibraryPicker";
import { ServerPicker, useConnectedProfiles, userHost } from "./ServerPicker";

const TIMEOUT_OPTIONS = [10, 30, 60, 120, 300, 600];

function hintFor(command: string, name: string): CatalogVar | undefined {
  const entry = CATALOG.find((e) => e.command === command);
  return entry?.vars?.[name] ?? varHint(name);
}

export function SetupView({ onCancel }: { onCancel: () => void }) {
  const draft = useMultiRun((s) => s.draft);
  const nonce = useMultiRun((s) => s.nonce);
  const servers = useProfiles((s) => s.servers);
  const connected = useConnectedProfiles();
  const [libOpen, setLibOpen] = useState(false);

  const chosen = useMemo(() => {
    const sel = new Set(draft.selected);
    return servers.filter((s) => sel.has(s.id));
  }, [servers, draft.selected]);

  const template = draft.command;
  const vars = useMemo(() => parseVars(template), [template]);
  const missing = useMemo(() => missingVars(template, draft.values), [template, draft.values]);
  const finalCommand = useMemo(
    () => renderTemplate(template, draft.values, { fillMissing: true }).trim(),
    [template, draft.values],
  );
  const dangers = useMemo(() => {
    const r = dangerReasons(finalCommand);
    if (draft.flaggedDangerous && r.length === 0) r.push("marcado como peligroso en la biblioteca");
    return r;
  }, [finalCommand, draft.flaggedDangerous]);
  const sudo = usesSudo(finalCommand);
  const sudoN = usesSudoNonInteractive(finalCommand);
  const interactive = looksInteractive(finalCommand);

  const n = chosen.length;
  const reused = chosen.filter((s) => connected.has(s.id)).length;

  let blocker: string | null = null;
  if (n === 0) blocker = "Elige al menos un servidor";
  else if (!template.trim()) blocker = "Escribe un comando o elige uno de la biblioteca";
  else if (missing.length > 0) blocker = `Falta: ${missing.map(varLabel).join(", ")}`;

  const run = async () => {
    if (blocker) return;
    if (dangers.length > 0) {
      const message = createElement(
        "div",
        { className: "mr-confirm" },
        createElement(
          "p",
          null,
          `Este comando puede borrar datos o cortar servicios (${dangers.join("; ")}) y se ejecutará en `,
          createElement("strong", null, n === 1 ? "1 servidor" : `${n} servidores`),
          " a la vez.",
        ),
        createElement("pre", { className: "mr-confirm-pre mono" }, finalCommand),
        createElement(
          "p",
          { className: "mr-confirm-list" },
          chosen
            .slice(0, 12)
            .map((s) => s.name)
            .join(", ") + (n > 12 ? ` y ${n - 12} más` : ""),
        ),
      );
      const typed = await promptDialog({
        title: "Confirmar comando peligroso",
        message,
        label: `Escribe ${n} (el número de servidores) para confirmar`,
        placeholder: String(n),
        confirmText: `Ejecutar en ${n}`,
        validate: (v) => (v.trim() === String(n) ? null : `Escribe ${n} para confirmar`),
      });
      if (typed === null || typed.trim() !== String(n)) return;
    }
    startMultiRun(
      {
        command: finalCommand,
        label: draft.label,
        timeoutSecs: draft.timeoutSecs,
        concurrency: draft.concurrency,
        usesSudo: sudo,
      },
      chosen.map((s) => ({ profileId: s.id, name: s.name, address: userHost(s), auth: s.auth })),
    );
  };

  return (
    <>
      <div className="mr-setup">
        <section className="mr-col mr-col-servers" aria-label="Servidores">
          <div className="section-label mr-col-title">Servidores</div>
          <ServerPicker selected={draft.selected} onChange={(ids) => updateDraft({ selected: ids })} focusNonce={nonce} />
        </section>

        <section className={`mr-col mr-col-command${libOpen ? " lib-open" : ""}`} aria-label="Comando">
          {libOpen && (
            <LibraryPicker
              onClose={() => setLibOpen(false)}
              onPick={(c) => {
                updateDraft({ command: c.command, label: c.label, flaggedDangerous: c.dangerous, values: {} });
                setLibOpen(false);
              }}
            />
          )}
          <div className="mr-cmd-head">
            <span className="section-label">Comando</span>
            {draft.label && (
              <span className="mr-lib-chip" title="Elegido de la biblioteca">
                <BookOpen size={12} /> {draft.label}
                <button
                  aria-label="Quitar nombre de la biblioteca"
                  onClick={() => updateDraft({ label: null, flaggedDangerous: false })}
                >
                  <X size={11} />
                </button>
              </span>
            )}
            <span className="mr-grow" />
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.currentTarget.closest(".mr-col-command")?.scrollTo(0, 0);
                setLibOpen(true);
              }}
            >
              <BookOpen size={13} /> Biblioteca…
            </button>
          </div>
          <textarea
            className="textarea mono mr-cmd-input"
            value={draft.command}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            rows={4}
            placeholder={"uptime\ndf -h /\nsystemctl is-active {{servicio:nginx}}"}
            aria-label="Comando a ejecutar"
            onChange={(e) => updateDraft({ command: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="mr-hint faint">
            Usa <span className="mono">{"{{nombre}}"}</span> o <span className="mono">{"{{nombre:valor}}"}</span> para
            variables. Se ejecuta sin terminal (como <span className="mono">ssh servidor 'comando'</span>), en la carpeta
            personal. Ctrl+Enter para ejecutar.
          </div>

          {vars.length > 0 && (
            <div className="mr-vars">
              {vars.map((v) => {
                const hint = hintFor(template, v.name);
                const listId = hint?.options ? `mr-opt-${v.name}` : undefined;
                const isMissing = missing.includes(v.name);
                return (
                  <label key={v.name} className="field mr-var">
                    <span>{hint?.label ?? varLabel(v.name)}</span>
                    <input
                      className={`input mono${isMissing ? " mr-invalid" : ""}`}
                      value={draft.values[v.name] ?? ""}
                      placeholder={v.default ?? hint?.default ?? ""}
                      list={listId}
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(e) => updateDraft({ values: { ...draft.values, [v.name]: e.target.value } })}
                    />
                    {listId && (
                      <datalist id={listId}>
                        {hint?.options?.map((o) => <option key={o} value={o} />)}
                      </datalist>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {vars.length > 0 && template.trim() && (
            <div className="mr-preview">
              <span className="section-label">Se ejecutará</span>
              <pre className="mono">{renderTemplate(template, draft.values)}</pre>
            </div>
          )}

          <div className="mr-options">
            <label className="field mr-opt">
              <span>Tiempo máximo por servidor</span>
              <select
                className="select"
                value={draft.timeoutSecs}
                onChange={(e) => updateDraft({ timeoutSecs: Number(e.target.value) })}
              >
                {[...new Set([...TIMEOUT_OPTIONS, draft.timeoutSecs])]
                  .sort((a, b) => a - b)
                  .map((t) => (
                    <option key={t} value={t}>
                      {t < 60 ? `${t} s` : `${t / 60} min`}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field mr-opt">
              <span>Servidores a la vez</span>
              <select
                className="select"
                value={draft.concurrency}
                onChange={(e) => updateDraft({ concurrency: Number(e.target.value) })}
              >
                {[1, 2, 4, 6, 8, 12, 16].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mr-warnings">
            {dangers.length > 0 && (
              <div className="mr-banner danger">
                <ShieldAlert size={16} />
                <div>
                  <strong>Comando peligroso:</strong> {dangers.join("; ")}. Se pedirá confirmación escribiendo el
                  número de servidores.
                </div>
              </div>
            )}
            {sudo && (
              <div className="mr-banner warn">
                <AlertTriangle size={16} />
                <div>
                  {sudoN ? (
                    <>
                      Usa <span className="mono">sudo -n</span>: solo funcionará en los servidores con sudo sin
                      contraseña.
                    </>
                  ) : (
                    <>
                      Usa <strong>sudo</strong>: la ejecución no es interactiva y no puede escribir la contraseña. Solo
                      funcionará donde sudo no pida contraseña (o como root); en el resto fallará. En los resultados verás
                      el tipo de acceso de cada servidor.
                    </>
                  )}
                </div>
              </div>
            )}
            {interactive && (
              <div className="mr-banner warn">
                <AlertTriangle size={16} />
                <div>
                  Parece interactivo o sin fin (top, tail -f, un editor…): no terminará solo y se cortará al agotarse el
                  tiempo.
                </div>
              </div>
            )}
            {n > 0 && (
              <div className="mr-banner info">
                <Info size={16} />
                <div>
                  {reused > 0 && (
                    <>
                      {reused === 1 ? "1 servidor usa" : `${reused} servidores usan`} la conexión de una pestaña abierta.{" "}
                    </>
                  )}
                  {n - reused > 0 && (
                    <>
                      {n - reused === 1 ? "1 se conectará" : `${n - reused} se conectarán`} en segundo plano (sin abrir
                      pestaña) y se desconectará{n - reused === 1 ? "" : "n"} al terminar.
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="mr-footer">
        <span className={`mr-footer-msg${blocker ? " faint" : ""}`}>
          {blocker ??
            `${n === 1 ? "1 servidor" : `${n} servidores`}, hasta ${Math.min(draft.concurrency, n)} a la vez, ${
              draft.timeoutSecs < 60 ? `${draft.timeoutSecs} s` : `${draft.timeoutSecs / 60} min`
            } como máximo cada uno`}
        </span>
        <span className="mr-grow" />
        <button className="btn" onClick={onCancel}>
          Cerrar
        </button>
        <button
          className={`btn ${dangers.length > 0 ? "btn-danger" : "btn-primary"}`}
          disabled={!!blocker}
          onClick={() => void run()}
        >
          <Play size={14} /> Ejecutar en {n === 1 ? "1 servidor" : `${n} servidores`}
        </button>
      </div>
    </>
  );
}
