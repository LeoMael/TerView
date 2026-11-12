// Arranque de la vista previa: motor simulado → app real (src/main.tsx) → escena pedida en la URL.
import { installMotor } from "./motor";

declare global {
  interface Window {
    /** La escena terminó de prepararse: ya se puede capturar. */
    __listo?: boolean;
    /** Error de la escena (si falló). */
    __errorEscena?: string;
    /** Zona a recortar en la captura (selector CSS); sin ella, ventana entera. */
    __recorte?: string | string[] | null;
  }
}

try {
  localStorage.clear();
  localStorage.setItem("terview.recentServers", JSON.stringify(["s-web", "s-db", "s-api"]));
  // La vista previa no debe mostrar el aviso de novedades salvo en su propia escena.
  localStorage.setItem("terview.lastSeenVersion", "0.5.0");
} catch {
  /* sin almacenamiento */
}

installMotor();
await import("../../../src/main.tsx");

const escena = new URLSearchParams(location.search).get("escena");
if (escena) {
  const { runEscena } = await import("./escenas");
  runEscena(escena).then(
    () => {
      window.__listo = true;
    },
    (e: unknown) => {
      window.__errorEscena = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
      window.__listo = true;
    },
  );
}
