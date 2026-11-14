// Salidas reales de AUDIT_SCRIPT en contenedores (podman run … sh < script), recortadas, y una de un
// servidor Rocky con sshd, sudo, cortafuegos y contenedores (escrita a mano a partir de salidas reales).
// Rocky 9 y Debian 12 como root (sin sshd ni sudo instalados); Alpine (openssh-server) como usuario sin sudo.

export const ROCKY_CONTAINER = "@@id\n0 root\nroot\n@@os\nrocky|rhel centos fedora|Rocky Linux 9.0 (Blue Onyx)\n@@sshd\n@@sshdsrc\nF\n@@sshdcfg\n@nofile\n@@sshinc\n@@passwd\nroot:0:/root:/bin/bash\nsync:5:/sbin:/bin/sync\nshutdown:6:/sbin:/sbin/shutdown\nhalt:7:/sbin:/sbin/halt\n@@shadow\nroot:locked\nbin:locked\ndaemon:locked\nadm:locked\nlp:locked\nsync:locked\nshutdown:locked\nhalt:locked\nmail:locked\noperator:locked\ngames:locked\nftp:locked\nnobody:locked\nsystemd-coredump:locked\ndbus:locked\ntss:locked\nsystemd-oom:locked\n@@keys\n@@sudoers\n@@groups\nwheel:x:10:\n@@fw\n@@updates\ndnf|?|0\n@@reboot\nkernel 7.2.15-300.fc45.x86_64\n@@failed\n@nosvc\n@@auth\nf2b none\n@@disk\ntmpfs              1613340       332   1613008       1% /etc/hosts\nshm                  64000         0     64000       0% /dev/shm\ntmpfs                65536         0     65536       0% /dev\noverlay          242534400 221524524  16942164      93% /\ndevtmpfs           7990364         0   7990364       0% /dev/tty\n@@mem\nMemTotal:       16133400 kB\nMemFree:          271100 kB\nMemAvailable:    6519128 kB\nSwapTotal:       8388604 kB\nSwapFree:        3622972 kB\n@@proc\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n@@perms\n/etc/shadow 0 root root\n/etc/gshadow 0 root root\n/etc/passwd 644 root root\n@@wwetc\n@@webperm\n@@cron\n@@ctr\n@@end\n";

export const DEBIAN_CONTAINER = "@@id\n0 root\nroot\n@@os\ndebian||Debian GNU/Linux 12 (bookworm)\n@@sshd\n@@sshdsrc\nF\n@@sshdcfg\n@nofile\n@@sshinc\n@@passwd\nroot:0:/root:/bin/bash\nsync:4:/bin:/bin/sync\n@@shadow\nroot:locked\ndaemon:locked\nbin:locked\nsys:locked\nsync:locked\ngames:locked\nman:locked\nlp:locked\nmail:locked\nnews:locked\nuucp:locked\nproxy:locked\nwww-data:locked\nbackup:locked\nlist:locked\nirc:locked\n_apt:locked\nnobody:locked\n@@keys\n@@sudoers\n@@groups\nsudo:x:27:\n@@fw\n@@updates\napt|0|0\n@@reboot\nkernel 7.2.15-300.fc45.x86_64\n@@failed\n@nosvc\n@@auth\nf2b none\n@@disk\ntmpfs              1613340       332   1613008       1% /etc/hosts\nshm                  64000         0     64000       0% /dev/shm\ntmpfs                65536         0     65536       0% /dev\noverlay          242534400 221524524  16942164      93% /\ndevtmpfs           7990364         0   7990364       0% /dev/tty\n@@mem\nMemTotal:       16133400 kB\nMemFree:          319420 kB\nMemAvailable:    6568720 kB\nSwapTotal:       8388604 kB\nSwapFree:        3622972 kB\n@@proc\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n@@perms\n/etc/shadow 640 root shadow\n/etc/gshadow 640 root shadow\n/etc/passwd 644 root root\n@@wwetc\n@@webperm\n@@cron\n@@ctr\n@@end\n";

export const ALPINE_USER = "@@id\n1000 test\nusers\n@@os\nalpine||Alpine Linux v3.24\n@@sshd\n@@sshdsrc\nF\n@@sshdcfg\n/etc/ssh/sshd_config:PasswordAuthentication no\n@@sshinc\n0\n@@passwd\nroot:0:/root:/bin/sh\nsync:5:/sbin:/bin/sync\nshutdown:6:/sbin:/sbin/shutdown\nhalt:7:/sbin:/sbin/halt\ntest:1000:/config:/bin/bash\n@@shadow\nroot:locked\nbin:locked\ndaemon:locked\nlp:locked\nsync:locked\nshutdown:locked\nhalt:locked\nmail:locked\nnews:locked\nuucp:locked\ncron:locked\nftp:locked\nsshd:locked\ngames:locked\nntp:locked\nguest:locked\nnobody:locked\nklogd:locked\ntest:set\n@@keys\nroot|?||/root/.ssh/authorized_keys\ntest|0|600|/config/.ssh/authorized_keys\n@@sudoers\n@noread\n@@groups\nwheel:x:10:root\n@@fw\n@@updates\napk|0|?\n@@reboot\nkernel 7.2.15-300.fc45.x86_64\n@@failed\n@nosvc\n@@auth\nf2b none\n@@disk\n/dev/nvme1n1p3   242534400 221524524  16942164      93% /config\ntmpfs              1613340       292   1613048       1% /etc/hosts\nshm                  64000         0     64000       0% /dev/shm\ntmpfs                65536         0     65536       0% /dev\noverlay          242534400 221524524  16942164      93% /\ndevtmpfs           7990364         0   7990364       0% /dev/tty\n@@mem\nMemTotal:       16133400 kB\nMemFree:          308908 kB\nMemAvailable:    6559500 kB\nSwapTotal:       8388604 kB\nSwapFree:        3623004 kB\n@@proc\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n@@perms\n/etc/shadow 640 root users\n/etc/passwd 644 root root\n/etc/sudoers 440 root root\n/etc/ssh/sshd_config 644 root root\n@@wwetc\n@@webperm\n@@cron\nroot\n@@ctr\n@@end\n";

/** Servidor Rocky 9 «de verdad», leído con sudo: varios problemas a propósito. */
export const ROCKY_SERVER = [
  "@@id",
  "0 root",
  "root",
  "@@os",
  "rocky|rhel centos fedora|Rocky Linux 9.4 (Blue Onyx)",
  "@@sshd",
  "port 2222",
  "permitrootlogin yes",
  "pubkeyauthentication yes",
  "passwordauthentication yes",
  "kbdinteractiveauthentication no",
  "permitemptypasswords no",
  "@@sshdsrc",
  "T",
  "@@sshdcfg",
  "/etc/ssh/sshd_config.d/50-redhat.conf:PasswordAuthentication yes",
  "@@sshinc",
  "1",
  "@@passwd",
  "root:0:/root:/bin/bash",
  "toor:0:/root:/bin/bash",
  "ana:1000:/home/ana:/bin/bash",
  "deploy:1001:/home/deploy:/bin/bash",
  "@@shadow",
  "root:set",
  "toor:locked",
  "ana:set",
  "deploy:empty",
  "@@keys",
  "root|2|600|/root/.ssh/authorized_keys",
  "ana|1|664|/home/ana/.ssh/authorized_keys",
  "@@sudoers",
  "Defaults   !visiblepw",
  "root\tALL=(ALL) \tALL",
  "%wheel\tALL=(ALL)\tALL",
  "deploy ALL=(ALL) NOPASSWD: ALL",
  "@@groups",
  "wheel:x:10:ana",
  "@@fw",
  "firewalld not running",
  "nft x 0 0",
  "iptables x 0 0",
  "@@updates",
  "dnf|42|7",
  "@@reboot",
  "nr 1",
  "kernel 5.14.0-427.13.1.el9_4.x86_64",
  "@@failed",
  "kdump.service",
  "@@auth",
  "journal 1532",
  "file 1532 /var/log/secure",
  "f2b none",
  "@@disk",
  "/dev/mapper/rl-root  20511312 18970000  1541312      93% /",
  "/dev/vda1             983040   300000   683040      31% /boot",
  "tmpfs                 1000000       0  1000000       0% /run",
  "@@mem",
  "MemTotal:        3861000 kB",
  "MemAvailable:     520000 kB",
  "SwapTotal:       2097148 kB",
  "SwapFree:        2097148 kB",
  "@@proc",
  "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
  "@@perms",
  "/etc/shadow 644 root root",
  "/etc/gshadow 0 root root",
  "/etc/passwd 644 root root",
  "/etc/sudoers 440 root root",
  "/etc/ssh/sshd_config 600 root root",
  "@@wwetc",
  "/etc/app/config.ini",
  "@@webperm",
  "@dir /etc/nginx",
  "/etc/nginx/nginx.conf",
  "/etc/nginx/ssl/tienda.key",
  "@@cron",
  "root",
  "ana",
  "@@ctr",
  "@engine podman false",
  "/db|false||0.0.0.0:5432->5432/tcp ",
  "/tools|true|root|",
  "/web|false|nginx|0.0.0.0:443->443/tcp 127.0.0.1:8080->80/tcp ",
  "@@end",
  "",
].join("\n");

/** El mismo servidor con Ubuntu 24.04 (apt, ufw, grupo sudo, Docker): los arreglos deben ser de Ubuntu. */
export const UBUNTU_SERVER = ROCKY_SERVER.replace("rocky|rhel centos fedora|Rocky Linux 9.4 (Blue Onyx)", "ubuntu|debian|Ubuntu 24.04.3 LTS")
  .replace("/etc/ssh/sshd_config.d/50-redhat.conf:", "/etc/ssh/sshd_config.d/50-cloud-init.conf:")
  .replace("wheel:x:10:ana", "sudo:x:27:ana")
  .replace("%wheel\tALL=(ALL)\tALL", "%sudo\tALL=(ALL:ALL) ALL")
  .replace("firewalld not running\n", "ufw inactive\n")
  .replace("dnf|42|7", "apt|12|3")
  .replace("nr 1\nkernel 5.14.0-427.13.1.el9_4.x86_64", "required\nkernel 6.8.0-45-generic\nmod 6.8.0-45-generic\nmod 6.8.0-49-generic")
  .replace("file 1532 /var/log/secure", "file 1532 /var/log/auth.log")
  .replace("/etc/shadow 644 root root", "/etc/shadow 640 root shadow")
  .replace("/etc/gshadow 0 root root", "/etc/gshadow 640 root shadow")
  .replace("/etc/ssh/sshd_config 600 root root", "/etc/ssh/sshd_config 644 root root")
  .replace("@engine podman false", "@engine docker false");
