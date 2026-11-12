// Permisos del token de GitHub: enlaces de creación y qué función necesita qué permiso.
import type { GhAccount } from "../../api/github";

/** Permisos clásicos mínimos para todo lo que hace TerView. */
export const CLASSIC_SCOPES = ["read:public_key", "write:public_key", "repo", "gist"] as const;

/** Página de creación de token clásico con los permisos ya marcados. */
export const CLASSIC_TOKEN_URL = `https://github.com/settings/tokens/new?description=TerView&scopes=${CLASSIC_SCOPES.join(",")}`;

/** Página de creación de token de grano fino (GitHub rellena nombre y permisos si los reconoce). */
export const FINE_GRAINED_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?name=TerView&description=TerView" +
  "&contents=read&metadata=read&administration=write&actions=write&gists=write&git_ssh_keys=write";

export const TOKENS_SETTINGS_URL = "https://github.com/settings/tokens";

export interface Capability {
  id: "keysRead" | "keysWrite" | "repos" | "deployKeys" | "actions" | "gists";
  label: string;
  /** Permiso clásico (cualquiera de la lista sirve). */
  classic: string[];
  /** Permiso equivalente en tokens de grano fino. */
  fine: string;
}

export const CAPABILITIES: Capability[] = [
  { id: "keysRead", label: "Ver tus llaves SSH", classic: ["read:public_key", "write:public_key", "admin:public_key"], fine: "Git SSH keys: lectura" },
  { id: "keysWrite", label: "Subir llaves SSH a tu cuenta", classic: ["write:public_key", "admin:public_key"], fine: "Git SSH keys: escritura" },
  { id: "repos", label: "Listar y clonar repos privados", classic: ["repo"], fine: "Contents: lectura (y Metadata)" },
  { id: "deployKeys", label: "Crear llaves de despliegue", classic: ["repo"], fine: "Administration: escritura" },
  { id: "actions", label: "Ver y lanzar GitHub Actions", classic: ["repo", "public_repo"], fine: "Actions: lectura y escritura" },
  { id: "gists", label: "Sincronizar y compartir (gists)", classic: ["gist"], fine: "Gists: escritura" },
];

/** true/false si se sabe (token clásico); null si GitHub no lo informa (grano fino). */
export function hasCapability(acc: GhAccount | null, c: Capability): boolean | null {
  if (!acc || acc.scopes === null) return null;
  return c.classic.some((s) => acc.scopes!.includes(s));
}

export function tokenKindLabel(k: GhAccount["tokenKind"]): string {
  switch (k) {
    case "classic":
      return "Token clásico";
    case "fine-grained":
      return "Token de grano fino";
    case "oauth":
      return "Inicio de sesión OAuth";
    default:
      return "Token";
  }
}
