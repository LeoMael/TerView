// Script de solo lectura de la auditoría (no instala ni cambia nada). POSIX sh: funciona en bash, dash y
// el ash de busybox (Alpine). Con root/sudo ve más; sin él, cada sección dice «@noread» si no pudo leer.
// Puertos y sitios web se leen con los scripts de Administración (PORTS_SCRIPT y WEB_SCRIPT).
//
// Secciones (formato de `splitSections`):
//   @@id «uid usuario» · @@os «id|id_like|nombre» · @@sshd (sshd -T) · @@sshdsrc «T|F» · @@sshdcfg (archivos)
//   @@sshinc «n» · @@passwd «nombre:uid:home:shell» · @@shadow «nombre:empty|locked|set» · @@keys «usuario|n|modo|ruta»
//   @@sudoers (líneas sin comentarios) · @@groups (getent) · @@fw «herramienta estado [n]»
//   @@updates «gestor|total|seguridad» · @@reboot · @@failed · @@auth · @@disk (df -P) · @@mem · @@proc
//   @@perms «ruta modo dueño grupo» · @@wwetc · @@webperm («@dir», «@group caddy», archivos) · @@cron
//   @@ctr («@engine motor rootless» + «nombre|privilegiado|usuario|puertos») · @@end

export const AUDIT_SCRIPT = [
  "PATH=$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin; export PATH",
  "LC_ALL=C; export LC_ALL",
  "TO=''; command -v timeout >/dev/null 2>&1 && TO='timeout 60'",
  "ME=$(id -u)",
  "echo @@id; echo \"$ME $(id -un)\"; id -Gn",
  "echo @@os",
  "if [ -r /etc/os-release ]; then ( . /etc/os-release; echo \"$ID|$ID_LIKE|$PRETTY_NAME\" ); fi",
  // SSH: configuración efectiva (sshd -T necesita root casi siempre) y, si no, los archivos.
  "echo @@sshd",
  "S=$(sshd -T 2>/dev/null)",
  "printf '%s\\n' \"$S\" | grep -iE '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|permitemptypasswords|pubkeyauthentication|port) '",
  "echo @@sshdsrc; if [ -n \"$S\" ]; then echo T; else echo F; fi",
  "echo @@sshdcfg",
  "for f in /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config; do [ -r \"$f\" ] && grep -iE '^[[:space:]]*(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|permitemptypasswords|port)[[:space:]]' \"$f\" | sed \"s|^|$f:|\"; done",
  "if [ ! -e /etc/ssh/sshd_config ]; then echo @nofile; elif [ ! -r /etc/ssh/sshd_config ]; then echo @noread; fi",
  "echo @@sshinc; grep -ciE '^[[:space:]]*include[[:space:]]+/etc/ssh/sshd_config\\.d' /etc/ssh/sshd_config 2>/dev/null; true",
  // Usuarios.
  "echo @@passwd; cut -d: -f1,3,6,7 /etc/passwd 2>/dev/null",
  "echo @@shadow",
  "if [ -r /etc/shadow ]; then awk -F: '{ s=$2; t=\"set\"; if (s==\"\") t=\"empty\"; else if (s ~ /^[!*]/) t=\"locked\"; print $1\":\"t }' /etc/shadow; else echo @noread; fi",
  "echo @@keys",
  "cut -d: -f1,3,6 /etc/passwd 2>/dev/null | while IFS=: read -r u uid h; do",
  "  { [ \"$uid\" -eq 0 ] || { [ \"$uid\" -ge 1000 ] && [ \"$uid\" -lt 65534 ]; }; } 2>/dev/null || continue",
  "  f=\"$h/.ssh/authorized_keys\"",
  "  if [ -r \"$f\" ]; then n=$(grep -cvE '^[[:space:]]*(#|$)' \"$f\" 2>/dev/null); echo \"$u|$n|$(stat -c %a \"$f\" 2>/dev/null)|$f\"",
  "  elif [ -e \"$f\" ]; then echo \"$u|?||$f\"; elif [ -d \"$h\" ] && [ ! -x \"$h\" ]; then echo \"$u|?||$f\"; fi",
  "done",
  "echo @@sudoers",
  "if [ -r /etc/sudoers ]; then cat /etc/sudoers /etc/sudoers.d/* 2>/dev/null | grep -vE '^[[:space:]]*(#|$)'; elif [ -e /etc/sudoers ]; then echo @noread; fi",
  "if [ -r /etc/doas.conf ]; then sed 's/^/doas: /' /etc/doas.conf | grep -v '^doas: *#'; elif [ -e /etc/doas.conf ]; then echo @noread; fi",
  "echo @@groups; grep -E '^(sudo|wheel|admin):' /etc/group",
  // Cortafuegos.
  "echo @@fw",
  "if command -v firewall-cmd >/dev/null 2>&1; then echo \"firewalld $(firewall-cmd --state 2>/dev/null || echo off)\"; fi",
  "if command -v ufw >/dev/null 2>&1; then if [ \"$ME\" = 0 ]; then echo \"ufw $(ufw status 2>/dev/null | head -n1 | awk '{print $2}')\"; else echo \"ufw ?\"; fi; fi",
  // nft/iptables: reglas en la entrada (las de Docker van en FORWARD y no cuentan).
  "if command -v nft >/dev/null 2>&1; then if [ \"$ME\" = 0 ]; then N=$(nft list ruleset 2>/dev/null); echo \"nft x $(printf '%s\\n' \"$N\" | grep -c 'hook input') $(printf '%s\\n' \"$N\" | grep -cwE 'drop|reject')\"; else echo \"nft ?\"; fi; fi",
  "if command -v iptables >/dev/null 2>&1; then if [ \"$ME\" = 0 ]; then echo \"iptables x $(iptables -S INPUT 2>/dev/null | grep -c '^-A INPUT') $(iptables -S INPUT 2>/dev/null | grep -c '^-P INPUT DROP')\"; else echo \"iptables ?\"; fi; fi",
  // Actualizaciones (con la caché que ya haya: sin descargar índices nuevos).
  "echo @@updates",
  "if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then P=dnf; command -v dnf >/dev/null 2>&1 || P=yum",
  // -C: solo la caché (sin descargar). Código 1 = error (p. ej. sin caché): «?».
  "  o=$($TO $P -q -C check-update 2>/dev/null); rc=$?",
  "  if [ $rc = 1 ]; then t='?'; else t=$(printf '%s\\n' \"$o\" | grep -cE '^[A-Za-z0-9_.+-]+\\.[a-z0-9_]+[[:space:]]+[^[:space:]]+[[:space:]]'); fi",
  "  s=$($TO $P -q -C updateinfo list --security 2>/dev/null | grep -cE '^[A-Z][A-Z0-9]*-[0-9]{4}[-:]')",
  "  echo \"$P|$t|$s\"",
  "elif command -v apt >/dev/null 2>&1; then L=$(apt list --upgradable 2>/dev/null | grep '/')",
  "  echo \"apt|$(printf '%s\\n' \"$L\" | grep -c /)|$(printf '%s\\n' \"$L\" | grep -c -- '-security')\"",
  "elif command -v apk >/dev/null 2>&1; then echo \"apk|$(apk version -l '<' 2>/dev/null | grep -c '<')|?\"",
  "else echo 'none|?|?'; fi",
  "echo @@reboot",
  "[ -f /var/run/reboot-required ] && echo required",
  "if command -v needs-restarting >/dev/null 2>&1; then $TO needs-restarting -r >/dev/null 2>&1; echo \"nr $?\";",
  "elif command -v dnf >/dev/null 2>&1 && dnf needs-restarting --help >/dev/null 2>&1; then $TO dnf -q needs-restarting -r >/dev/null 2>&1; echo \"nr $?\"; fi",
  "echo \"kernel $(uname -r)\"; ls /lib/modules 2>/dev/null | sed 's/^/mod /'",
  // Servicios caídos (systemd u OpenRC).
  "echo @@failed",
  "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}'",
  "elif command -v rc-status >/dev/null 2>&1; then rc-status --crashed 2>/dev/null | awk '{print $1}'; else echo @nosvc; fi",
  // Intentos de entrada fallidos (últimas 24 h) y fail2ban.
  "echo @@auth",
  "R='Failed password|Invalid user|authentication failure|Failed publickey'",
  "if command -v journalctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then",
  "  n=$($TO journalctl -q --no-pager --since '-24h' _COMM=sshd _COMM=sshd-session 2>/dev/null | grep -cE \"$R\")",
  "  if [ \"$ME\" = 0 ] || id -Gn | grep -qwE 'adm|systemd-journal|wheel'; then echo \"journal $n\"; else echo \"journal-partial $n\"; fi",
  "fi",
  "for f in /var/log/auth.log /var/log/secure /var/log/messages; do [ -r \"$f\" ] && { echo \"file $(grep -cE \"$R\" \"$f\" 2>/dev/null) $f\"; break; }; done",
  "if command -v fail2ban-client >/dev/null 2>&1 || [ -x /usr/bin/fail2ban-server ]; then",
  "  if pgrep -x fail2ban-server >/dev/null 2>&1 || systemctl is-active -q fail2ban 2>/dev/null; then echo 'f2b active'; else echo 'f2b inactive'; fi",
  "else echo 'f2b none'; fi",
  // Disco y memoria.
  "echo @@disk; df -P 2>/dev/null | awk 'NR>1'",
  "echo @@mem; grep -E '^(MemTotal|MemAvailable|MemFree|SwapTotal|SwapFree):' /proc/meminfo",
  // Endurecimiento.
  "echo @@proc; grep -E '^[^ ]+ /proc proc ' /proc/mounts",
  "echo @@perms; for f in /etc/shadow /etc/gshadow /etc/passwd /etc/sudoers /etc/ssh/sshd_config; do [ -e \"$f\" ] && stat -c '%n %a %U %G' \"$f\"; done",
  "echo @@wwetc; find /etc -xdev \\( -type f -o -type d \\) -perm -0002 2>/dev/null | head -n 50",
  "echo @@webperm",
  "for d in /etc/nginx /etc/caddy /etc/apache2 /etc/httpd; do [ -d \"$d\" ] && { echo \"@dir $d\"; find \"$d\" -xdev -type f -perm -0004 2>/dev/null | head -n 40; }; done",
  "getent group caddy >/dev/null 2>&1 && echo '@group caddy'",
  "echo @@cron",
  "for d in /var/spool/cron/crontabs /var/spool/cron; do [ -d \"$d\" ] || continue; if [ -r \"$d\" ] && [ -x \"$d\" ]; then for f in \"$d\"/*; do [ -f \"$f\" ] && echo \"${f##*/}\"; done; else echo @noread; fi; break; done",
  // Contenedores en marcha (los del usuario con el que se lee: root si hay sudo).
  "echo @@ctr",
  "TC=''; command -v timeout >/dev/null 2>&1 && TC='timeout 20'",
  "for t in podman docker; do command -v $t >/dev/null 2>&1 || continue",
  "  [ $t = docker ] && docker --version 2>/dev/null | grep -qi podman && continue",
  "  ids=$($TC $t ps -q 2>/dev/null); [ -n \"$ids\" ] || continue",
  "  if [ $t = podman ]; then rl=$($TC podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null); else rl=false; $TC docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless && rl=true; fi",
  "  echo \"@engine $t $rl\"",
  "  $TC $t inspect --format '{{.Name}}|{{.HostConfig.Privileged}}|{{.Config.User}}|{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}' $ids 2>/dev/null",
  "done",
  "echo @@end",
].join("\n");
