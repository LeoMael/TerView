// Diálogo "Ya existe «x»": responde, de una en una, las preguntas de conflicto del motor
// (política "Preguntar" en Ajustes → Transferencias). DUEÑO: agente Transferencias.
import { useCallback, useEffect, useState } from "react";
import { transfers, type ConflictAnswer, type TransferConflict } from "../../api/transfers";
import { formatBytes, formatDate } from "../../lib/format";
import { dropConflicts, formatCount, useTransferConflicts } from "../../stores/transfers";
import { toast } from "../../stores/toasts";
import { Modal } from "../ui/Modal";

function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i < 0 ? t : t.slice(i + 1);
}

function sizeText(n: number | null, isLink: boolean): string {
  if (isLink) return "Enlace simbólico";
  return n === null ? "Tamaño desconocido" : formatBytes(n);
}

export function ConflictDialog() {
  const queue = useTransferConflicts((s) => s.queue);
  const q: TransferConflict | undefined = queue[0];
  const [applyAll, setApplyAll] = useState(false);
  const [busy, setBusy] = useState(false);

  // Cada pregunta nueva empieza con la casilla sin marcar.
  const jobId = q?.jobId;
  useEffect(() => {
    setApplyAll(false);
    setBusy(false);
  }, [jobId]);

  const answer = useCallback(
    (a: ConflictAnswer) => {
      if (!q || busy) return;
      setBusy(true);
      transfers
        .resolveConflict(q.jobId, a, applyAll)
        .then(() => dropConflicts([q.jobId]))
        .catch((e) => {
          toast.error("No se pudo responder", e);
          setBusy(false);
        });
    },
    [q, applyAll, busy],
  );

  const cancelBatch = useCallback(() => {
    if (!q || busy) return;
    setBusy(true);
    transfers.cancel([q.batchId]).catch((e) => {
      toast.error("No se pudo cancelar", e);
      setBusy(false);
    });
  }, [q, busy]);

  if (!q) return null;

  const up = q.direction === "upload";
  const name = baseName(q.destination) || q.name;
  const sameBatch = queue.filter((x) => x.batchId === q.batchId).length - 1;
  const where = up ? "en el servidor" : "en este equipo";
  const srcNewer = q.sourceMtime !== null && q.destMtime !== null ? q.sourceMtime > q.destMtime : null;
  const more = queue.length - 1;

  return (
    <Modal open title={`Ya existe «${name}»`} onClose={() => answer("skip")} width={520}>
      <p className="dialog-message tp-cf-msg">
        {up ? "Al subir" : "Al descargar"} <b className="tp-cf-name">{q.name}</b>, el destino ya existe {where}.
      </p>
      <div className="tp-cf-grid" role="table" aria-label="Comparación de archivos">
        <div className="tp-cf-row" role="row">
          <span className="tp-cf-label" role="rowheader">
            {up ? "Nuevo (este equipo)" : "Nuevo (servidor)"}
          </span>
          <span role="cell">{sizeText(q.sourceSize, q.isLink)}</span>
          <span role="cell" className={srcNewer === true ? "tp-cf-newer" : undefined}>
            {formatDate(q.sourceMtime)}
            {srcNewer === true && " · más reciente"}
          </span>
        </div>
        <div className="tp-cf-row" role="row">
          <span className="tp-cf-label" role="rowheader">
            {up ? "Existente (servidor)" : "Existente (este equipo)"}
          </span>
          <span role="cell">{sizeText(q.destSize, false)}</span>
          <span role="cell" className={srcNewer === false ? "tp-cf-newer" : undefined}>
            {formatDate(q.destMtime)}
            {srcNewer === false && " · más reciente"}
          </span>
        </div>
        <div className="tp-cf-path faint" title={q.destination}>
          {q.destination}
        </div>
      </div>
      <label className="checkbox tp-cf-all">
        <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
        <span>
          Aplicar a todos los conflictos de esta transferencia
          {sameBatch > 0 && <span className="faint"> ({formatCount(sameBatch)} más esperando)</span>}
        </span>
      </label>
      <div className="tp-cf-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => answer("overwrite")} autoFocus>
          Sobrescribir
        </button>
        <button className="btn" disabled={busy} onClick={() => answer("skip")}>
          Omitir
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => answer("rename")}
          title="Transfiere con otro nombre, p. ej. «nombre (2).ext»"
        >
          Mantener ambos
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => answer("newer")}
          title="Solo se reemplaza si el origen es más reciente que el destino"
        >
          Solo si es más nuevo
        </button>
      </div>
      <div className="tp-cf-foot">
        <button className="btn btn-sm tp-cf-cancel" disabled={busy} onClick={cancelBatch}>
          Cancelar esta transferencia
        </button>
        {more > 0 && <span className="faint">{formatCount(more)} preguntas más en espera</span>}
      </div>
    </Modal>
  );
}
