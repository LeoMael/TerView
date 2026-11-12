// Configuración de alertas de un servidor (se guarda por perfil).
import { useState } from "react";
import { Modal } from "../ui/Modal";
import { loadAlerts, saveAlerts, type ActiveAlert, type AlertConfig } from "../../features/monitor";

interface AlertsDialogProps {
  open: boolean;
  profileId: string;
  serverName: string;
  active: ActiveAlert[];
  onClose: () => void;
}

export function AlertsDialog(props: AlertsDialogProps) {
  if (!props.open) return null;
  return <AlertsDialogBody {...props} />;
}

function AlertsDialogBody({ profileId, serverName, active, onClose }: AlertsDialogProps) {
  const [cfg, setCfg] = useState<AlertConfig>(() => loadAlerts(profileId));

  const save = () => {
    saveAlerts(profileId, cfg);
    onClose();
  };

  const pctRow = (key: "disk" | "mem" | "cpu", label: string, suffix?: string) => (
    <div className="mon-alert-row">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={cfg[key].on}
          disabled={!cfg.enabled}
          onChange={(e) => setCfg({ ...cfg, [key]: { ...cfg[key], on: e.target.checked } })}
        />
        {label}
      </label>
      <span className="mon-alert-limit">
        más de
        <input
          className="input mon-alert-input"
          type="number"
          min={1}
          max={100}
          value={cfg[key].pct}
          disabled={!cfg.enabled || !cfg[key].on}
          aria-label={`Límite de ${label.toLowerCase()} en %`}
          onChange={(e) => setCfg({ ...cfg, [key]: { ...cfg[key], pct: Math.min(100, Math.max(1, Number(e.target.value) || 1)) } })}
        />
        %{suffix ? ` ${suffix}` : ""}
      </span>
    </div>
  );

  return (
    <Modal
      open
      title={`Alertas de ${serverName}`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save}>
            Guardar
          </button>
        </>
      }
    >
      {active.length > 0 && (
        <div className="mon-alert-active" role="status">
          {active.map((a) => (
            <div key={a.key}>
              <span className="status-dot mon-dot-alert" aria-hidden="true" /> {a.title}
            </div>
          ))}
        </div>
      )}
      <label className="checkbox mon-alert-master">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        Avisar cuando algo pase del límite
      </label>
      <p className="muted mon-alert-help">
        Con las alertas activas, el monitor sigue revisando este servidor cada 30 s aunque no tengas la pestaña a la
        vista. Avisa una vez por episodio, hasta que el valor vuelva a bajar.
      </p>
      {pctRow("disk", "Disco")}
      {pctRow("mem", "Memoria")}
      {pctRow("cpu", "CPU", "durante 1 min")}
      <div className="mon-alert-row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={cfg.load.on}
            disabled={!cfg.enabled}
            onChange={(e) => setCfg({ ...cfg, load: { on: e.target.checked } })}
          />
          Carga (5 min) mayor que el número de CPU
        </label>
      </div>
    </Modal>
  );
}
