// Comando sugerido para arreglar un hallazgo. Solo texto para copiar o insertar en la terminal (sin
// Enter): TerView nunca lo ejecuta. Funciones puras, sin React ni Tauri.
import type { Finding, Report, Target } from "../../api/vulnscan";

/** Cómo se eleva en el servidor: "sudo", "doas" o "" (ya es root). */
export type SudoTool = "sudo" | "doas" | "";

export interface FixSuggestion {
  /** Comando listo para copiar (null si no hay uno seguro que proponer). */
  command: string | null;
  /** Explicaciones cortas que acompañan al comando. */
  notes: string[];
}

/** Nombre de paquete o referencia de imagen seguros para el shell (sin espacios ni caracteres raros). */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._+:@/~=-]*$/;

function safe(list: string[]): string[] {
  return [...new Set(list.filter((x) => SAFE.test(x)))];
}

function pre(tool: SudoTool): string {
  return tool ? `${tool} ` : "";
}

export function targetOf(report: Report, f: Finding): Target | undefined {
  return report.targets.find((t) => t.key === f.target);
}

/** Familia de la distro del servidor. */
export function distroFamily(report: Report): "rpm-dnf" | "rpm-yum" | "suse" | "apt" | "apk" | "other" {
  const os = report.host.os;
  const like = (x: string) => os.id === x || os.idLike.includes(x);
  if (like("suse") || os.id.startsWith("opensuse") || os.id === "sles") return "suse";
  if (report.host.packageManager === "dpkg" || like("debian") || like("ubuntu")) return "apt";
  if (report.host.packageManager === "apk" || os.id === "alpine") return "apk";
  if (report.host.packageManager === "rpm" || like("rhel") || like("fedora") || like("centos")) {
    // CentOS 7 / Amazon Linux 2 no tienen dnf.
    return report.host.tools.includes("dnf") || report.host.tools.includes("dnf5") ? "rpm-dnf" : "rpm-yum";
  }
  return "other";
}

const RPM_ADVISORY = /^(RLSA|ALSA|RHSA|ELSA|FEDORA|ALBA|RXSA)-/;

/** Nota de reinicio tras actualizar el kernel. */
export function kernelNotes(report: Report): string[] {
  const fam = distroFamily(report);
  const check =
    fam === "apt"
      ? "Para saber si hace falta: ls /var/run/reboot-required"
      : fam === "rpm-dnf" || fam === "rpm-yum"
        ? "Para saber si hace falta: needs-restarting -r"
        : "Compara uname -r con la versión instalada del kernel";
  return ["Después de actualizar el kernel hay que reiniciar el servidor para que se use el nuevo.", check];
}

/** Paquetes binarios a actualizar (o el paquete fuente si no se conocen). */
function packagesOf(f: Finding): string[] {
  const bins = f.binaries.filter((b) => !b.startsWith("/"));
  return safe(bins.length ? bins : [f.package]);
}

function systemCommand(report: Report, f: Finding, tool: SudoTool): string | null {
  const p = pre(tool);
  const pkgs = packagesOf(f);
  switch (distroFamily(report)) {
    case "rpm-dnf":
    case "rpm-yum": {
      const mgr = distroFamily(report) === "rpm-dnf" ? "dnf" : "yum";
      const adv = safe(f.advisories.filter((a) => RPM_ADVISORY.test(a)))[0];
      if (adv) return `${p}${mgr} upgrade --advisory=${adv}`;
      return pkgs.length ? `${p}${mgr} upgrade ${pkgs.join(" ")}` : null;
    }
    case "suse":
      if (/^CVE-\d{4}-\d+$/.test(f.id)) return `${p}zypper patch --cve=${f.id}`;
      return pkgs.length ? `${p}zypper update ${pkgs.join(" ")}` : null;
    case "apt":
      return pkgs.length ? `${p}apt update && ${p}apt install --only-upgrade ${pkgs.join(" ")}` : null;
    case "apk":
      return pkgs.length ? `${p}apk update && ${p}apk upgrade ${pkgs.join(" ")}` : null;
    default:
      return null;
  }
}

function runtimeCommand(f: Finding): FixSuggestion {
  const path = f.binaries.find((b) => b.startsWith("/")) ?? "";
  const fixed = f.fixed && SAFE.test(f.fixed) ? f.fixed : null;
  if (path.includes("/.nvm/")) {
    return { command: `nvm install ${fixed ?? "--lts"}`, notes: ["Node instalado con nvm: instala la versión nueva y cámbiate a ella (nvm use)."] };
  }
  if (path.includes("/.pyenv/")) {
    return { command: fixed ? `pyenv install ${fixed}` : null, notes: ["Python instalado con pyenv: instala la versión nueva y actívala (pyenv global)."] };
  }
  if (path.includes("/.sdkman/")) {
    return { command: "sdk upgrade java", notes: ["Java instalado con SDKMAN."] };
  }
  if (path.includes("/.volta/")) {
    return { command: `volta install node${fixed ? `@${fixed}` : ""}`, notes: ["Node instalado con Volta."] };
  }
  return {
    command: null,
    notes: [
      `«${f.package}» no viene de un paquete de la distro${path ? ` (${path})` : ""}: actualízalo desde donde lo instalaste.`,
      "El resultado es aproximado: se compara con la versión de origen.",
    ],
  };
}

function imageCommand(report: Report, f: Finding): FixSuggestion {
  const t = targetOf(report, f);
  const img = t?.image;
  const engine = img?.engine ?? "podman";
  const tag = img?.tags.find((x) => SAFE.test(x) && !x.startsWith("localhost/"));
  const notes = [
    "Actualiza la imagen y vuelve a crear sus contenedores; no actualices paquetes dentro de un contenedor (se pierde al recrearlo).",
  ];
  if (img && img.containers.length) {
    notes.push(`Contenedores que la usan: ${img.containers.map((c) => c.name).join(", ")}.`);
    notes.push(`Si vienen de Compose: ${engine} compose pull && ${engine} compose up -d`);
  } else {
    notes.push("Ningún contenedor la usa: quizá basta con borrarla.");
  }
  if (!tag) {
    notes.push("La imagen es local o no tiene etiqueta: vuelve a construirla con una base actualizada.");
    return { command: null, notes };
  }
  return { command: `${engine} pull ${tag}`, notes };
}

/** Comando sugerido para un hallazgo. `tool`: cómo se eleva en el servidor. */
export function fixSuggestion(report: Report, f: Finding, tool: SudoTool = "sudo"): FixSuggestion {
  const t = targetOf(report, f);
  if (t?.kind === "image") return imageCommand(report, f);
  if (t?.kind === "runtime" || f.upstream) return runtimeCommand(f);
  if (!f.hasFix) {
    return { command: null, notes: ["Todavía no hay arreglo publicado: vigila las actualizaciones de la distro."] };
  }
  const command = systemCommand(report, f, tool);
  const notes: string[] = [];
  if (!command) notes.push("No se conoce el gestor de paquetes de este sistema: actualiza el paquete a mano.");
  if (f.kernel) notes.push(...kernelNotes(report));
  return { command, notes };
}

/** Un solo comando para todos los paquetes del kernel con arreglo (fila agrupada). */
export function kernelSuggestion(report: Report, findings: Finding[], tool: SudoTool = "sudo"): FixSuggestion {
  const fixable = findings.filter((f) => f.kernel && f.hasFix);
  if (!fixable.length) return { command: null, notes: ["Todavía no hay un kernel con arreglo.", ...kernelNotes(report)] };
  const merged: Finding = {
    ...fixable[0],
    advisories: [],
    binaries: [...new Set(fixable.flatMap((f) => f.binaries))],
  };
  const fam = distroFamily(report);
  let command = systemCommand(report, merged, tool);
  if (fam === "rpm-dnf" || fam === "rpm-yum") command = `${pre(tool)}${fam === "rpm-dnf" ? "dnf" : "yum"} upgrade 'kernel*'`;
  return { command, notes: kernelNotes(report) };
}
