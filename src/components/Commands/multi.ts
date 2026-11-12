// Puente con «Ejecutar en varios servidores» (features/multirun).
import { openMultiRun, useMultiRun } from "../../features/multirun/store";
import type { CommandItem } from "./state";

/** Motivo por el que un comando no se puede lanzar en varios servidores (o null). */
export function multiRunBlockedReason(item: CommandItem): string | null {
  if (item.interactive) return "Es interactivo o no termina: no se puede ejecutar en varios servidores a la vez";
  return null;
}

/**
 * Abre el panel con el comando tal cual (con sus {{variables}} sin resolver: el panel las pide una vez
 * para todos). Si aún no había servidores elegidos, marca el de esta conexión.
 */
export function runOnManyServers(item: CommandItem, profileId?: string) {
  if (multiRunBlockedReason(item)) return;
  const noneSelected = useMultiRun.getState().draft.selected.length === 0;
  openMultiRun({
    command: item.command,
    label: item.name,
    dangerous: item.dangerous,
    ...(profileId && noneSelected ? { profileIds: [profileId] } : {}),
  });
}
