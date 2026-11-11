// Pantalla de bienvenida cuando no hay conexiones abiertas.
import { useMemo, useState } from "react";
import { Command, FileCode2, Keyboard, MousePointerClick, Plus, Search, Server, Settings, TerminalSquare, Upload } from "lucide-react";
import { useProfiles } from "../../stores/profiles";
import { useUi } from "../../stores/ui";
import { connectToServer } from "../../features/connect";
import type { ServerProfile } from "../../api/types";
import { Logo } from "../ui/Logo";
import "./Welcome.css";

const RECENT_KEY = "terview.recentServers";

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Anota un servidor como usado recientemente (solo comodidad local). */
export function recordRecentServer(profileId: string) {
  try {
    const list = [profileId, ...readRecent().filter((id) => id !== profileId)].slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Fondo suave del color del servidor (16 %). Con "#rrggbb" se evita color-mix (más barato en WebKitGTK). */
function tint16(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}29` : `color-mix(in srgb, ${color} 16%, transparent)`;
}

export function Welcome() {
  const servers = useProfiles((s) => s.servers);
  const loaded = useProfiles((s) => s.loaded);
  const openServerEditor = useUi((s) => s.openServerEditor);
  const openSettings = useUi((s) => s.openSettings);
  const [busy, setBusy] = useState<string | null>(null);

  const { recent, rest } = useMemo(() => {
    const order = readRecent();
    const byId = new Map(servers.map((s) => [s.id, s]));
    const recent = order.map((id) => byId.get(id)).filter((s): s is ServerProfile => !!s).slice(0, 6);
    const recentIds = new Set(recent.map((s) => s.id));
    const rest = servers.filter((s) => !recentIds.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "es"));
    return { recent, rest };
  }, [servers]);

  const connect = async (p: ServerProfile) => {
    if (busy) return;
    setBusy(p.id);
    try {
      await connectToServer(p, { initialPath: p.defaultPath });
    } finally {
      setBusy(null);
    }
  };

  const card = (p: ServerProfile) => (
    <button key={p.id} className="wl-server" onClick={() => void connect(p)} disabled={busy !== null} title={`Conectar a ${p.name}`}>
      <span className="wl-server-icon" style={p.color ? { color: p.color, background: tint16(p.color) } : undefined}>
        {busy === p.id ? <span className="spinner" /> : <Server size={16} />}
      </span>
      <span className="wl-server-text">
        <span className="wl-server-name">{p.name}</span>
        <span className="wl-server-host mono">
          {p.username}@{p.host}
          {p.port !== 22 ? `:${p.port}` : ""}
        </span>
      </span>
    </button>
  );

  return (
    <div className="wl-root">
      <div className="wl-inner">
        <div className="wl-hero">
          <h1 className="wl-title">
            <Logo size={56} withName />
          </h1>
          <p className="wl-sub">Conéctate a tus servidores, maneja sus archivos y abre terminales, todo en una ventana.</p>
        </div>

        <div className="wl-actions">
          <button className="btn btn-primary" onClick={() => openServerEditor()}>
            <Plus size={15} /> Nuevo servidor
          </button>
          <button className="btn" onClick={openSettings}>
            <Settings size={15} /> Ajustes
          </button>
        </div>

        {recent.length > 0 && (
          <section className="wl-section">
            <div className="section-label">Recientes</div>
            <div className="wl-grid">{recent.map(card)}</div>
          </section>
        )}
        {rest.length > 0 && (
          <section className="wl-section">
            <div className="section-label">{recent.length > 0 ? "Otros servidores" : "Tus servidores"}</div>
            <div className="wl-grid">{rest.map(card)}</div>
          </section>
        )}
        {loaded && servers.length === 0 && (
          <div className="wl-empty">
            Aún no tienes servidores guardados. Pulsa <strong>Nuevo servidor</strong> para añadir el primero.
          </div>
        )}

        <section className="wl-section">
          <div className="section-label">Consejos</div>
          <ul className="wl-tips">
            <li>
              <MousePointerClick size={15} /> <span>Doble clic en un servidor de la barra lateral para conectar.</span>
            </li>
            <li>
              <Upload size={15} /> <span>Arrastra archivos o carpetas desde tu equipo al explorador para subirlos.</span>
            </li>
            <li>
              <FileCode2 size={15} />
              <span>
                Doble clic en un archivo de texto lo abre en el editor; <kbd>Ctrl</kbd>+<kbd>S</kbd> lo guarda en el servidor.
              </span>
            </li>
            <li>
              <Command size={15} />
              <span>
                <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> abre la paleta de comandos: busca un comando (p. ej. «podman logs») y
                aplícalo en la conexión activa.
              </span>
            </li>
            <li>
              <Search size={15} />
              <span>
                <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> busca en la terminal · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> /{" "}
                <kbd>V</kbd> copia y pega.
              </span>
            </li>
            <li>
              <Keyboard size={15} />
              <span>
                <kbd>Ctrl</kbd>+<kbd>B</kbd> barra lateral · <kbd>Ctrl</kbd>+<kbd>Tab</kbd> cambiar pestaña · <kbd>Ctrl</kbd>+
                <kbd>W</kbd> cerrar · <kbd>Ctrl</kbd>+<kbd>`</kbd> terminal · <kbd>Ctrl</kbd>+<kbd>,</kbd> ajustes
              </span>
            </li>
            <li>
              <TerminalSquare size={15} />
              <span>
                Con el foco en la terminal, <kbd>Ctrl</kbd>+<kbd>W</kbd> y <kbd>Ctrl</kbd>+<kbd>B</kbd> van a la shell (borrar palabra,
                tmux…). Para cerrar la pestaña usa su <strong>×</strong> o haz clic fuera de la terminal.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
