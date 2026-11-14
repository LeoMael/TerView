// Choques entre los alias que SSHorus escribe en ~/.ssh/config y los `Host` escritos a mano.
//   if (!(await checkSshAliasesBeforeExport())) return;   // antes de profiles.exportSshConfig()
//   <SshAliasMatches matches={…} />                       // lista compacta de coincidencias
import { useState } from "react";
import { sshAliases, type SshAliasConflict, type SshHostMatch } from "../api/profiles";
import { confirmDialog } from "../components/ui/dialogs";
import { toast } from "../stores/toasts";
import { SSH_CONFIG_LABEL } from "../lib/platform";
import "./sshAliases.css";

/** Explica una coincidencia en una frase corta. */
export function describeMatch(m: SshHostMatch): string {
  const where = `${m.file}:${m.line}`;
  const what =
    m.kind === "exact"
      ? "ya tiene un Host con ese nombre"
      : m.kind === "pattern"
        ? `lo captura el patrón «${m.pattern}»`
        : `lo captura un Match («${m.pattern}»)${m.conditional ? " según otras condiciones" : ""}`;
  const effect = m.beforeSshorus
    ? "ssh usará esos valores en lugar de los de SSHorus"
    : "sus opciones se mezclarán con las de SSHorus";
  return `${where} ${what}: ${effect}.`;
}

export function SshAliasMatches({ matches }: { matches: SshHostMatch[] }) {
  return (
    <ul className="ssha-matches">
      {matches.map((m) => (
        <li key={`${m.file}:${m.line}`} title={describeMatch(m)}>
          <span className="mono ssha-line">{m.text}</span>
          <span className="faint ssha-where">
            {m.file}:{m.line}
            {m.beforeSshorus ? " · gana sobre SSHorus" : ""}
            {m.conditional ? " · condicional" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConflictChoices({ conflicts, chosen }: { conflicts: SshAliasConflict[]; chosen: Set<string> }) {
  const [, force] = useState(0);
  const toggle = (id: string, on: boolean) => {
    if (on) chosen.add(id);
    else chosen.delete(id);
    force((n) => n + 1);
  };
  return (
    <div className="ssha-dialog">
      <p className="ssha-intro">
        {conflicts.length === 1 ? "Un servidor usa" : `${conflicts.length} servidores usan`} un alias que ya aparece en
        lo que escribiste a mano en {SSH_CONFIG_LABEL}. Puedes usar un alias alternativo o mantenerlo.
      </p>
      <div className="ssha-list">
        {conflicts.map((c) => (
          <div key={c.serverId} className="ssha-item">
            <div className="ssha-head">
              <span className="ssha-name">{c.serverName}</span>
              <span className="mono ssha-alias">{c.alias}</span>
            </div>
            <SshAliasMatches matches={c.matches} />
            <div className="ssha-opts" role="radiogroup" aria-label={`Alias de ${c.serverName}`}>
              <label className="checkbox ssha-radio">
                <input type="radio" checked={chosen.has(c.serverId)} onChange={() => toggle(c.serverId, true)} />
                Usar <span className="mono">{c.suggestion}</span>
              </label>
              <label className="checkbox ssha-radio">
                <input type="radio" checked={!chosen.has(c.serverId)} onChange={() => toggle(c.serverId, false)} />
                Mantener <span className="mono">{c.alias}</span>
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Antes de exportar a ~/.ssh/config: si algún alias choca con un `Host` escrito a mano, lo muestra y
 * propone `<alias>-tv` (o mantenerlo). Guarda la elección. Devuelve false si el usuario cancela.
 * Si no se pueden comprobar los choques, no bloquea la exportación.
 */
export async function checkSshAliasesBeforeExport(): Promise<boolean> {
  let conflicts: SshAliasConflict[];
  try {
    conflicts = await sshAliases.conflicts();
  } catch {
    return true;
  }
  if (conflicts.length === 0) return true;
  // Por defecto: alias alternativo, salvo los que el usuario ya eligió a mano.
  const chosen = new Set(conflicts.filter((c) => !c.custom).map((c) => c.serverId));
  const ok = await confirmDialog({
    title: `Alias repetidos en ${SSH_CONFIG_LABEL}`,
    message: <ConflictChoices conflicts={conflicts} chosen={chosen} />,
    confirmText: "Exportar",
  });
  if (!ok) return false;
  const changes: Record<string, string> = {};
  for (const c of conflicts) if (chosen.has(c.serverId)) changes[c.serverId] = c.suggestion;
  if (Object.keys(changes).length === 0) return true;
  try {
    await sshAliases.set(changes);
  } catch (e) {
    toast.error("No se pudieron guardar los alias", e);
    return false;
  }
  return true;
}
