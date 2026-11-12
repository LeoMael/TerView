// Procesos que más consumen, con «Terminar» (TERM y, si sigue, ofrecer KILL).
import { useMemo, useState } from "react";
import { ArrowDown, Lock, X } from "lucide-react";
import { confirmDialog } from "../ui/dialogs";
import { toast } from "../../stores/toasts";
import { errorMessage } from "../../api/core";
import { formatBytes } from "../../lib/format";
import { killProcess, TOP_PROCS, type ProcRow } from "../../features/monitor";
import type { PrivilegeLevel } from "../../features/privileges";
import { fmtPct, fmtUptime } from "./format";

interface ProcessTableProps {
  sessionId: string;
  procs: ProcRow[];
  procCount: number;
  sort: "cpu" | "mem";
  onSort: (s: "cpu" | "mem") => void;
  /** uid del usuario conectado (null si aún no se sabe). */
  myUid: number | null;
  myUser: string | null;
  privilege: PrivilegeLevel | null;
  disabled: boolean;
}

export function ProcessTable({ sessionId, procs, procCount, sort, onSort, myUid, myUser, privilege, disabled }: ProcessTableProps) {
  const [busy, setBusy] = useState<number | null>(null);
  const rows = useMemo(() => {
    const r = [...procs];
    if (sort === "cpu") r.sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || (b.rssKb ?? 0) - (a.rssKb ?? 0));
    else r.sort((a, b) => (b.rssKb ?? -1) - (a.rssKb ?? -1));
    return r.slice(0, TOP_PROCS);
  }, [procs, sort]);

  const canSudo = privilege === "sudo" || privilege === "sudo-nopasswd" || privilege === "maybe-sudo";
  const needsRoot = (p: ProcRow) => myUid !== null && myUid !== 0 && p.uid !== null && p.uid !== myUid;
  const rootHint = (p: ProcRow) =>
    `Proceso de «${p.user ?? p.uid}». Para terminarlo hace falta root${canSudo ? ` (desde la terminal: sudo kill ${p.pid})` : " o sudo"}.`;

  const terminate = async (p: ProcRow) => {
    const ok = await confirmDialog({
      title: `¿Terminar «${p.comm}»?`,
      message: (
        <>
          Se enviará la señal TERM al proceso <strong>{p.pid}</strong>
          {p.user ? <> de {p.user}</> : null}. El programa puede cerrarse de forma ordenada.
        </>
      ),
      confirmText: "Terminar",
      danger: true,
    });
    if (!ok) return;
    setBusy(p.pid);
    try {
      let r = await killProcess(sessionId, p.pid, false);
      if (r.permission) {
        toast.error(`No se pudo terminar «${p.comm}»`, "Permiso denegado: hace falta root o sudo");
        return;
      }
      if (!r.ok) {
        toast.error(`No se pudo terminar «${p.comm}»`, r.message || "El proceso ya no existe");
        return;
      }
      if (r.alive) {
        const force = await confirmDialog({
          title: `«${p.comm}» sigue en marcha`,
          message: "No respondió a TERM. ¿Forzar el cierre con kill -9? El proceso termina al instante y sin guardar nada.",
          confirmText: "Forzar (kill -9)",
          danger: true,
        });
        if (!force) return;
        r = await killProcess(sessionId, p.pid, true);
        if (!r.ok || r.alive) {
          toast.error(`No se pudo terminar «${p.comm}»`, r.permission ? "Permiso denegado" : r.message || "Sigue en marcha");
          return;
        }
      }
      toast.success(`Proceso «${p.comm}» terminado`);
    } catch (e) {
      toast.error(`No se pudo terminar «${p.comm}»`, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const th = (key: "cpu" | "mem", label: string) => (
    <th aria-sort={sort === key ? "descending" : "none"} className="mon-num">
      <button className={sort === key ? "mon-sort active" : "mon-sort"} onClick={() => onSort(key)} title={`Ordenar por ${label}`}>
        {label}
        {sort === key && <ArrowDown size={11} aria-hidden="true" />}
      </button>
    </th>
  );

  return (
    <div className="mon-table-wrap">
      <table className="mon-table" aria-label={`Procesos que más ${sort === "cpu" ? "CPU" : "memoria"} usan`}>
        <thead>
          <tr>
            <th className="mon-num">PID</th>
            <th>Usuario</th>
            <th className="mon-name">Nombre</th>
            {th("cpu", "CPU")}
            {th("mem", "Memoria")}
            <th className="mon-num">RSS</th>
            <th className="mon-num">Tiempo</th>
            <th aria-label="Acciones" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const locked = needsRoot(p);
            const mine = myUser !== null && p.user === myUser;
            return (
              <tr key={p.pid}>
                <td className="mon-num mono">{p.pid}</td>
                <td className={mine ? "mon-user" : "mon-user muted"} title={p.user ?? undefined}>
                  {p.user ?? "…"}
                </td>
                <td className="mon-name" title={p.comm}>
                  {p.comm}
                  {p.state === "Z" && <span className="mon-tag">zombi</span>}
                </td>
                <td className="mon-num mono">{p.cpuPct === null ? "—" : fmtPct(p.cpuPct)}</td>
                <td className="mon-num mono">{p.memPct === null ? "—" : fmtPct(p.memPct)}</td>
                <td className="mon-num mono">{p.rssKb === null ? "—" : formatBytes(p.rssKb * 1024)}</td>
                <td className="mon-num mono">{p.elapsed === null ? "—" : fmtUptime(p.elapsed, true)}</td>
                <td className="mon-actions">
                  {locked ? (
                    <span className="mon-lock" title={rootHint(p)} aria-label={rootHint(p)} tabIndex={0}>
                      <Lock size={12} />
                    </span>
                  ) : (
                    <button
                      className="btn btn-sm mon-kill"
                      disabled={disabled || busy !== null || p.pid <= 1}
                      onClick={() => void terminate(p)}
                      title={`Terminar ${p.comm} (PID ${p.pid})`}
                      aria-label={`Terminar ${p.comm}, PID ${p.pid}`}
                    >
                      {busy === p.pid ? <span className="spinner" /> : <X size={12} />}
                      Terminar
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={8} className="muted mon-empty-row">
                Sin datos de procesos
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="mon-foot faint">
        {procCount} procesos · CPU en % de un núcleo, como en top (puede pasar de 100 %)
      </div>
    </div>
  );
}
