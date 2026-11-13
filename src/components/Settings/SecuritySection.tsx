// Ajustes → Seguridad: PIN de 6 números (bóveda de contraseñas), bloqueo por inactividad y «Bloquear ahora».
import { useState } from "react";
import { Lock } from "lucide-react";
import { useSettings } from "../../stores/settings";
import { lockNow, useLock } from "../../features/lock/lockStore";
import { useShortcutText } from "../../features/shortcuts/shortcuts";
import { ChangePinForm, DisablePinForm, SetupPinForm, WhatItProtects } from "../../features/lock/PinForms";
import "../../features/lock/Lock.css";
import { SettingGroup, SettingRow as Row } from "../ui/SettingsKit";

const MINUTES: { v: number; label: string }[] = [
  { v: 5, label: "5 min" },
  { v: 10, label: "10 min" },
  { v: 15, label: "15 min" },
  { v: 30, label: "30 min" },
  { v: 60, label: "60 min" },
  { v: 0, label: "Nunca" },
];

type Form = null | "enable" | "disable" | "change";

export function SecuritySection() {
  const status = useLock((s) => s.status);
  const minutes = useSettings((s) => s.settings.lockMinutes);
  const lockKeys = useShortcutText("app.lock");
  const update = useSettings((s) => s.update);
  const [form, setForm] = useState<Form>(null);
  const enabled = !!status?.enabled;
  const close = () => setForm(null);

  return (
    <>
      <SettingGroup>
        <Row label="Proteger con PIN" hint={enabled ? undefined : "Cifra las contraseñas guardadas y bloquea TerView."}>
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
          <div className="st-block">
            <SetupPinForm autoFocus onDone={close} onCancel={close} />
          </div>
        )}
        {form === "disable" && (
          <div className="st-block">
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
              <div className="st-block">
                <ChangePinForm onDone={close} onCancel={close} />
              </div>
            )}
          </>
        )}

        <Row label="Bloquear tras" hint="Sin usar TerView.">
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

        <Row label="Bloquear ahora" hint={lockKeys || undefined}>
          <button className="btn" onClick={() => void lockNow()} disabled={!enabled}>
            <Lock size={14} /> Bloquear
          </button>
        </Row>
      </SettingGroup>

      <WhatItProtects />
    </>
  );
}
