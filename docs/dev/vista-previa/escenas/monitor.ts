// Pestaña «Monitor» de lab-docker con 5 minutos de historia y una alerta de disco activa.
// La historia anterior se siembra en el store con las mismas curvas que usan las salidas simuladas.
import { click, connect, el, sessionTab, sleep } from "../ayuda";
import { useTabs } from "../../../../src/stores/tabs";
import { DEFAULT_ALERTS, saveAlerts, useMonitorStore, type HistoryPoint } from "../../../../src/features/monitor";
import { modelo } from "../salidas/monitor";

export const escenas: Record<string, () => Promise<void>> = {
  monitor: async () => {
    saveAlerts("s-lab", { ...DEFAULT_ALERTS, enabled: true });
    await connect("lab-docker");
    const sid = useTabs.getState().tabs.find((t) => t.title === "lab-docker")?.sessionId;
    if (sid) {
      const now = Date.now();
      const history: HistoryPoint[] = [];
      for (let t = now - 296_000; t < now; t += 2000) {
        history.push({ t, cpu: modelo.cpu(t), mem: modelo.mem(t), rx: modelo.rx(t), tx: modelo.tx(t), load: modelo.load(t) });
      }
      useMonitorStore.getState().patch(sid, { history });
    }
    await click(el(".tabs-side-btn"));
    await sessionTab("Monitor");
    await el(".mon-cards", 10000);
    // Unas cuantas muestras reales (cada 2 s) y la lectura de contenedores.
    await sleep(5500);
  },
};
