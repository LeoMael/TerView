// Escenas de la Biblioteca de comandos, «Analizar servidor» y «Ejecutar en varios servidores».
import { ssh } from "../../../../src/api/ssh";
import type { ExecResult } from "../../../../src/api/types";
import { openMultiRun, setMultiRunDeps } from "../../../../src/features/multirun/store";
import { app, byText, click, connect, el, sessionTab, sleep } from "../ayuda";

/** Salida de `df -h /` en cada servidor de ./datos.ts (distinta en cada uno). */
const DF_ROOT: Record<string, { out: string; ms: number }> = {
  "s-web": {
    out: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        78G   41G   34G  55% /\n",
    ms: 412,
  },
  "s-db": {
    out: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda2       245G  198G   35G  86% /\n",
    ms: 538,
  },
  "s-api": {
    out: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        39G   12G   25G  33% /\n",
    ms: 367,
  },
  "s-backup": {
    out: "Filesystem                Size  Used Avail Use% Mounted on\n/dev/mapper/vg0-root      1.8T  1.1T  644G  63% /\n",
    ms: 921,
  },
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Motor de varios servidores con salidas por servidor (conexión con el ssh_connect simulado). */
function fakeMultiRunDeps() {
  const bySession = new Map<string, string>();
  setMultiRunDeps({
    tabSession: () => null,
    connect: async (profileId) => {
      const info = await ssh.connect(profileId);
      bySession.set(info.id, profileId);
      await delay(150);
      return info.id;
    },
    connectInteractive: async (profileId) => (await ssh.connect(profileId)).id,
    exec: async (sessionId): Promise<ExecResult> => {
      const r = DF_ROOT[bySession.get(sessionId) ?? ""] ?? { out: "", ms: 300 };
      await delay(r.ms);
      return { stdout: r.out, stderr: "", exitCode: 0, durationMs: r.ms, truncated: false, timedOut: false };
    },
    newExecId: () => `x-${Math.random().toString(36).slice(2)}`,
    cancelExec: async () => false,
    disconnect: async () => {},
    privilege: async () => "sudo-nopasswd",
  });
}

export const escenas: Record<string, () => Promise<void>> = {
  /** Biblioteca de comandos: «Espacio libre» (df -h) con su resultado. */
  comandos: async () => {
    await connect("web-prod");
    await sessionTab("Comandos");
    await el(".cmd-panel");
    await click(byText(/^Discos y archivos\d*$/, ".cmd-cat"));
    await click(byText(/^Espacio libre/, ".cmd-item"));
    await el(".cmd-detail");
    await click(byText(/Ejecutar y ver resultado/, "button"));
    await el(".cmd-result pre, .cmd-result .mono", 6000);
    await sleep(400);
  },

  /** Informe de «Analizar servidor». */
  analizar: async () => {
    await connect("web-prod");
    await sessionTab("Comandos");
    await el(".cmd-panel");
    await click(byText(/Analizar servidor/, "button"));
    await sleep(1200);
  },

  /** Ejecutar `df -h /` en cuatro servidores, con la salida de cada uno. */
  varios: async () => {
    await app();
    fakeMultiRunDeps();
    openMultiRun({ profileIds: ["s-web", "s-db", "s-api", "s-backup"], command: "df -h /" });
    await el(".mr-panel");
    await sleep(300);
    await click(byText(/^Ejecutar en 4 servidores$/, "button"));
    await byText(/Terminado/, ".mr-res-progress span", 10000);
    await click(el(".mr-table thead .mr-c-exp button"));
    await sleep(400);
  },
};
