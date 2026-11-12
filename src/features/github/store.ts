// Estado global de la ventana de GitHub y de la cuenta conectada.
import { create } from "zustand";
import { github, type GhAccount, type GhRepo } from "../../api/github";
import { isApiError } from "../../api/core";

export type GhSection = "account" | "keys" | "repos" | "deploy" | "actions" | "sync";

interface GhState {
  open: boolean;
  section: GhSection;
  /** Repo elegido en Repositorios (para Actions / receta). */
  repo: GhRepo | null;

  /** null = aún no se sabe. */
  connected: boolean | null;
  deviceFlow: boolean;
  account: GhAccount | null;
  accountError: string | null;
  loadingAccount: boolean;
  repos: GhRepo[] | null;

  show: (section?: GhSection) => void;
  close: () => void;
  setSection: (s: GhSection) => void;
  setRepo: (r: GhRepo | null) => void;
  refresh: () => Promise<void>;
  setAccount: (a: GhAccount) => void;
  disconnect: () => Promise<void>;
  loadRepos: (force?: boolean) => Promise<GhRepo[]>;
}

export const useGitHub = create<GhState>((set, get) => ({
  open: false,
  section: "account",
  repo: null,
  connected: null,
  deviceFlow: false,
  account: null,
  accountError: null,
  loadingAccount: false,
  repos: null,

  show: (section) => {
    set((s) => ({ open: true, section: section ?? s.section }));
    if (get().connected === null || (get().connected && !get().account)) void get().refresh();
  },
  close: () => set({ open: false }),
  setSection: (section) => set({ section }),
  setRepo: (repo) => set({ repo }),

  refresh: async () => {
    set({ loadingAccount: true, accountError: null });
    try {
      const st = await github.status();
      set({ connected: st.connected, deviceFlow: st.deviceFlow });
      if (st.connected) set({ account: await github.account() });
      else set({ account: null });
    } catch (e) {
      // Token caducado o revocado: seguimos "conectados" para que pueda desconectar o reemplazarlo.
      set({ accountError: isApiError(e) || e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loadingAccount: false });
    }
  },

  setAccount: (account) => set({ account, connected: true, accountError: null, repos: null }),

  disconnect: async () => {
    await github.disconnect();
    set({ connected: false, account: null, repos: null, repo: null, accountError: null });
  },

  loadRepos: async (force = false) => {
    const cur = get().repos;
    if (cur && !force) return cur;
    const repos = await github.repos();
    set({ repos });
    return repos;
  },
}));
