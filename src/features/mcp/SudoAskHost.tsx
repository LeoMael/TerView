// Diálogo de la contraseña de sudo para un comando del asistente que ya aprobaste (ver sudoAsk.ts).
// Es el mismo SudoDialog de Administración: si la contraseña ya está (en memoria, guardada u otra pestaña)
// se cierra solo; si no, la pide. Se cierra al bloquear TerView o cuando el motor deja de esperar.
import { lazy, Suspense, useEffect } from "react";
import { useLock } from "../lock/lockStore";
import { cancelAllSudoAsks, finishSudoAsk, useSudoAsks } from "./sudoAsk";
import "./Mcp.css";

const SudoDialog = lazy(() => import("../../components/Admin/SudoDialog").then((m) => ({ default: m.SudoDialog })));

export function SudoAskHost() {
  const first = useSudoAsks((s) => s.asks[0]);
  const locked = useLock((s) => !!s.status?.locked);

  useEffect(() => {
    if (locked) cancelAllSudoAsks();
  }, [locked]);

  useEffect(() => {
    if (!first) return;
    const t = window.setTimeout(() => finishSudoAsk(first.id), Math.max(0, first.expiresAt - Date.now()));
    return () => window.clearTimeout(t);
  }, [first]);

  if (!first || locked) return null;
  return (
    <div className="mcp-sudo">
      <Suspense fallback={null}>
        <SudoDialog
          key={first.id}
          sessionId={first.sessionId}
          profileId={first.profileId}
          user={first.user}
          reason={`El asistente quiere ejecutar un comando con sudo en «${first.serverName}» (${first.auto ? "aceptado automáticamente" : "ya le diste permiso"}). TerView le pasa la contraseña a sudo: el asistente no la ve.`}
          onClose={() => finishSudoAsk(first.id)}
        />
      </Suspense>
    </div>
  );
}
