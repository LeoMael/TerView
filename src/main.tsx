import { useLayoutEffect, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "./styles/theme.css";
import { parseEditorWindowParams } from "./windows/editorWindowBus";
import { BOOT_MARKS, markBoot } from "./components/Diagnostics/bootMarks";
import { initLock } from "./features/lock/lockStore";
import { LockGate } from "./features/lock/LockGate";
import { forgetAllSudo } from "./features/privileges/sudo";
import { useSettings } from "./stores/settings";
import { initThemeSync } from "./components/Settings/theme";

markBoot(BOOT_MARKS.main);

/** Marca el primer dibujado completo de la interfaz (panel de diagnóstico). */
function FirstRender({ children }: { children: ReactNode }) {
  useLayoutEffect(() => markBoot(BOOT_MARKS.firstRender), []);
  return children;
}

/** «App lista» = ajustes y servidores cargados; luego, sin prisa, buscar actualizaciones. */
async function afterMainLoaded() {
  const { useProfiles } = await import("./stores/profiles");
  const ready = () => useSettings.getState().loaded && useProfiles.getState().loaded;
  await new Promise<void>((resolve) => {
    if (ready()) return resolve();
    const unsubs = [useSettings.subscribe(check), useProfiles.subscribe(check)];
    function check() {
      if (!ready()) return;
      unsubs.forEach((u) => u());
      resolve();
    }
  });
  requestAnimationFrame(() => markBoot(BOOT_MARKS.appReady));
  void import("./features/updater/autoCheck").then((m) => m.startUpdaterAutoCheck());
}

// Sin React.StrictMode: su doble montaje abriría dos veces terminales/conexiones reales.
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// La misma app sirve a las ventanas de editor aparte (index.html?view=editor&…): esas solo cargan el editor,
// sin la interfaz principal ni sus stores globales.
const editorParams = parseEditorWindowParams(window.location.search);
// Bloqueo con PIN: antes que nada, para que su filtro de teclado vaya primero (ver lockStore).
if (editorParams) {
  initLock();
  void import("./windows/EditorWindow").then((m) => m.mountEditorWindow(root, editorParams));
} else {
  // Al bloquear se olvidan las contraseñas de sudo guardadas en memoria.
  initLock({ onLocked: forgetAllSudo });
  // Tema y ajustes ya para la pantalla de bloqueo (la interfaz no se monta hasta desbloquear).
  void useSettings.getState().load();
  initThemeSync();
  void import("./App").then(({ default: App }) => {
    root.render(
      <LockGate main>
        <FirstRender>
          <App />
        </FirstRender>
      </LockGate>,
    );
    void afterMainLoaded();
  });
}
