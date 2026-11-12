// Ventana global de GitHub: Cuenta / Llaves / Repositorios / Despliegues / Actions / Sincronizar.
import { useEffect, useRef, type ComponentType } from "react";
import { CloudCog, FolderGit2, KeyRound, PlayCircle, Rocket, UserRound, X } from "lucide-react";
import { useGitHub, type GhSection } from "../../features/github/store";
import { AccountSection } from "./AccountSection";
import { KeysSection } from "./KeysSection";
import { ReposSection } from "./ReposSection";
import { DeploySection } from "./DeploySection";
import { ActionsSection } from "./ActionsSection";
import { SyncSection } from "./SyncSection";
import "./GitHub.css";

const SECTIONS: { id: GhSection; label: string; icon: ComponentType<{ size?: number }>; view: ComponentType }[] = [
  { id: "account", label: "Cuenta", icon: UserRound, view: AccountSection },
  { id: "keys", label: "Llaves SSH", icon: KeyRound, view: KeysSection },
  { id: "repos", label: "Repositorios", icon: FolderGit2, view: ReposSection },
  { id: "deploy", label: "Despliegues", icon: Rocket, view: DeploySection },
  { id: "actions", label: "Actions", icon: PlayCircle, view: ActionsSection },
  { id: "sync", label: "Sincronizar", icon: CloudCog, view: SyncSection },
];

export function GitHubDialog() {
  const section = useGitHub((s) => s.section);
  const setSection = useGitHub((s) => s.setSection);
  const close = useGitHub((s) => s.close);
  const account = useGitHub((s) => s.account);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Si hay otro diálogo encima (confirmación), que lo cierre él.
      if (document.querySelectorAll(".modal").length > 1) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const View = SECTIONS.find((s) => s.id === section)?.view ?? AccountSection;

  return (
    <div className="modal-backdrop gh-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal gh-dialog" role="dialog" aria-modal="true" aria-label="GitHub" tabIndex={-1} ref={ref}>
        <nav className="gh-nav" aria-label="Secciones de GitHub">
          <div className="gh-nav-title">
            GitHub
            {account && <span className="gh-hint">@{account.login}</span>}
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`gh-nav-item ${section === id ? "gh-nav-active" : ""}`}
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="gh-main">
          <button className="icon-btn gh-close" onClick={close} aria-label="Cerrar">
            <X size={16} />
          </button>
          <div className="gh-content">
            <View />
          </div>
        </div>
      </div>
    </div>
  );
}
