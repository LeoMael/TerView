import { call } from "./core";

/** Secreto de un servidor: el de conexión (contraseña o frase de la llave) o la contraseña de sudo. */
export type SecretKind = "login" | "sudo";
import type { Project, ProfilesData, ServerProfile, Settings, SshConfigExport } from "./types";

export const profiles = {
  load: () => call<ProfilesData>("profiles_load"),
  /** secret: contraseña o frase de la llave; undefined = no tocar. */
  saveServer: (server: ServerProfile, secret?: string) =>
    call<ServerProfile>("profiles_save_server", { server, secret: secret ?? null }),
  deleteServer: (id: string) => call<void>("profiles_delete_server", { id }),
  saveProject: (project: Project) => call<Project>("profiles_save_project", { project }),
  deleteProject: (id: string) => call<void>("profiles_delete_project", { id }),
  /** ¿Hay secreto guardado? kind: "login" (conexión, por defecto) o "sudo". */
  hasSecret: (id: string, kind: SecretKind = "login") => call<boolean>("profiles_has_secret", { id, kind }),
  /** null = borrar */
  setSecret: (id: string, secret: string | null, kind: SecretKind = "login") =>
    call<void>("profiles_set_secret", { id, secret, kind }),
  /** Muestra un secreto guardado. Con bóveda hace falta el PIN (cuenta como intento). */
  revealSecret: (id: string, kind: SecretKind, pin?: string) =>
    call<string | null>("profiles_reveal_secret", { id, kind, pin: pin ?? null }),
  /**
   * Contraseña de sudo según el ajuste del servidor (null = «Pedir cada vez» o no hay guardada). Con «La de
   * la conexión» y `sessionId`, primero la que se escribió al conectar esa sesión (aunque no se guardara).
   */
  sudoPassword: (id: string, sessionId?: string) =>
    call<string | null>("profiles_sudo_password", { id, sessionId: sessionId ?? null }),
  /** Copia el servidor (y su secreto guardado). Devuelve la copia. */
  duplicateServer: (id: string) => call<ServerProfile>("profiles_duplicate_server", { id }),
  /** Escribe el bloque de TerView en ~/.ssh/config. */
  exportSshConfig: () => call<SshConfigExport>("profiles_export_ssh_config"),
  /** Lee ~/.ssh/config y devuelve candidatos (sin guardar; id ""). Omite los que ya existen. */
  importSshConfig: () => call<ServerProfile[]>("profiles_import_ssh_config"),
};

export const settingsApi = {
  load: () => call<Settings>("settings_load"),
  save: (settings: Settings) => call<Settings>("settings_save", { settings }),
};

// ───────── Alias de ~/.ssh/config y choques con `Host` escritos a mano ─────────

/** Un `Host`/`Match` escrito a mano (fuera del bloque de TerView o en un `Include`) que captura un alias. */
export interface SshHostMatch {
  /** Archivo (con `~/` si está en la carpeta personal). */
  file: string;
  line: number;
  /** La línea tal cual, p. ej. `Host web *.lan`. */
  text: string;
  /** Patrón que coincide. */
  pattern: string;
  kind: "exact" | "pattern" | "match";
  /** `Match` con más condiciones (`exec`, `user`…): puede que no aplique siempre. */
  conditional: boolean;
  /** Está antes del bloque de TerView: ssh usará SUS valores para ese alias. */
  beforeTerview: boolean;
}

export interface SshAliasConflict {
  serverId: string;
  serverName: string;
  alias: string;
  /** Alias libre propuesto (`<alias>-tv`). */
  suggestion: string;
  /** El alias lo eligió el usuario. */
  custom: boolean;
  matches: SshHostMatch[];
}

export interface SshAliasInfo {
  /** Alias con el que se exportaría. */
  alias: string;
  suggestion: string | null;
  matches: SshHostMatch[];
}

export interface SshImportCandidate {
  server: ServerProfile;
  /** Servidor de TerView con el mismo host, puerto y usuario. */
  existingId: string | null;
  existingName: string | null;
  /** Servidor de TerView que se exporta con este mismo alias. */
  aliasUsedBy: string | null;
}

export const sshAliases = {
  /** Servidores guardados cuyo alias choca con la configuración escrita a mano. */
  conflicts: () => call<SshAliasConflict[]>("ssh_config_conflicts"),
  /** Alias de un servidor en edición (`id` "" = nuevo); `alias` vacío/null = automático. */
  info: (id: string, name: string, host: string, alias: string | null) =>
    call<SshAliasInfo>("ssh_config_alias_info", { id, name, host, alias }),
  /** Alias elegidos a mano (id del servidor → alias). */
  list: () => call<Record<string, string>>("ssh_config_aliases"),
  /** Cambia alias (null o "" = automático). Si «Mantener sincronizado» está activo, vuelve a exportar. */
  set: (aliases: Record<string, string | null>) => call<Record<string, string>>("ssh_config_set_aliases", { aliases }),
  /** Candidatos a importar, incluidos los que ya existen (marcados). */
  importPreview: () => call<SshImportCandidate[]>("ssh_config_import_preview"),
};
