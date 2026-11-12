// Detección de comandos peligrosos y de sudo (funciones puras).

interface DangerRule {
  re: RegExp;
  label: string;
}

// Inicio de un comando: principio, tras ; & | ( ` $( o tras sudo/doas/xargs/exec.
const W = String.raw`(?:^|[\s;&|(\x60]|\$\()`;

const RULES: DangerRule[] = [
  {
    re: new RegExp(String.raw`${W}rm\s+(?:[^;&|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*[rR]|--recursive\b[^;&|]*--force|--force\b[^;&|]*--recursive|-[rR]\s+-[fF]|-[fF]\s+-[rR])`),
    label: "borrado recursivo (rm -rf)",
  },
  { re: new RegExp(String.raw`${W}rm\s+(?:[^;&|]*\s)?-[a-zA-Z]*[rR]\b`), label: "borrado recursivo (rm -r)" },
  { re: new RegExp(String.raw`${W}(?:shutdown|poweroff|halt)\b`), label: "apaga el servidor" },
  { re: new RegExp(String.raw`${W}reboot\b`), label: "reinicia el servidor" },
  { re: new RegExp(String.raw`${W}init\s+[06]\b`), label: "apaga o reinicia el servidor" },
  { re: new RegExp(String.raw`${W}systemctl\s+(?:[^;&|]*\s)?(?:poweroff|reboot|halt|kexec)\b`), label: "apaga o reinicia el servidor" },
  { re: new RegExp(String.raw`${W}mkfs(?:\.[a-z0-9]+)?\b`), label: "formatea un disco (mkfs)" },
  { re: new RegExp(String.raw`${W}dd\s`), label: "escritura directa a disco (dd)" },
  { re: new RegExp(String.raw`${W}(?:fdisk|sfdisk|parted|wipefs|sgdisk)\b`), label: "modifica particiones" },
  { re: /\bprune\b/, label: "borra recursos sin usar (prune)" },
  { re: new RegExp(String.raw`${W}(?:userdel|deluser|groupdel|delgroup)\b`), label: "elimina usuarios o grupos" },
  { re: new RegExp(String.raw`${W}(?:podman|docker)\s+(?:[^;&|]*\s)?(?:rm|rmi|kill)\b`), label: "elimina o detiene contenedores" },
  { re: new RegExp(String.raw`${W}(?:podman|docker)\s+(?:[^;&|]*\s)?(?:volume|network|system)\s+rm\b`), label: "elimina volúmenes o redes" },
  { re: new RegExp(String.raw`${W}systemctl\s+(?:[^;&|]*\s)?(?:stop|disable|mask|kill)\b`), label: "detiene servicios" },
  { re: new RegExp(String.raw`${W}(?:killall|pkill)\b`), label: "mata procesos" },
  { re: new RegExp(String.raw`${W}kill\s+(?:-9|-KILL|-SIGKILL)\b`), label: "mata procesos" },
  { re: new RegExp(String.raw`${W}(?:chmod|chown|chgrp)\s+(?:[^;&|]*\s)?-[a-zA-Z]*R`), label: "cambia permisos de forma recursiva" },
  { re: new RegExp(String.raw`${W}(?:iptables|ip6tables|nft)\s+(?:[^;&|]*\s)?(?:-F|--flush|flush)\b`), label: "vacía el cortafuegos" },
  { re: new RegExp(String.raw`${W}(?:truncate|shred)\b`), label: "vacía o destruye archivos" },
  { re: />\s*\/dev\/(?:sd|nvme|vd|hd|xvd|mmcblk)/, label: "escribe directamente en un disco" },
  { re: new RegExp(String.raw`${W}(?:passwd|chpasswd)\b`), label: "cambia contraseñas" },
  { re: new RegExp(String.raw`${W}(?:dnf|yum|apt|apt-get|apk|zypper|pacman)\s+(?:[^;&|]*\s)?(?:remove|erase|purge|autoremove|del|-R)\b`), label: "desinstala paquetes" },
  { re: new RegExp(String.raw`${W}git\s+(?:[^;&|]*\s)?(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+(?:[^;&|]*\s)?(?:-f|--force))`), label: "descarta cambios de git" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, label: "bomba de procesos" },
  { re: /\bDROP\s+(?:DATABASE|TABLE|SCHEMA)\b/i, label: "borra una base de datos" },
];

/** Motivos por los que el comando parece peligroso (sin repetir). Vacío = no lo parece. */
export function dangerReasons(command: string): string[] {
  const out: string[] = [];
  for (const r of RULES) {
    if (r.re.test(command) && !out.includes(r.label)) out.push(r.label);
  }
  // "rm -rf" ya implica "rm -r".
  if (out.includes("borrado recursivo (rm -rf)")) return out.filter((x) => x !== "borrado recursivo (rm -r)");
  return out;
}

const SUDO_RE = new RegExp(String.raw`${W}(?:sudo|doas)(?:\s|$)`);
const SUDO_NONINTERACTIVE_RE = new RegExp(String.raw`${W}(?:sudo|doas)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*n`);

/** ¿El comando usa sudo/doas? */
export function usesSudo(command: string): boolean {
  return SUDO_RE.test(command);
}

/** ¿Usa sudo -n (no pide contraseña: falla en seguida si la necesita)? */
export function usesSudoNonInteractive(command: string): boolean {
  return SUDO_NONINTERACTIVE_RE.test(command);
}

/** ¿El comando no termina solo (top, tail -f, watch…)? En ejecución no interactiva se cortaría por tiempo. */
export function looksInteractive(command: string): boolean {
  return new RegExp(
    String.raw`${W}(?:top|htop|btop|watch|less|more|vi|vim|nano|man|ssh|mysql|psql|python3?|node|bash|sh|zsh)\s*$|${W}(?:tail|journalctl|podman\s+logs|docker\s+logs|kubectl\s+logs)\s+(?:[^;&|]*\s)?(?:-f|--follow)\b`,
  ).test(command.trim());
}
