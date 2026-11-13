// Ajustes → Atajos de teclado: lista por grupos con buscador; clic en un atajo para cambiarlo.
// Solo se guardan los cambios respecto a los de por defecto (settings.shortcuts).
import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Search, TriangleAlert, X } from "lucide-react";
import { SettingGroup } from "../ui/SettingsKit";
import { useSettings } from "../../stores/settings";
import { confirmDialog } from "../ui/dialogs";
import { isMac } from "../../lib/platform";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
  comboKeys,
  comboWarnings,
  defaultCombo,
  eventCombo,
  findConflicts,
  formatCombo,
  isModifierOnly,
  resolveCombo,
  withBinding,
  type ShortcutAction,
} from "../../features/shortcuts/keys";
import { setShortcutCapture } from "../../features/shortcuts/shortcuts";
import "./ShortcutsSection.css";

/** Minúsculas y sin tildes, para buscar sin importar cómo se escriba. */
const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

interface Pending {
  id: string;
  combo: string;
  conflicts: ShortcutAction[];
  warnings: string[];
}

export function ShortcutsSection() {
  const overrides = useSettings((s) => s.settings.shortcuts);
  const update = useSettings((s) => s.update);
  const [query, setQuery] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const save = (next: Record<string, string>) => update({ shortcuts: next });
  const assign = (id: string, combo: string, clear: string[] = []) => {
    let next = overrides;
    for (const other of clear) next = withBinding(next, other, "", isMac);
    save(withBinding(next, id, combo, isMac));
    setPending(null);
  };

  // Captura de la combinación nueva: va antes que cualquier otro atajo (y que Esc del diálogo).
  useEffect(() => {
    if (!capturing) return;
    setShortcutCapture(true);
    const id = capturing;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== "keydown" || isModifierOnly(e)) return;
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      setCapturing(null);
      if (plain && e.key === "Escape") return;
      if (plain && e.key === "Backspace") {
        assign(id, "");
        return;
      }
      const combo = eventCombo(e);
      if (!combo) return;
      const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
      if (!action || combo === resolveCombo(id, overrides, isMac)) return;
      const conflicts = findConflicts(id, combo, overrides, isMac);
      const warnings = comboWarnings(combo, action.scope, isMac);
      if (conflicts.length || warnings.length) setPending({ id, combo, conflicts, warnings });
      else assign(id, combo);
    };
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      setShortcutCapture(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  const q = fold(query.trim());
  const groups = useMemo(
    () =>
      SHORTCUT_GROUPS.map((g) => ({
        group: g,
        items: SHORTCUT_ACTIONS.filter(
          (a) =>
            a.group === g &&
            (!q || fold(`${a.label} ${a.group} ${formatCombo(resolveCombo(a.id, overrides, isMac), isMac)}`).includes(q)),
        ),
      })).filter((g) => g.items.length > 0),
    [q, overrides],
  );
  const changed = Object.keys(overrides ?? {}).length;

  const resetAll = async () => {
    const ok = await confirmDialog({
      title: "Restablecer atajos",
      message: "Todos los atajos vuelven a los de por defecto.",
      confirmText: "Restablecer",
    });
    if (ok) save({});
  };

  return (
    <>
      <div className="sc-toolbar">
        <div className="sc-search">
          <Search size={14} aria-hidden />
          <input
            className="input"
            placeholder="Buscar acción o tecla…"
            value={query}
            aria-label="Buscar atajo"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <button type="button" className="icon-btn" aria-label="Borrar búsqueda" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <button className="btn" onClick={() => void resetAll()} disabled={!changed}>
          <RotateCcw size={14} /> Restablecer todos
        </button>
      </div>

      {groups.map((g) => (
        <SettingGroup key={g.group} title={g.group}>
          {g.items.map((a) => {
            const combo = resolveCombo(a.id, overrides, isMac);
            const isDefault = !(overrides && a.id in overrides);
            const isCapturing = capturing === a.id;
            const p = pending?.id === a.id ? pending : null;
            return (
              <div key={a.id} className="st-block sc-item">
                <div className="sc-row">
                  <span className="sc-label">{a.label}</span>
                  <button
                    type="button"
                    className={isCapturing ? "sc-keys capturing" : "sc-keys"}
                    title={isCapturing ? "Esc cancela · Retroceso lo deja sin atajo" : "Clic para cambiar"}
                    aria-label={`${a.label}: ${combo ? formatCombo(combo, isMac) : "sin atajo"}. Cambiar`}
                    onClick={() => {
                      setPending(null);
                      setCapturing(isCapturing ? null : a.id);
                    }}
                    onBlur={() => isCapturing && setCapturing(null)}
                  >
                    {isCapturing ? (
                      <span className="sc-wait">Pulsa el nuevo atajo…</span>
                    ) : combo ? (
                      comboKeys(combo, isMac).map((k, i) => <kbd key={i}>{k}</kbd>)
                    ) : (
                      <span className="sc-none">Sin atajo</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn sc-reset"
                    title={`Restablecer (${formatCombo(defaultCombo(a, isMac), isMac) || "sin atajo"})`}
                    aria-label="Restablecer este atajo"
                    disabled={isDefault}
                    onClick={() => assign(a.id, defaultCombo(a, isMac))}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
                {p && (
                  <div className="sc-warn" role="alert">
                    <TriangleAlert size={14} aria-hidden />
                    <div className="sc-warn-text">
                      {p.conflicts.length > 0 && (
                        <span>
                          {formatCombo(p.combo, isMac)} ya lo usa {p.conflicts.map((c) => `«${c.label}»`).join(", ")}.
                        </span>
                      )}
                      {p.warnings.map((w) => (
                        <span key={w}>{w}</span>
                      ))}
                    </div>
                    <div className="sc-warn-actions">
                      <button className="btn" onClick={() => setPending(null)}>
                        Cancelar
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => assign(p.id, p.combo, p.conflicts.map((c) => c.id))}
                      >
                        {p.conflicts.length ? "Reemplazar" : "Usar igualmente"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </SettingGroup>
      ))}
      {groups.length === 0 && <p className="sc-empty">Sin resultados para «{query.trim()}».</p>}
      <p className="sc-note">
        Esc, Enter, Supr en una pestaña y los atajos con el ratón no se cambian. Con el foco en la terminal, las
        combinaciones de la shell (Ctrl+letra) son para la terminal.
      </p>
    </>
  );
}
