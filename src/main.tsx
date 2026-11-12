import { useLayoutEffect, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "./styles/theme.css";
import { parseEditorWindowParams } from "./windows/editorWindowBus";
import { BOOT_MARKS, markBoot } from "./components/Diagnostics/bootMarks";

markBoot(BOOT_MARKS.main);

/** Marca el primer dibujado completo de la interfaz (panel de diagnóstico). */
function FirstRender({ children }: { children: ReactNode }) {
  useLayoutEffect(() => markBoot(BOOT_MARKS.firstRender), []);
  return children;
}

/** «App lista» = ajustes y servidores cargados; luego, sin prisa, buscar actualizaciones. */
async function afterMainLoaded() {
  const [{ useSettings }, { useProfiles }] = await Promise.all([import("./stores/settings"), import("./stores/profiles")]);
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
if (editorParams) {
  void import("./windows/EditorWindow").then((m) => m.mountEditorWindow(root, editorParams));
} else {
  void import("./App").then(({ default: App }) => {
    root.render(
      <FirstRender>
        <App />
      </FirstRender>,
    );
    void afterMainLoaded();
  });
}
