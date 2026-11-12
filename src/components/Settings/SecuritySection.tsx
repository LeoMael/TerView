// Ajustes → Seguridad: PIN de 6 números (bóveda de contraseñas), bloqueo por inactividad y «Bloquear ahora».
import { useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { useSettings } from "../../stores/settings";
import { LOCK_SHORTCUT_LABEL, lockNow, useLock } from "../../features/lock/lockStore";
import { ChangePinForm, DisablePinForm, SetupPinForm, WhatItProtects } from "../../features/lock/PinForms";
import "../../features/lock/Lock.css";

const MINUTES: { v: number; label: string }[] = [
  { v: 5, label: "5 min" },
  { v: 10, label: "10 min" },
  { v: 15, label: "15 min" },
  { v: 30, label: "30 min" },
  { v: 60, label: "60 min" },
  { v: 0, label: "Nunca" },
];

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

type Form = null | "enable" | "disable" | "change";

export function SecuritySection() {
  const status = useLock((s) => s.status);
  const minutes = useSettings((s) => s.settings.lockMinutes);
  const update = useSettings((s) => s.update);
  const [form, setForm] = useState<Form>(null);
  const enabled = !!status?.enabled;
  const close = () => setForm(null);

  return (
    <>
      <h3 className="st-title">Seguridad</h3>

      <Row
        label="Proteger con PIN"
        hint={enabled ? "Activado." : "Cifra las contraseñas guardadas y bloquea TerView."}
      >
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Proteger con PIN"
          className={enabled ? "st-switch on" : "st-switch"}
          onClick={() => setForm(enabled ? "disable" : "enable")}
          disabled={!status || form !== null}
        >
          <span />
        </button>
      </Row>

      {form === "enable" && (
        <div className="sec-form">
          <SetupPinForm autoFocus onDone={close} onCancel={close} />
        </div>
      )}
      {form === "disable" && (
        <div className="sec-form">
          <DisablePinForm onDone={close} onCancel={close} />
        </div>
      )}

      {enabled && (
        <>
          <Row label="Cambiar PIN">
            <button className="btn" onClick={() => setForm("change")} disabled={form !== null}>
              Cambiar PIN
            </button>
          </Row>
          {form === "change" && (
            <div className="sec-form">
              <ChangePinForm onDone={close} onCancel={close} />
            </div>
          )}
        </>
      )}

      <Row label="Bloquear tras" hint="Minutos sin usar TerView.">
        <div className={enabled ? "st-segmented" : "st-segmented st-disabled"} role="radiogroup" aria-label="Bloquear tras">
          {MINUTES.map((o) => (
            <button
              key={o.v}
              role="radio"
              aria-checked={minutes === o.v}
              className={minutes === o.v ? "active" : ""}
              onClick={() => update({ lockMinutes: o.v })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Bloquear ahora" hint={LOCK_SHORTCUT_LABEL}>
        <button className="btn" onClick={() => void lockNow()} disabled={!enabled}>
          <Lock size={14} /> Bloquear
        </button>
      </Row>

      <WhatItProtects />
    </>
  );
}
