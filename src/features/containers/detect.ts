// Detección de Podman / Docker / Compose en el servidor (script POSIX + parseo). Funciones puras.
// El script viaja por stdin (ver privileges/elevate.ts: buildExec), así que puede llevar comillas simples.
import { parseKeyValues } from "../privileges/detect";
import type { ComposeTool, Engine } from "./types";

/** PATH ampliado: el canal exec no carga el perfil del usuario (Docker de snap, /usr/local/bin…). */
export const PATH_PREFIX = 'PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:/snap/bin"; export PATH';

export const DETECT_SCRIPT = [
  PATH_PREFIX,
  "echo tv_begin=1",
  'echo "uid=$(id -u 2>/dev/null)"',
  'echo "groups=$(id -Gn 2>/dev/null)"',
  't=""; if command -v timeout >/dev/null 2>&1; then t="timeout 8"; fi',
  // Podman
  "if command -v podman >/dev/null 2>&1; then",
  "  echo podman=1",
  "  echo \"podman_version=$($t podman version --format '{{.Client.Version}}' 2>/dev/null | head -n1)\"",
  "  if e=$($t podman info --format '{{.Host.Security.Rootless}}' 2>&1); then echo podman_ok=1; echo \"podman_rootless=$e\"; else echo podman_ok=0; echo \"podman_err=$(printf '%s' \"$e\" | tr '\\n' ' ' | cut -c1-300)\"; fi",
  "  if $t podman compose version >/dev/null 2>&1; then echo podman_compose=1; fi",
  "fi",
  "if command -v podman-compose >/dev/null 2>&1; then echo podman_compose_py=1; fi",
  // Docker (y si en realidad es el emulador de Podman)
  "if command -v docker >/dev/null 2>&1; then",
  "  echo docker=1",
  "  v=$(docker --version 2>&1 | head -n1); echo \"docker_cli=$v\"",
  "  case \"$v\" in *[Pp]odman*) echo docker_shim=1 ;; esac",
  "  if e=$($t docker info --format '{{.ServerVersion}}|{{.SecurityOptions}}' 2>&1); then echo docker_ok=1; echo \"docker_info=$e\"; else echo docker_ok=0; echo \"docker_err=$(printf '%s' \"$e\" | tr '\\n' ' ' | cut -c1-300)\"; fi",
  "  if $t docker compose version >/dev/null 2>&1; then echo docker_compose=1; fi",
  "  if [ -S /var/run/docker.sock ]; then echo docker_sock=1; fi",
  "  if [ -w /var/run/docker.sock ]; then echo docker_sock_w=1; fi",
  "  if command -v systemctl >/dev/null 2>&1; then echo \"docker_service=$(systemctl is-active docker 2>/dev/null | head -n1)\"; fi",
  "fi",
  "if command -v docker-compose >/dev/null 2>&1; then echo docker_compose_py=1; fi",
  "if command -v getent >/dev/null 2>&1 && getent group docker >/dev/null 2>&1; then echo docker_group=1; fi",
  // Para entrar como otro usuario (contenedores de otros usuarios, con sudo).
  "if command -v runuser >/dev/null 2>&1; then echo runuser=1; fi",
  "echo tv_end=1",
].join("\n");

export interface EngineStatus {
  engine: Engine;
  installed: boolean;
  version: string | null;
  /** Se pudo usar como el usuario conectado. */
  accessible: boolean;
  /** Podman sin root (o Docker en modo rootless). */
  rootless: boolean;
  /** Hace falta sudo para usarlo (Docker sin permiso sobre el socket). */
  needsSudo: boolean;
  /** Motivo en español si no está accesible. */
  problem: string | null;
  /** Error original del motor (inglés). */
  rawError: string | null;
  /** Docker: el servicio no está en marcha. */
  serviceDown: boolean;
  compose: ComposeTool[];
}

export interface DetectResult {
  ok: boolean;
  uid: number | null;
  groups: string[];
  inDockerGroup: boolean;
  dockerGroupExists: boolean;
  podman: EngineStatus | null;
  docker: EngineStatus | null;
  /** El comando «docker» es el emulador de Podman (podman-docker). */
  dockerIsShim: boolean;
  /** Hay `runuser` (util-linux) para entrar como otro usuario. */
  runuser: boolean;
}

function empty(engine: Engine): EngineStatus {
  return {
    engine,
    installed: true,
    version: null,
    accessible: false,
    rootless: false,
    needsSudo: false,
    problem: null,
    rawError: null,
    serviceDown: false,
    compose: [],
  };
}

/** Traduce los errores típicos de conexión con el motor. */
export function engineProblem(engine: Engine, err: string): { problem: string; needsSudo: boolean; serviceDown: boolean } {
  const e = err.toLowerCase();
  const name = engine === "docker" ? "Docker" : "Podman";
  if (e.includes("permission denied")) {
    return {
      problem: `Tu usuario no tiene permiso para usar ${name} (no está en el grupo «docker»): hace falta sudo`,
      needsSudo: true,
      serviceDown: false,
    };
  }
  if (e.includes("cannot connect to the docker daemon") || e.includes("is the docker daemon running") || e.includes("no such file or directory")) {
    return { problem: `El servicio ${name} no está en marcha`, needsSudo: false, serviceDown: true };
  }
  if (e.includes("timed out") || e.includes("terminated") || e.trim() === "") {
    return { problem: `${name} no respondió a tiempo`, needsSudo: false, serviceDown: false };
  }
  return { problem: `${name} devolvió un error: ${err.trim()}`, needsSudo: false, serviceDown: false };
}

export function parseDetect(stdout: string): DetectResult {
  const kv = parseKeyValues(stdout);
  const groups = (kv.groups ?? "").split(/\s+/).filter(Boolean);
  const uid = /^\d+$/.test(kv.uid ?? "") ? Number(kv.uid) : null;
  const res: DetectResult = {
    ok: kv.tv_begin === "1" && kv.tv_end === "1",
    uid,
    groups,
    inDockerGroup: groups.includes("docker"),
    dockerGroupExists: kv.docker_group === "1",
    podman: null,
    docker: null,
    dockerIsShim: kv.docker_shim === "1",
    runuser: kv.runuser === "1",
  };

  if (kv.podman === "1") {
    const p = empty("podman");
    p.version = kv.podman_version || null;
    p.accessible = kv.podman_ok === "1";
    p.rootless = kv.podman_ok === "1" ? kv.podman_rootless === "true" : uid !== 0;
    if (!p.accessible) {
      p.rawError = kv.podman_err ?? null;
      p.problem = engineProblem("podman", kv.podman_err ?? "").problem;
    }
    if (kv.podman_compose === "1") p.compose.push("podman compose");
    if (kv.podman_compose_py === "1") p.compose.push("podman-compose");
    res.podman = p;
  }

  if (kv.docker === "1" && kv.docker_shim !== "1") {
    const d = empty("docker");
    const info = kv.docker_info ?? "";
    const [server, sec] = [info.split("|")[0] ?? "", info.split("|").slice(1).join("|")];
    const cli = /version\s+([\w.+-]+)/i.exec(kv.docker_cli ?? "");
    d.version = server.trim() || cli?.[1] || null;
    d.accessible = kv.docker_ok === "1";
    d.rootless = /rootless/i.test(sec);
    if (!d.accessible) {
      d.rawError = (kv.docker_err ?? "").replace(/^\|\[\]\s*/, "") || null;
      const pr = engineProblem("docker", d.rawError ?? "");
      d.problem = pr.problem;
      d.needsSudo = pr.needsSudo || (kv.docker_sock === "1" && kv.docker_sock_w !== "1" && uid !== 0 && !pr.serviceDown);
      d.serviceDown = pr.serviceDown || (kv.docker_service !== undefined && kv.docker_service !== "active" && kv.docker_sock !== "1");
      if (d.needsSudo && !pr.needsSudo) d.problem = engineProblem("docker", "permission denied").problem;
    }
    if (kv.docker_compose === "1") d.compose.push("docker compose");
    if (kv.docker_compose_py === "1") d.compose.push("docker-compose");
    res.docker = d;
  }
  return res;
}

export interface InstallHint {
  title: string;
  command: string;
  note?: string;
}

/** Instrucciones de instalación según la distro (ID / ID_LIKE de /etc/os-release). */
export function installHints(distroId: string | null, distroLike: string[] = []): { distro: string; hints: InstallHint[] } {
  const ids = [distroId ?? "", ...distroLike].map((s) => s.toLowerCase());
  const has = (...xs: string[]) => xs.some((x) => ids.includes(x));
  if (has("fedora", "rhel", "centos", "rocky", "almalinux", "ol")) {
    const fedora = has("fedora") && !has("rhel");
    return {
      distro: fedora ? "Fedora" : "RHEL / Rocky / Alma",
      hints: [
        { title: "Podman (recomendado)", command: "sudo dnf install -y podman podman-compose" },
        fedora
          ? { title: "Docker", command: "sudo dnf install -y moby-engine docker-compose && sudo systemctl enable --now docker" }
          : {
              title: "Docker (repositorio oficial)",
              command:
                "sudo dnf -y install dnf-plugins-core && sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo && sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin && sudo systemctl enable --now docker",
            },
      ],
    };
  }
  if (has("ubuntu", "debian", "linuxmint", "pop", "raspbian")) {
    const ubuntu = has("ubuntu");
    return {
      distro: ubuntu ? "Ubuntu" : "Debian",
      hints: [
        { title: "Podman (recomendado)", command: "sudo apt-get update && sudo apt-get install -y podman podman-compose" },
        {
          title: "Docker",
          command: `sudo apt-get update && sudo apt-get install -y docker.io ${ubuntu ? "docker-compose-v2" : "docker-compose"} && sudo systemctl enable --now docker`,
        },
      ],
    };
  }
  if (has("alpine")) {
    return {
      distro: "Alpine",
      hints: [
        { title: "Podman (recomendado)", command: "doas apk add podman podman-compose", note: "En Alpine también puedes usar sudo si está instalado." },
        { title: "Docker", command: "doas apk add docker docker-cli-compose && doas rc-update add docker default && doas service docker start" },
      ],
    };
  }
  if (has("arch", "manjaro", "endeavouros")) {
    return {
      distro: "Arch Linux",
      hints: [
        { title: "Podman (recomendado)", command: "sudo pacman -S --needed podman podman-compose" },
        { title: "Docker", command: "sudo pacman -S --needed docker docker-compose && sudo systemctl enable --now docker" },
      ],
    };
  }
  if (has("opensuse", "opensuse-leap", "opensuse-tumbleweed", "suse", "sles")) {
    return {
      distro: "openSUSE",
      hints: [
        { title: "Podman (recomendado)", command: "sudo zypper install -y podman podman-compose" },
        { title: "Docker", command: "sudo zypper install -y docker docker-compose && sudo systemctl enable --now docker" },
      ],
    };
  }
  return {
    distro: distroId ?? "tu sistema",
    hints: [
      { title: "Podman", command: "sudo apt-get install -y podman  # o dnf / pacman / zypper según tu distro" },
      { title: "Docker (script oficial)", command: "curl -fsSL https://get.docker.com | sudo sh" },
    ],
  };
}

/** Comando para añadir el usuario al grupo docker (evita usar sudo para cada acción). */
export function dockerGroupCommand(user: string | null): string {
  return `sudo usermod -aG docker ${user ?? "$USER"}`;
}
