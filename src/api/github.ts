// Cuenta de GitHub (motor: src-tauri/src/github). Todas las peticiones salen del motor.
import { call } from "./core";
import type { Snippet } from "./types";

export interface GhStatus {
  connected: boolean;
  /** true si esta versión permite iniciar sesión con código (device flow). */
  deviceFlow: boolean;
}

export type GhTokenKind = "classic" | "fine-grained" | "oauth" | "other";

export interface GhAccount {
  login: string;
  name: string | null;
  htmlUrl: string;
  /** data: URL (la interfaz no puede cargar imágenes de internet). */
  avatarData: string | null;
  publicRepos: number;
  privateRepos: number | null;
  tokenKind: GhTokenKind;
  /** Permisos del token clásico; null en tokens de grano fino. */
  scopes: string[] | null;
  tokenExpires: string | null;
  rateLimit: number | null;
  rateRemaining: number | null;
}

export interface GhDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GhDevicePoll {
  status: "pending" | "slowDown" | "expired" | "denied" | "done";
  account: GhAccount | null;
}

export interface GhSshKey {
  id: number;
  key: string;
  title: string | null;
  createdAt: string | null;
}

export interface LocalPubKey {
  path: string;
  line: string;
  keyType: string;
  comment: string;
}

export interface GhRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  defaultBranch: string;
  sshUrl: string;
  cloneUrl: string;
  htmlUrl: string;
  description: string | null;
  pushedAt: string | null;
}

export interface GhDeployKey {
  id: number;
  title: string | null;
  readOnly: boolean;
}

export interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  htmlUrl: string;
}

export interface GhRun {
  id: number;
  name: string | null;
  displayTitle: string | null;
  workflowId: number;
  runNumber: number;
  status: string | null;
  conclusion: string | null;
  headBranch: string | null;
  event: string | null;
  htmlUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeployRecipe {
  /** "" al crear */
  id: string;
  name: string;
  serverId: string;
  projectId: string | null;
  /** "dueño/repo" */
  repo: string | null;
  path: string;
  branch: string;
  /** Uno por línea */
  commands: string;
  deployKey: string | null;
  lastRunAt: number | null;
  lastOk: boolean | null;
}

export interface GhConfig {
  recipes: DeployRecipe[];
  syncGistId: string | null;
  syncUpdatedAt: string | null;
}

export interface GhGistInfo {
  id: string;
  htmlUrl: string;
  description: string | null;
  updatedAt: string | null;
  public: boolean;
  files: string[];
}

export interface GhSyncPulled {
  gist: GhGistInfo;
  payload: unknown;
}

export const github = {
  status: () => call<GhStatus>("gh_status"),
  /** Comprueba el token y lo guarda en el llavero. */
  connect: (token: string) => call<GhAccount>("gh_connect", { token }),
  disconnect: () => call<void>("gh_disconnect"),
  account: () => call<GhAccount>("gh_account"),
  deviceStart: () => call<GhDeviceCode>("gh_device_start"),
  devicePoll: (deviceCode: string) => call<GhDevicePoll>("gh_device_poll", { deviceCode }),

  myKeys: () => call<GhSshKey[]>("gh_my_keys"),
  userKeys: (login: string) => call<GhSshKey[]>("gh_user_keys", { login }),
  addKey: (title: string, key: string) => call<GhSshKey>("gh_add_key", { title, key }),
  localPubkeys: () => call<LocalPubKey[]>("gh_local_pubkeys"),
  /** Solo lee archivos .pub */
  readPubkey: (path: string) => call<LocalPubKey>("gh_read_pubkey", { path }),

  repos: () => call<GhRepo[]>("gh_repos"),
  branches: (owner: string, repo: string) => call<string[]>("gh_branches", { owner, repo }),
  /** Llave de despliegue de solo lectura. */
  addDeployKey: (owner: string, repo: string, title: string, key: string) =>
    call<GhDeployKey>("gh_add_deploy_key", { owner, repo, title, key }),

  workflows: (owner: string, repo: string) => call<GhWorkflow[]>("gh_workflows", { owner, repo }),
  runs: (owner: string, repo: string, limit = 20) => call<GhRun[]>("gh_runs", { owner, repo, limit }),
  dispatch: (owner: string, repo: string, workflowId: number, gitRef: string, inputs?: Record<string, string>) =>
    call<void>("gh_dispatch", { owner, repo, workflowId, gitRef, inputs: inputs ?? null }),

  configLoad: () => call<GhConfig>("gh_config_load"),
  recipeSave: (recipe: DeployRecipe) => call<DeployRecipe>("gh_recipe_save", { recipe }),
  recipeDelete: (id: string) => call<void>("gh_recipe_delete", { id }),
  recipeMark: (id: string, ok: boolean) => call<void>("gh_recipe_mark", { id, ok }),

  syncFind: () => call<GhGistInfo[]>("gh_sync_find"),
  syncPush: (payload: unknown, passphrase: string, gistId?: string | null) =>
    call<GhGistInfo>("gh_sync_push", { payload, passphrase, gistId: gistId ?? null }),
  syncPull: (passphrase: string, gistId?: string | null) =>
    call<GhSyncPulled>("gh_sync_pull", { passphrase, gistId: gistId ?? null }),

  /** Vista previa de una colección de comandos (gist, …/blob/… o raw). No guarda nada. */
  fetchSnippets: (source: string) => call<Snippet[]>("gh_fetch_snippets", { source }),
  shareSnippets: (snippets: Snippet[], description: string, isPublic: boolean) =>
    call<GhGistInfo>("gh_share_snippets", { snippets, description, public: isPublic }),
};
