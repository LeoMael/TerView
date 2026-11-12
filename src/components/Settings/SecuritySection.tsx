// Ajustes → Seguridad: PIN (bóveda de contraseñas), bloqueo por inactividad y «Bloquear ahora».
import { useState, type ReactNode } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { useSettings } from "../../stores/settings";
import { LOCK_SHORTCUT_LABEL, lockNow, useLock } from "../../features/lock/lockStore";
import { ChangePinForm, DisablePinForm, SetupPinForm } from "../../features/lock/PinForms";
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

      {!enabled && form === null && (
        <div className="lock-warn sec-reminder">
          <ShieldCheck size={16} />
          <span>
            Recomendado: protege tus contraseñas guardadas con un PIN. Ahora están en el llavero del sistema, que otros
            programas de tu usuario pueden leer.
          </span>
        </div>
      )}

      <Row
        label="Proteger con PIN"
        hint={
          enabled
            ? "Activado: las contraseñas guardadas están cifradas y TerView se bloquea al abrirlo y tras un rato sin uso."
            : "Cifra las contraseñas guardadas y bloquea TerView al abrirlo y tras un rato sin uso."
        }
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
          <Row label="Cambiar PIN" hint="Pide el PIN actual. La bóveda se vuelve a cifrar con el nuevo.">
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

      <Row label="Bloquear tras" hint="Minutos sin tocar el teclado ni el ratón en ninguna ventana de TerView.">
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

      <Row label="Bloquear ahora" hint={`Atajo: ${LOCK_SHORTCUT_LABEL}, desde cualquier ventana.`}>
        <button className="btn" onClick={() => void lockNow()} disabled={!enabled}>
          <Lock size={14} /> Bloquear
        </button>
      </Row>

      <h4 className="st-subtitle">Qué protege y qué no</h4>
      <div className="sec-explain">
        <p>
          <strong>Protege:</strong>
        </p>
        <ul>
          <li>
            Las contraseñas y frases guardadas de tus servidores y el token de GitHub. Van cifradas con tu PIN y con una
            llave de este equipo: otros programas ya no las pueden leer del llavero del sistema, y quien copie el
            archivo de la bóveda a otro PC no puede abrirlo.
          </li>
          <li>
            Al bloquear se tapan todas las ventanas de TerView y se borran de la memoria las contraseñas descifradas y
            las de sudo.
          </li>
          <li>
            Tras 5 PIN incorrectos hay que esperar 30 s, luego el doble cada vez (hasta 15 min), aunque cierres
            TerView. Nunca se borra nada por fallar.
          </li>
        </ul>
        <p>
          <strong>No protege:</strong>
        </p>
        <ul>
          <li>Las conexiones abiertas siguen vivas mientras está bloqueado: solo se tapa la pantalla.</li>
          <li>
            Servidores, ajustes y tus llaves de ~/.ssh no se cifran aquí (las llaves se protegen con su propia frase).
          </li>
          <li>
            Un programa malicioso que ya controle tu usuario podría ver el PIN al escribirlo. Un PIN corto te protege de
            alguien sentado en tu PC; una frase de 4 o 5 palabras resiste también ataques al archivo de la bóveda.
          </li>
          <li>
            Si olvidas el PIN, las contraseñas guardadas se pierden. «Olvidé mi PIN», en la pantalla de bloqueo, borra
            la bóveda para empezar de cero sin perder lo demás.
          </li>
        </ul>
      </div>
    </>
  );
}
