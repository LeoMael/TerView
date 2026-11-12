// Texto que «escribe» el servidor simulado en cada terminal nueva (con colores ANSI).
const G = "\x1b[1;32m";
const B = "\x1b[1;34m";
const C = "\x1b[36m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const R = "\x1b[0m";

function lines(user: string, host: string): { first: string[]; second: string[] } {
  const prompt = `${G}${user}@${host}${R}:${B}~${R}$ `;

  const FIRST = [
    `${D}Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-49-generic x86_64)${R}`,
    "",
    `  System load:  0.18               Processes:             142`,
    `  Usage of /:   41.2% of 78.20GB   Users logged in:       1`,
    `  Memory usage: 37%                IPv4 address for eth0: 203.0.113.10`,
    "",
    `${prompt}ls`,
    `${B}app${R}  ${B}backups${R}  ${B}logs${R}  ${B}scripts${R}  docker-compose.yml  ${G}deploy.sh${R}  README.md`,
    `${prompt}systemctl status nginx --no-pager`,
    `${G}●${R} nginx.service - A high performance web server and a reverse proxy server`,
    `     Loaded: loaded (/usr/lib/systemd/system/nginx.service; enabled; preset: enabled)`,
    `     Active: ${G}active (running)${R} since Mon 2026-11-09 08:12:44 UTC; 3 days ago`,
    `   Main PID: 1123 (nginx)`,
    `      Tasks: 5 (limit: 4553)`,
    `     Memory: 12.4M (peak: 18.1M)`,
    `        CPU: 2min 41.112s`,
    `     CGroup: /system.slice/nginx.service`,
    `             ├─1123 "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;"`,
    `             └─1124 "nginx: worker process"`,
    `${prompt}tail -n 4 logs/app.log`,
    `${D}2026-11-12 19:40:02${R} ${C}INFO${R}  pedido #48213 pagado (23,90 €)`,
    `${D}2026-11-12 19:40:17${R} ${C}INFO${R}  cache de catálogo regenerada en 412 ms`,
    `${D}2026-11-12 19:41:05${R} ${Y}WARN${R}  respuesta lenta de la pasarela de pago (2,3 s)`,
    `${D}2026-11-12 19:41:30${R} ${C}INFO${R}  pedido #48214 pagado (61,00 €)`,
    prompt,
  ];

  const SECOND = [
    `${prompt}htop`,
    "",
    `${D}(segunda terminal: sigue viva en el servidor gracias a tmux)${R}`,
    prompt,
  ];

  return { first: FIRST, second: SECOND };
}

export function terminalBanner(n: number, user = "deploy", host = "web-prod"): string {
  const l = lines(user, host);
  return (n % 2 === 1 ? l.first : l.second).join("\r\n");
}
