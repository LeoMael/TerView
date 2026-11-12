// Datos FALSOS para las capturas del manual. Nada aquí es real: nombres, IP (rangos de documentación
// 192.0.2.0/24, 198.51.100.0/24 y 203.0.113.0/24), usuarios y dominios (example.com) son inventados.
import type { FileEntry, ProfilesData, ServerProfile, Snippet } from "../../../src/api/types";

export const SERVERS: ServerProfile[] = [
  srv("s-web", "web-prod", "203.0.113.10", "deploy", "key", "#3b82f6", "/var/www"),
  srv("s-db", "db-01", "203.0.113.21", "admin", "key", "#22c55e", null),
  srv("s-api", "api-staging", "198.51.100.30", "deploy", "password", "#f59e0b", "/srv/api"),
  srv("s-backup", "backup", "198.51.100.44", "root", "agent", null, null),
  srv("s-lab", "lab-docker", "192.0.2.15", "ana", "password", "#a855f7", null),
];

function srv(
  id: string,
  name: string,
  host: string,
  username: string,
  auth: ServerProfile["auth"],
  color: string | null,
  defaultPath: string | null,
): ServerProfile {
  return {
    id,
    name,
    host,
    port: 22,
    username,
    auth,
    keyPath: auth === "key" ? "~/.ssh/id_ed25519" : null,
    defaultPath,
    color,
    tmux: null,
    sudoMode: "ask",
  };
}

export const PROFILES: ProfilesData = {
  servers: SERVERS,
  projects: [
    {
      id: "p-tienda",
      name: "Tienda online",
      serverIds: ["s-web", "s-db", "s-api"],
      bookmarks: [
        { serverId: "s-web", path: "/var/www/tienda", label: "Web" },
        { serverId: "s-web", path: "/etc/nginx/sites-available", label: "nginx" },
        { serverId: "s-db", path: "/var/backups/postgres", label: "Copias" },
      ],
      color: "#3b82f6",
    },
    {
      id: "p-lab",
      name: "Laboratorio",
      serverIds: ["s-lab"],
      bookmarks: [],
      color: "#a855f7",
    },
  ],
};

export const SNIPPETS: Snippet[] = [
  {
    id: "sn-1",
    name: "Reiniciar la app",
    description: "Reinicia el servicio de la tienda y muestra su estado",
    command: "sudo systemctl restart {{servicio:tienda}} && systemctl status {{servicio:tienda}} --no-pager",
    category: "Mis comandos",
    scope: "project",
    scopeId: "p-tienda",
    dangerous: false,
    sudo: true,
    readOnly: false,
  },
  {
    id: "sn-2",
    name: "Últimos errores de nginx",
    description: null,
    command: "tail -n {{lineas:50}} /var/log/nginx/error.log",
    category: "Mis comandos",
    scope: "global",
    scopeId: null,
    dangerous: false,
    sudo: false,
    readOnly: true,
  },
];

const NOW = Math.floor(Date.now() / 1000);

function entry(dir: string, name: string, kind: FileEntry["kind"], size: number, ageMin: number, perm: string): FileEntry {
  const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
  return {
    name,
    path,
    kind,
    isDirLink: false,
    size,
    modified: NOW - ageMin * 60,
    permissions: parseInt(perm, 8),
    permissionsStr: permStr(kind, perm),
    uid: 1000,
    gid: 1000,
  };
}

function permStr(kind: FileEntry["kind"], perm: string): string {
  const bits = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  return (kind === "dir" ? "d" : "-") + [...perm].map((d) => bits[Number(d)]).join("");
}

export const HOME = "/home/deploy";

/** Carpetas del explorador. Lo que no esté aquí sale vacío. */
export const DIRS: Record<string, FileEntry[]> = {
  "/home/deploy": [
    entry("/home/deploy", "app", "dir", 4096, 60 * 3, "755"),
    entry("/home/deploy", "backups", "dir", 4096, 60 * 26, "750"),
    entry("/home/deploy", "logs", "dir", 4096, 12, "755"),
    entry("/home/deploy", "scripts", "dir", 4096, 60 * 72, "755"),
    entry("/home/deploy", "docker-compose.yml", "file", 1342, 60 * 5, "644"),
    entry("/home/deploy", "deploy.sh", "file", 2210, 60 * 30, "755"),
    entry("/home/deploy", "README.md", "file", 3876, 60 * 240, "644"),
    entry("/home/deploy", ".env", "file", 412, 60 * 48, "600"),
  ],
  "/var/www": [
    entry("/var/www", "tienda", "dir", 4096, 30, "755"),
    entry("/var/www", "blog", "dir", 4096, 60 * 24 * 3, "755"),
    entry("/var/www", "html", "dir", 4096, 60 * 24 * 40, "755"),
  ],
  "/var/www/tienda": [
    entry("/var/www/tienda", "assets", "dir", 4096, 60 * 2, "755"),
    entry("/var/www/tienda", "config", "dir", 4096, 60 * 24, "750"),
    entry("/var/www/tienda", "public", "dir", 4096, 35, "755"),
    entry("/var/www/tienda", "src", "dir", 4096, 35, "755"),
    entry("/var/www/tienda", "uploads", "dir", 4096, 8, "775"),
    entry("/var/www/tienda", ".env.production", "file", 688, 60 * 24 * 2, "600"),
    entry("/var/www/tienda", "composer.json", "file", 1820, 60 * 24 * 9, "644"),
    entry("/var/www/tienda", "index.php", "file", 1054, 60 * 24 * 9, "644"),
    entry("/var/www/tienda", "nginx.conf", "file", 1532, 60 * 50, "644"),
    entry("/var/www/tienda", "logo.png", "file", 48211, 60 * 24 * 20, "644"),
    entry("/var/www/tienda", "catalogo-2026.csv", "file", 2_480_113, 60 * 4, "644"),
    entry("/var/www/tienda", "release-1.8.2.tar.gz", "file", 18_734_220, 60 * 26, "644"),
  ],
};

export const NGINX_CONF = `server {
    listen 80;
    server_name tienda.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tienda.example.com;

    root /var/www/tienda/public;
    index index.php;

    ssl_certificate     /etc/letsencrypt/live/tienda.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tienda.example.com/privkey.pem;

    client_max_body_size 32m;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_set_header Host $host;
    }
}
`;

export const COMPOSE = `services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    volumes:
      - ./public:/usr/share/nginx/html:ro
    restart: unless-stopped

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: tienda
      POSTGRES_USER: tienda
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`;

// ───────── Asistentes de IA (MCP) ─────────
export const MCP_STATUS = {
  enabled: true,
  running: true,
  port: 47321,
  url: "http://127.0.0.1:47321/mcp",
  error: null,
  approvalTimeoutSecs: 120,
  bridgePath: "/usr/bin/terview-mcp",
  bridgeFound: true,
  appImage: false,
  auditPath: "~/.local/share/terview/mcp-audit.jsonl",
};

export const MCP_CONFIG = {
  enabled: true,
  port: 47321,
  approvalTimeoutSecs: 120,
  access: { "s-web": "read", "s-api": "full", "s-lab": "full" } as Record<string, "none" | "read" | "full">,
  remembered: { "s-api": ["exec:systemctl status api"] } as Record<string, string[]>,
};

const TOKEN = "tv_ejemplo_0000000000000000000000000000";

export const MCP_CLIENT = {
  claudeCodeStdio: `claude mcp add --env TERVIEW_MCP_TOKEN=${TOKEN} --transport stdio terview -- /usr/bin/terview-mcp`,
  claudeCodeHttp: `claude mcp add --transport http terview http://127.0.0.1:47321/mcp --header "Authorization: Bearer ${TOKEN}"`,
  claudeDesktopJson: JSON.stringify(
    { mcpServers: { terview: { command: "/usr/bin/terview-mcp", args: [], env: { TERVIEW_MCP_TOKEN: TOKEN } } } },
    null,
    2,
  ),
  url: "http://127.0.0.1:47321/mcp",
  token: TOKEN,
};

export const MCP_ACTIVITY = [
  {
    id: "a1",
    at: Date.now() - 1000 * 60 * 4,
    tool: "run_command",
    serverId: "s-api",
    serverName: "api-staging",
    detail: "systemctl status api --no-pager",
    status: "ok",
    approvedBy: "rule",
    message: null,
    durationMs: 420,
    client: "claude-code",
  },
  {
    id: "a2",
    at: Date.now() - 1000 * 60 * 2,
    tool: "read_file",
    serverId: "s-web",
    serverName: "web-prod",
    detail: "/etc/nginx/sites-available/tienda",
    status: "ok",
    approvedBy: null,
    message: null,
    durationMs: 95,
    client: "claude-code",
  },
];

export const PHP = `<?php
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Tienda\\App;
use Tienda\\Config;

$config = Config::fromEnv(__DIR__ . '/.env.production');
$app = new App($config);

$app->run();
`;
