import { call } from "./core";
import type { Project, ProfilesData, ServerProfile, Settings, SshConfigExport } from "./types";

export const profiles = {
  load: () => call<ProfilesData>("profiles_load"),
  /** secret: contraseña o frase de la llave; undefined = no tocar. */
  saveServer: (server: ServerProfile, secret?: string) =>
    call<ServerProfile>("profiles_save_server", { server, secret: secret ?? null }),
  deleteServer: (id: string) => call<void>("profiles_delete_server", { id }),
  saveProject: (project: Project) => call<Project>("profiles_save_project", { project }),
  deleteProject: (id: string) => call<void>("profiles_delete_project", { id }),
  hasSecret: (id: string) => call<boolean>("profiles_has_secret", { id }),
  /** null = borrar */
  setSecret: (id: string, secret: string | null) => call<void>("profiles_set_secret", { id, secret }),
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
