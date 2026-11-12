// Insignia de privilegios en la pestaña de conexión (root / sudo). Se suscribe solo a su sesión.
import { memo } from "react";
import { privilegeDescription, usePrivilege } from "../../features/privileges";

export const PrivilegeBadge = memo(function PrivilegeBadge({ sessionId }: { sessionId: string }) {
  const info = usePrivilege(sessionId);
  if (!info) return null;
  let text: string;
  let kind: string;
  switch (info.level) {
    case "root":
      [text, kind] = ["root", "root"];
      break;
    case "sudo-nopasswd":
    case "sudo":
      [text, kind] = [info.tool ?? "sudo", "sudo"];
      break;
    case "maybe-sudo":
      [text, kind] = [`${info.tool ?? "sudo"}?`, "maybe"];
      break;
    default:
      return null; // usuario normal o sin datos: nada
  }
  const label = privilegeDescription(info);
  return (
    <span className={`tabs-priv tabs-priv-${kind}`} role="img" aria-label={label} title={label}>
      {text}
    </span>
  );
});
