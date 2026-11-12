// Salidas falsas de la Biblioteca de comandos y de «Analizar servidor» (servidor web-prod simulado).
import type { Rule } from "../salidas";

const GB = 1024 ** 3;

export const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.3 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.3 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
`;

export const DF_H = `Filesystem      Size  Used Avail Use% Mounted on
tmpfs           794M  1.2M  793M   1% /run
/dev/vda1        78G   41G   34G  55% /
tmpfs           3.9G     0  3.9G   0% /dev/shm
tmpfs           5.0M     0  5.0M   0% /run/lock
/dev/vda15      105M  6.1M   99M   6% /boot/efi
/dev/vdb1       197G  152G   36G  81% /var/www
/dev/vdc1       493G  318G  150G  68% /var/backups
tmpfs           794M   12K  794M   1% /run/user/1000
`;

function disk(fs: string, size: number, used: number, mount: string) {
  const s = Math.round(size * GB);
  const u = Math.round(used * GB);
  const a = Math.round((size - used) * 0.95 * GB);
  return `${fs} ${s} ${u} ${a} ${Math.round((u / (u + a)) * 100)}% ${mount}`;
}

const ANALYSIS = [
  "@@TV:os@@",
  OS_RELEASE,
  "@@TV:kernel@@",
  "Linux 6.8.0-87-generic x86_64",
  "@@TV:host@@",
  "web-prod",
  "@@TV:user@@",
  "deploy",
  "@@TV:uptime@@",
  "3893520.42 15201933.10",
  "@@TV:load@@",
  "0.84 0.71 0.66 2/412 98231",
  "@@TV:cpus@@",
  "4",
  "@@TV:cpumodel@@",
  " AMD EPYC 7763 64-Core Processor",
  "@@TV:mem@@",
  "MemTotal:        8131420 kB",
  "MemFree:          612304 kB",
  "MemAvailable:    3254880 kB",
  "Buffers:          182340 kB",
  "Cached:          2410264 kB",
  "SwapTotal:       2097148 kB",
  "SwapFree:        1835004 kB",
  "@@TV:disks@@",
  "Filesystem 1-blocks Used Available Capacity Mounted on",
  "tmpfs 832512000 1253376 831258624 1% /run",
  disk("/dev/vda1", 78, 41, "/"),
  disk("/dev/vda15", 0.1, 0.006, "/boot/efi"),
  disk("/dev/vdb1", 197, 152, "/var/www"),
  disk("/dev/vdc1", 493, 318, "/var/backups"),
  "@@TV:pcpu@@",
  "    PID USER     %CPU %MEM   RSS COMMAND",
  "   1842 www-data 12.4  3.1 258112 php-fpm8.3",
  "   1843 www-data  9.8  2.9 241760 php-fpm8.3",
  "   1210 postgres  4.2  6.4 532480 postgres",
  "    988 root      1.9  0.6 51200 nginx",
  "   2210 deploy    1.1  4.8 399360 node",
  "    731 root      0.6  0.5 40960 containerd",
  "    812 root      0.4  1.0 81920 dockerd",
  "      1 root      0.0  0.1 13312 systemd",
  "@@TV:pmem@@",
  "    PID USER     %CPU %MEM   RSS COMMAND",
  "   1210 postgres  4.2  6.4 532480 postgres",
  "   2210 deploy    1.1  4.8 399360 node",
  "   1842 www-data 12.4  3.1 258112 php-fpm8.3",
  "   1843 www-data  9.8  2.9 241760 php-fpm8.3",
  "   3021 deploy    0.2  2.2 183296 redis-server",
  "    812 root      0.4  1.0 81920 dockerd",
  "    988 root      1.9  0.6 51200 nginx",
  "    731 root      0.6  0.5 40960 containerd",
  "@@TV:psraw@@",
  "@@TV:failed@@",
  "certbot-renew.service loaded failed failed Certbot renewal",
  "@@TV:ports@@",
  "Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
  'udp   UNCONN 0      0      127.0.0.53%lo:53      0.0.0.0:*     users:(("systemd-resolve",pid=612,fd=13))',
  'tcp   LISTEN 0      4096   0.0.0.0:22            0.0.0.0:*     users:(("sshd",pid=901,fd=3))',
  'tcp   LISTEN 0      511    0.0.0.0:80            0.0.0.0:*     users:(("nginx",pid=988,fd=6))',
  'tcp   LISTEN 0      511    0.0.0.0:443           0.0.0.0:*     users:(("nginx",pid=988,fd=7))',
  'tcp   LISTEN 0      511    127.0.0.1:3000        0.0.0.0:*     users:(("node",pid=2210,fd=21))',
  'tcp   LISTEN 0      244    127.0.0.1:5432        0.0.0.0:*     users:(("postgres",pid=1210,fd=5))',
  'tcp   LISTEN 0      511    127.0.0.1:6379        0.0.0.0:*     users:(("redis-server",pid=3021,fd=6))',
  "@@TV:containers@@",
  "#ENGINE docker",
  "tienda-web|ghcr.io/example/tienda:2.14|Up 6 days",
  "tienda-worker|ghcr.io/example/tienda:2.14|Up 6 days",
  "redis|redis:7-alpine|Up 6 days (healthy)",
  "mailpit|axllent/mailpit:latest|Exited (0) 3 weeks ago",
  "@@TV:journal@@",
  "#SRC journal",
  "nov 12 03:00:14 web-prod certbot[44120]: Failed to renew certificate tienda.example.com: Timeout during connect",
  "nov 12 03:00:14 web-prod systemd[1]: Failed to start certbot-renew.service - Certbot renewal.",
  "nov 12 08:41:52 web-prod php-fpm8.3[1842]: WARNING: [pool www] server reached pm.max_children setting (20)",
  "@@TV:end@@",
  "",
].join("\n");

export const reglas: Rule[] = [
  [/@@TV:\$1@@/, ANALYSIS],
  [/^cat \/etc\/os-release 2>\/dev\/null \|\| cat \/usr\/lib\/os-release/, OS_RELEASE],
  [/^df -h$/, DF_H],
];
