// Salidas falsas de la pestaña «Administración» de web-prod (Ubuntu 24.04): usuarios y grupos, estado de
// las contraseñas, puertos en escucha y sitios web de nginx.
// Estos scripts llegan por stdin (exec_capture_stdin): motor.ts prueba las reglas contra el stdin
// (y luego contra comando + stdin).
import type { Rule } from "../salidas";

// ───────── Usuarios y grupos ─────────

const PASSWD = `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
bin:x:2:2:bin:/bin:/usr/sbin/nologin
sys:x:3:3:sys:/dev:/usr/sbin/nologin
sync:x:4:65534:sync:/bin:/bin/sync
man:x:6:12:man:/var/cache/man:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
backup:x:34:34:backup:/var/backups:/usr/sbin/nologin
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
systemd-network:x:998:998:systemd Network Management:/:/usr/sbin/nologin
systemd-timesync:x:996:996:systemd Time Synchronization:/:/usr/sbin/nologin
messagebus:x:100:102::/nonexistent:/usr/sbin/nologin
systemd-resolve:x:991:991:systemd Resolver:/:/usr/sbin/nologin
syslog:x:102:103::/nonexistent:/usr/sbin/nologin
sshd:x:105:65534::/run/sshd:/usr/sbin/nologin
postgres:x:110:113:PostgreSQL administrator,,,:/var/lib/postgresql:/bin/bash
redis:x:111:114::/var/lib/redis:/usr/sbin/nologin
deploy:x:1000:1000:Despliegues,,,:/home/deploy:/bin/bash
ana:x:1001:1001:Ana García,,,:/home/ana:/bin/bash
luis:x:1002:1002:Luis Moreno,,,:/home/luis:/bin/bash
marta:x:1003:1003:Marta Ruiz,,,:/home/marta:/usr/bin/zsh
ci:x:1004:1004:Integración continua,,,:/home/ci:/bin/sh
jorge:x:1005:1005:Jorge Pérez,,,:/home/jorge:/bin/bash`;

const GROUP = `root:x:0:
daemon:x:1:
bin:x:2:
sys:x:3:
adm:x:4:syslog,deploy
tty:x:5:
sudo:x:27:deploy,ana
www-data:x:33:deploy,ana
backup:x:34:
users:x:100:
systemd-journal:x:999:
docker:x:989:deploy,ci
ssl-cert:x:112:postgres
postgres:x:113:
redis:x:114:
nogroup:x:65534:
deploy:x:1000:
ana:x:1001:
luis:x:1002:
marta:x:1003:
ci:x:1004:
jorge:x:1005:
desarrollo:x:1010:ana,luis,marta`;

const SHELLS = `# /etc/shells: valid login shells
/bin/sh
/usr/bin/sh
/bin/bash
/usr/bin/bash
/bin/rbash
/usr/bin/rbash
/usr/bin/dash
/bin/zsh
/usr/bin/zsh`;

const WHO = `deploy   pts/0        2026-11-12 19:12 (198.51.100.24)
ana      pts/1        2026-11-12 18:55 (192.0.2.57)`;

const TOOLS = [
  "useradd",
  "usermod",
  "userdel",
  "groupadd",
  "groupdel",
  "groupmod",
  "gpasswd",
  "chpasswd",
  "chage",
  "passwd",
  "adduser",
  "deluser",
  "addgroup",
  "delgroup",
  "pkill",
  "loginctl",
  "lastlog",
  "sudo",
  "pkill-procps",
].join("\n");

/** `lastlog` (LC_ALL=C): columnas fijas, «Latest» empieza donde lo dice la cabecera. */
function lastlog(): string {
  const rows: [string, string, string, string][] = [
    ["root", "", "", "**Never logged in**"],
    ["daemon", "", "", "**Never logged in**"],
    ["www-data", "", "", "**Never logged in**"],
    ["postgres", "", "", "**Never logged in**"],
    ["deploy", "pts/0", "198.51.100.24", "Thu Nov 12 19:12:07 -0500 2026"],
    ["ana", "pts/1", "192.0.2.57", "Thu Nov 12 18:55:32 -0500 2026"],
    ["luis", "pts/2", "198.51.100.71", "Mon Nov  9 13:22:10 -0500 2026"],
    ["marta", "pts/1", "192.0.2.140", "Tue Nov 10 08:15:44 -0500 2026"],
    ["ci", "", "203.0.113.50", "Thu Nov 12 07:30:02 -0500 2026"],
    ["jorge", "pts/3", "198.51.100.9", "Wed Sep 16 17:48:51 -0500 2026"],
  ];
  const head = `${"Username".padEnd(17)}${"Port".padEnd(9)}${"From".padEnd(43)}Latest`;
  return [head, ...rows.map(([u, p, f, l]) => `${u.padEnd(17)}${p.padEnd(9)}${f.padEnd(43)}${l}`)].join("\n");
}

const READ = [
  "@@me",
  "deploy",
  "@@passwd",
  PASSWD,
  "@@group",
  GROUP,
  "@@shells",
  SHELLS,
  "@@who",
  WHO,
  "@@tools",
  TOOLS,
  "@@lastlog",
  lastlog(),
  "@@end",
  "",
].join("\n");

// Días desde 1970 (12/11/2026 = 20769). root y las cuentas del sistema sin acceso por contraseña;
// luis debe cambiarla (0); jorge, bloqueado.
const SHADOW = [
  "@@shadow",
  "root:NL:20180::",
  "daemon:NL:20180::",
  "bin:NL:20180::",
  "sys:NL:20180::",
  "sync:NL:20180::",
  "man:NL:20180::",
  "www-data:NL:20180::",
  "backup:NL:20180::",
  "nobody:NL:20180::",
  "systemd-network:L:20180::",
  "systemd-timesync:L:20180::",
  "messagebus:L:20180::",
  "systemd-resolve:L:20180::",
  "syslog:L:20180::",
  "sshd:L:20180::",
  "postgres:L:20181::",
  "redis:L:20181::",
  "deploy:P:20190:99999:",
  "ana:P:20702:99999:",
  "luis:P:0:99999:",
  "marta:P:20655:99999:",
  "ci:NL:20410::",
  "jorge:L:20612:99999:",
  "@@end",
  "",
].join("\n");

// ───────── Puertos ─────────

const SS = `Netid State  Recv-Q Send-Q      Local Address:Port  Peer Address:Port Process
udp   UNCONN 0      0           127.0.0.54:53            0.0.0.0:*     users:(("systemd-resolve",pid=612,fd=15))
udp   UNCONN 0      0           127.0.0.53%lo:53         0.0.0.0:*     users:(("systemd-resolve",pid=612,fd=13))
tcp   LISTEN 0      4096              0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=905,fd=3))
tcp   LISTEN 0      511               0.0.0.0:80         0.0.0.0:*     users:(("nginx",pid=1124,fd=6),("nginx",pid=1125,fd=6),("nginx",pid=1123,fd=6))
tcp   LISTEN 0      511               0.0.0.0:443        0.0.0.0:*     users:(("nginx",pid=1124,fd=8),("nginx",pid=1125,fd=8),("nginx",pid=1123,fd=8))
tcp   LISTEN 0      511             127.0.0.1:3000       0.0.0.0:*     users:(("node",pid=2210,fd=21))
tcp   LISTEN 0      200             127.0.0.1:5432       0.0.0.0:*     users:(("postgres",pid=1032,fd=6))
tcp   LISTEN 0      511             127.0.0.1:6379       0.0.0.0:*     users:(("redis-server",pid=998,fd=6))
tcp   LISTEN 0      4096            127.0.0.1:8080       0.0.0.0:*     users:(("docker-proxy",pid=3301,fd=4))
tcp   LISTEN 0      4096            127.0.0.1:9100       0.0.0.0:*     users:(("node_exporter",pid=3415,fd=3))`;

const NODE_EXPORTER_ID = "7c41e9a0b2d35f8e6a1c4d9b0e2f7a83c5d6e1f0a9b8c7d6e5f4a3b2c1d0e9f8";
const API_ID = "3f9a1c0d7e215b6a8c4e2f1d0b9a8c7e6d5f4a3b2c1e0d9f8a7b6c5d4e3f2a1b";

const PORTS = [
  "@@tool",
  "ss",
  "@@listen",
  SS,
  "@@procs",
  "612|systemd-resolve|systemd-resolved.service",
  "905|root|ssh.service",
  "998|redis|redis-server.service",
  "1032|postgres|postgresql@16-main.service",
  "1123|root|nginx.service",
  "1124|www-data|nginx.service",
  "1125|www-data|nginx.service",
  "2210|deploy|tienda.service",
  "3301|root|docker.service",
  `3415|nobody|docker-${NODE_EXPORTER_ID}.scope`,
  "@@ctr",
  `${API_ID} tienda-api`,
  `${NODE_EXPORTER_ID} node-exporter`,
  "@@end",
  "",
].join("\n");

// ───────── Sitios web (nginx -T) ─────────

const NGINX_T = `# configuration file /etc/nginx/nginx.conf:
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
	worker_connections 768;
}

http {
	sendfile on;
	tcp_nopush on;
	types_hash_max_size 2048;
	server_tokens off;

	include /etc/nginx/mime.types;
	default_type application/octet-stream;

	ssl_protocols TLSv1.2 TLSv1.3;
	ssl_prefer_server_ciphers off;

	access_log /var/log/nginx/access.log;
	gzip on;

	include /etc/nginx/conf.d/*.conf;
	include /etc/nginx/sites-enabled/*;
}

# configuration file /etc/nginx/mime.types:
types {
	text/html html htm shtml;
	text/css css;
	application/javascript js;
	image/png png;
	image/svg+xml svg;
}

# configuration file /etc/nginx/sites-enabled/default:
# Todo lo que llega por HTTP va a HTTPS.
server {
	listen 80 default_server;
	listen [::]:80 default_server;
	server_name _;
	return 301 https://$host$request_uri;
}

# configuration file /etc/nginx/sites-enabled/tienda.example.com:
server {
	listen 443 ssl;
	listen [::]:443 ssl;
	http2 on;
	server_name tienda.example.com www.tienda.example.com;

	ssl_certificate /etc/letsencrypt/live/tienda.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/tienda.example.com/privkey.pem;

	root /var/www/tienda/public;

	location / {
		proxy_pass http://127.0.0.1:3000;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto $scheme;
	}

	location /static/ {
		alias /var/www/tienda/static/;
		expires 30d;
	}
}

# configuration file /etc/nginx/sites-enabled/api.example.com:
upstream tienda_api {
	server 127.0.0.1:8080;
	keepalive 16;
}

server {
	listen 443 ssl;
	listen [::]:443 ssl;
	http2 on;
	server_name api.example.com;

	ssl_certificate /etc/letsencrypt/live/api.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

	location / {
		proxy_pass http://tienda_api;
		proxy_set_header Host $host;
	}

	location /metrics {
		return 403;
	}
}

# configuration file /etc/nginx/sites-enabled/estado.example.com:
server {
	listen 443 ssl;
	listen [::]:443 ssl;
	server_name estado.example.com;

	ssl_certificate /etc/letsencrypt/live/estado.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/estado.example.com/privkey.pem;

	root /var/www/estado;
	index index.html;
}
`;

const WEB = [
  "@@svc",
  "nginx active",
  "@@nginx",
  "nginx dump /etc/nginx/nginx.conf",
  "@@nginxconf",
  NGINX_T,
  "@@certs",
  "/etc/letsencrypt/live/api.example.com/fullchain.pem|Feb  3 06:12:41 2027 GMT",
  "/etc/letsencrypt/live/estado.example.com/fullchain.pem|Dec  2 04:51:09 2026 GMT",
  "/etc/letsencrypt/live/tienda.example.com/fullchain.pem|Jan 28 03:20:17 2027 GMT",
  "@@end",
  "",
].join("\n");

export const reglas: Rule[] = [
  [/echo @@me; id -un/, READ],
  [/echo @@shadow/, SHADOW],
  [/T=ss; L=\$\(ss -tulpn/, PORTS],
  [/echo @@svc/, WEB],
];
