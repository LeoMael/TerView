// Piezas compartidas de la sub-pestaña «Vulnerabilidades»: etiquetas, enlaces y acciones de texto.
import { ClipboardCopy, TerminalSquare } from "lucide-react";
import type { Finding, Report, Severity, SourceId } from "../../api/vulnscan";
import type { SudoTool } from "../../features/vulnscan";
import type { Elevation, PrivilegeInfo } from "../../features/privileges";
import { clipboard } from "../../lib/clipboard";
import { hasTerminal, sendToTerminal } from "../../stores/terminalBus";
import { toast } from "../../stores/toasts";

export const SEV_LABEL: Record<Severity, string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Media",
  low: "Baja",
  unknown: "Sin clasificar",
};

export const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "unknown"];

export const SOURCE_LABEL: Record<SourceId, string> = { osv: "OSV", distro: "Distro", trivy: "Trivy" };

export function SevTag({ s }: { s: Severity }) {
  return <span className={`vs-sev vs-sev-${s}`}>{SEV_LABEL[s]}</span>;
}

/** Nombre corto del origen de un hallazgo. */
export function originLabel(report: Report, key: string): string {
  const t = report.targets.find((x) => x.key === key);
  if (!t) return key;
  if (t.kind === "system") return "Sistema";
  if (t.kind === "runtime") return "Programa suelto";
  const name = t.image?.tags[0] ?? t.image?.id ?? "imagen";
  return t.user ? `${name} · ${t.user}` : name;
}

/** Cómo se eleva en el servidor (para el comando sugerido). */
export function sudoToolOf(info: PrivilegeInfo | null, el: Elevation | null): SudoTool {
  if (info?.level === "root") return "";
  if (el?.kind === "nopasswd") return el.tool === "doas" ? "doas" : "sudo";
  if (info && info.hasDoas && !info.hasSudo) return "doas";
  return "sudo";
}

/** Enlaces útiles de un hallazgo: tracker de la distro, NVD, OSV y el aviso. */
export function findingLinks(report: Report, f: Finding): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const cve = /^CVE-\d{4}-\d+$/.test(f.id) ? f.id : null;
  const os = report.host.os;
  const like = (x: string) => os.id === x || os.idLike.includes(x);
  const target = report.targets.find((t) => t.key === f.target);
  if (cve && target?.kind !== "image") {
    if (os.id === "debian") out.push({ label: "Debian", url: `https://security-tracker.debian.org/tracker/${cve}` });
    else if (os.id === "ubuntu") out.push({ label: "Ubuntu", url: `https://ubuntu.com/security/${cve}` });
    else if (os.id === "alpine") out.push({ label: "Alpine", url: `https://security.alpinelinux.org/vuln/${cve}` });
    else if (like("suse") || os.id.startsWith("opensuse")) out.push({ label: "SUSE", url: `https://www.suse.com/security/cve/${cve}.html` });
    else if (like("rhel") || like("fedora") || like("centos")) out.push({ label: "Red Hat", url: `https://access.redhat.com/security/cve/${cve}` });
  }
  if (cve) out.push({ label: "NVD", url: `https://nvd.nist.gov/vuln/detail/${cve}` });
  for (const a of f.advisories) {
    if (a.startsWith("FEDORA-")) out.push({ label: a, url: `https://bodhi.fedoraproject.org/updates/${a}` });
    else if (/^(DSA|DLA)-/.test(a)) out.push({ label: a, url: `https://security-tracker.debian.org/tracker/${a.replace(/-\d+$/, "")}` });
    else if (a.startsWith("USN-")) out.push({ label: a, url: `https://ubuntu.com/security/notices/${a}` });
    else if (/^(RLSA|ALSA|RHSA)-/.test(a)) out.push({ label: a, url: `https://osv.dev/vulnerability/${a}` });
  }
  out.push({ label: "OSV", url: `https://osv.dev/vulnerability/${encodeURIComponent(f.id)}` });
  return out.filter((l, i) => out.findIndex((x) => x.url === l.url) === i);
}

export function copyText(text: string, what = "Copiado") {
  clipboard.write(text).then(
    () => toast.success(what),
    (e) => toast.error("No se pudo copiar", e),
  );
}

/** Escribe en la terminal de la sesión SIN Enter (nunca se ejecuta solo). */
export function insertInTerminal(sessionId: string, text: string) {
  if (sendToTerminal(sessionId, text, false)) toast.info("Escrito en la terminal", "Revísalo y pulsa Enter si quieres ejecutarlo.");
  else toast.error("No hay ninguna terminal abierta en esta conexión");
}

/** Botones Copiar / Insertar en terminal para un comando. */
export function CommandActions({ sessionId, text }: { sessionId: string; text: string }) {
  return (
    <>
      <button className="btn btn-sm" onClick={() => copyText(text, "Comando copiado")}>
        <ClipboardCopy size={12} /> Copiar
      </button>
      <button
        className="btn btn-sm"
        onClick={() => insertInTerminal(sessionId, text)}
        disabled={!hasTerminal(sessionId)}
        title={hasTerminal(sessionId) ? "Se escribe en la terminal sin pulsar Enter" : "Abre una terminal en esta conexión"}
      >
        <TerminalSquare size={12} /> Insertar en terminal
      </button>
    </>
  );
}
