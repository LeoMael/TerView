// Una escena por sección de Ajustes («ajustes-<sección>»), para revisar el diseño de cada una.
import { openSettingsAt } from "../../../../src/components/Settings/settingsNav";
import { app, crop, el, sleep } from "../ayuda";

type Section = Parameters<typeof openSettingsAt>[0];
const SECTIONS: Section[] = [
  "appearance", "terminal", "editor", "explorer", "shortcuts", "connection", "transfers", "servers", "security",
  "assistants", "localAi", "ai", "advanced", "about",
];

export const escenas: Record<string, () => Promise<void>> = Object.fromEntries(
  SECTIONS.map((s) => [
    `ajustes-${s}`,
    async () => {
      await app();
      openSettingsAt(s);
      await el(".modal");
      await sleep(500);
      crop(".modal");
    },
  ]),
);
