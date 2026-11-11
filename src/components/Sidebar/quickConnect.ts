// Interpreta "usuario@host:puerto" (también "usuario@[::1]:2222", "host", "ssh usuario@host -p 22").

export interface QuickTarget {
  username: string;
  host: string;
  port: number;
}

/** Devuelve el destino o un mensaje de error en español. */
export function parseQuickConnect(raw: string): QuickTarget | string {
  let s = raw.trim();
  if (!s) return "Escribe usuario@host";
  // Tolerar que peguen un comando ssh.
  s = s.replace(/^ssh\s+/i, "");
  let port: number | null = null;
  const pFlag = s.match(/\s-p\s*(\d+)/);
  if (pFlag) {
    port = Number(pFlag[1]);
    s = s.replace(pFlag[0], "");
  }
  s = s.replace(/^ssh:\/\//i, "").trim();
  if (/\s/.test(s)) return "Formato: usuario@host:puerto";

  const at = s.lastIndexOf("@");
  const username = at >= 0 ? s.slice(0, at) : "";
  let rest = at >= 0 ? s.slice(at + 1) : s;
  if (!username) return "Falta el usuario: usuario@host";

  let host: string;
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0) return "Dirección IPv6 incompleta";
    host = rest.slice(1, end);
    rest = rest.slice(end + 1);
    if (rest.startsWith(":")) port = Number(rest.slice(1));
    else if (rest) return "Formato: usuario@[ipv6]:puerto";
  } else {
    const colons = (rest.match(/:/g) ?? []).length;
    if (colons === 1) {
      const i = rest.indexOf(":");
      host = rest.slice(0, i);
      port = Number(rest.slice(i + 1));
    } else {
      host = rest; // sin puerto, o IPv6 sin corchetes
    }
  }
  host = host.trim();
  if (!host) return "Falta el host";
  const p = port ?? 22;
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "Puerto inválido (1-65535)";
  return { username, host, port: p };
}
