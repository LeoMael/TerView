// Respuestas simuladas de transferencias, túneles, GitHub e IA (datos falsos).
type Args = Record<string, unknown> | undefined;

const NOW = Date.now();
const MB = 1024 * 1024;

function job(
  id: string,
  batchId: string,
  direction: "upload" | "download",
  name: string,
  size: number,
  transferred: number,
  status: "queued" | "running" | "done" | "error",
  speed = 0,
) {
  const remote = direction === "upload" ? `/var/www/tienda/uploads/${name}` : `/var/backups/postgres/${name}`;
  const local = direction === "upload" ? `/home/usuario/Imágenes/${name}` : `/home/usuario/Descargas/${name}`;
  return {
    id,
    batchId,
    sessionId: "sess-1",
    direction,
    localPath: local,
    remotePath: remote,
    name,
    size,
    transferred,
    status,
    error: status === "error" ? "Permiso denegado" : null,
    speed,
    createdAt: NOW - 60_000,
    finishedAt: status === "done" ? NOW - 20_000 : null,
  };
}

export const JOBS = [
  job("j1", "b1", "upload", "fotos/portada.jpg", 3.2 * MB, 3.2 * MB, "done"),
  job("j2", "b1", "upload", "fotos/producto-001.jpg", 2.4 * MB, 2.4 * MB, "done"),
  job("j3", "b1", "upload", "fotos/producto-002.jpg", 2.6 * MB, 1.7 * MB, "running", 6.8 * MB),
  job("j4", "b1", "upload", "fotos/producto-003.jpg", 2.1 * MB, 0.6 * MB, "running", 5.9 * MB),
  job("j5", "b1", "upload", "fotos/producto-004.jpg", 2.9 * MB, 0, "queued"),
  job("j6", "b1", "upload", "fotos/producto-005.jpg", 3.4 * MB, 0, "queued"),
  job("j7", "b2", "download", "tienda-2026-11-12.sql.gz", 148 * MB, 148 * MB, "done"),
];

const TUNNELS = [
  { id: "t1", profileId: "s-web", name: "PostgreSQL", kind: "local", bindHost: "127.0.0.1", bindPort: 5432, destHost: "127.0.0.1", destPort: 5432, autoStart: true },
  { id: "t2", profileId: "s-web", name: "Panel de administración", kind: "local", bindHost: "127.0.0.1", bindPort: 8080, destHost: "127.0.0.1", destPort: 8080, autoStart: false },
  { id: "t3", profileId: "s-web", name: "Navegar por el servidor", kind: "socks", bindHost: "127.0.0.1", bindPort: 1080, destHost: "", destPort: 0, autoStart: false },
  { id: "t4", profileId: "s-web", name: "Mi app local para pruebas", kind: "remote", bindHost: "127.0.0.1", bindPort: 9000, destHost: "127.0.0.1", destPort: 3000, autoStart: false },
];

function tunnelStatus(sessionId: string, tunnelId: string, port: number, conns: number, up: number, down: number) {
  return {
    sessionId,
    tunnelId,
    state: "active",
    message: null,
    lastError: null,
    connections: conns,
    totalConnections: conns + 7,
    bytesUp: up,
    bytesDown: down,
    boundPort: port,
    startedAt: NOW - 1000 * 60 * 42,
  };
}

const GH_ACCOUNT = {
  login: "ana-dev",
  name: "Ana Pérez",
  htmlUrl: "https://github.com/ana-dev",
  avatarData: null,
  publicRepos: 12,
  privateRepos: 4,
  tokenKind: "fine-grained",
  scopes: null,
  tokenExpires: "2027-03-01",
  rateLimit: 5000,
  rateRemaining: 4987,
};

function repo(name: string, desc: string, priv: boolean, daysAgo: number) {
  return {
    fullName: `ana-dev/${name}`,
    name,
    owner: "ana-dev",
    private: priv,
    archived: false,
    fork: false,
    defaultBranch: "main",
    sshUrl: `git@github.com:ana-dev/${name}.git`,
    cloneUrl: `https://github.com/ana-dev/${name}.git`,
    htmlUrl: `https://github.com/ana-dev/${name}`,
    description: desc,
    pushedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  };
}

const REPOS = [
  repo("tienda", "Tienda online (PHP + PostgreSQL)", true, 0),
  repo("api", "API de pedidos en Node.js", true, 2),
  repo("infra", "Scripts de despliegue y copias de seguridad", true, 6),
  repo("blog", "Blog estático", false, 21),
  repo("dotfiles", "Mi configuración de terminal", false, 60),
];

export const respuestas: Record<string, (a: Args) => unknown> = {
  // Solo en su escena: en las demás la barra de transferencias queda vacía.
  transfer_list: () => (new URLSearchParams(location.search).get("escena") === "transferencias" ? JOBS : []),
  transfer_batch_finished: (a) => a?.batchId === "b2",

  tunnels_list: (a) => TUNNELS.filter((t) => t.profileId === a?.profileId),
  tunnels_status: (a) => {
    const s = String(a?.sessionId);
    return [tunnelStatus(s, "t1", 5432, 2, 184_000, 2_400_000), tunnelStatus(s, "t3", 1080, 1, 52_000, 940_000)];
  },

  gh_status: () => ({ connected: true, deviceFlow: true }),
  gh_account: () => GH_ACCOUNT,
  gh_repos: () => REPOS,
  gh_my_keys: () => [
    { id: 1, key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEjemploEjemploEjemplo portatil", title: "Portátil", createdAt: "2025-02-11T10:00:00Z" },
  ],
  gh_local_pubkeys: () => [],
  gh_config_load: () => ({ recipes: [], sync: null }),

  ai_status: () => ({ hasToken: false, locked: false }),
};
