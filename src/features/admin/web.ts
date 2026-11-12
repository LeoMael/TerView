// Sitios web del servidor: lee la configuración de nginx y de Caddy y la resume por sitio
// (dominios, puertos, HTTPS y certificado, a qué sirve cada ruta). Funciones puras, sin React ni Tauri.
import { shQuote } from "./shell";

/**
 * Script de lectura. nginx: `nginx -T` (configuración completa, necesita root casi siempre); si falla,
 * se leen los archivos de la carpeta de configuración con el mismo formato. Caddy: configuración en
 * vivo por su API local o, si no responde, `caddy adapt` del Caddyfile.
 *
 * Secciones (las de configuración conservan las líneas vacías: se usan sus números de línea):
 *   @@svc «nombre estado» · @@nginx «bin src confpath» · @@nginxconf · @@certs «ruta|caducidad»
 *   @@caddy «bin src caddyfile» · @@caddyjson
 */
export const WEB_SCRIPT = [
  "PATH=$PATH:/usr/sbin:/sbin:/usr/local/sbin",
  "echo @@svc",
  // Solo si existe la unidad (si no, «is-active» diría «inactive» de un servicio que no existe).
  "if command -v systemctl >/dev/null 2>&1; then for s in nginx caddy; do systemctl cat $s >/dev/null 2>&1 && echo \"$s $(systemctl is-active $s 2>/dev/null)\"; done; fi",
  "if command -v nginx >/dev/null 2>&1; then",
  "  cp=$(nginx -V 2>&1 | grep -oE -- '--conf-path=[^ ]+' | head -n1 | cut -d= -f2)",
  "  [ -n \"$cp\" ] || cp=/etc/nginx/nginx.conf",
  "  if out=$(nginx -T 2>/dev/null) && printf '%s\\n' \"$out\" | grep -q '^# configuration file '; then src=dump",
  "  else",
  "    src=files; d=$(dirname \"$cp\")",
  "    out=$(for f in \"$cp\" $(find -L \"$d\" -type f \\( -name '*.conf' -o -path '*/sites-enabled/*' \\) ! -path \"$cp\" 2>/dev/null | sort); do",
  "      [ -r \"$f\" ] && { echo \"# configuration file $f:\"; cat \"$f\"; echo; }",
  "    done)",
  "  fi",
  "  echo @@nginx; echo \"nginx $src $cp\"",
  "  echo @@nginxconf; printf '%s\\n' \"$out\"",
  "  echo @@certs",
  "  if command -v openssl >/dev/null 2>&1; then",
  "    for c in $(printf '%s\\n' \"$out\" | sed -n 's/^[[:space:]]*ssl_certificate[[:space:]][[:space:]]*\\([^;]*\\);.*/\\1/p' | tr -d \"\\\"'\" | grep -v '\\$' | sort -u); do",
  "      e=$(openssl x509 -noout -enddate -in \"$c\" 2>/dev/null | cut -d= -f2)",
  "      echo \"$c|$e\"",
  "    done",
  "  fi",
  "fi",
  "if command -v caddy >/dev/null 2>&1; then",
  "  cf=$(systemctl cat caddy 2>/dev/null | grep -oE -- '--config[= ][^ ]+' | head -n1 | sed 's/^--config[= ]//')",
  "  [ -n \"$cf\" ] || cf=/etc/caddy/Caddyfile",
  "  j=''; src=api",
  "  if command -v curl >/dev/null 2>&1; then j=$(curl -sf --max-time 3 http://127.0.0.1:2019/config/ 2>/dev/null)",
  "  elif command -v wget >/dev/null 2>&1; then j=$(wget -qO- -T 3 http://127.0.0.1:2019/config/ 2>/dev/null); fi",
  "  if [ -z \"$j\" ] || [ \"$j\" = null ]; then src=adapt; j=$(caddy adapt --config \"$cf\" 2>/dev/null); fi",
  "  echo @@caddy; echo \"caddy $src $cf\"",
  "  echo @@caddyjson; printf '%s\\n' \"$j\"",
  "fi",
  "echo @@end",
].join("\n");

/** Como splitSections, pero conserva las líneas vacías (para numerar líneas de archivos). */
export function splitSectionsRaw(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^@@([a-z]+)$/.exec(line);
    if (m) {
      cur = [];
      out.set(m[1], cur);
      continue;
    }
    if (cur) cur.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Resultado común
// ---------------------------------------------------------------------------------------------

export type WebServer = "nginx" | "caddy";

/** A qué sirve una ruta del sitio. */
export type Target =
  | { kind: "proxy"; url: string; host: string | null; port: number | null; socket: string | null }
  | { kind: "files"; root: string }
  | { kind: "redirect"; to: string; code: number | null }
  | { kind: "fastcgi"; addr: string; host: string | null; port: number | null }
  | { kind: "other"; text: string };

export interface SiteRoute {
  /** «/», «/api/», «~ \.php$»… */
  path: string;
  target: Target;
}

export interface Listen {
  /** null = todas las interfaces. */
  host: string | null;
  port: number;
  https: boolean;
}

export interface Site {
  key: string;
  server: WebServer;
  /** Dominios (vacío = cualquiera / sitio por defecto). */
  names: string[];
  listens: Listen[];
  https: boolean;
  isDefault: boolean;
  /** Ruta del certificado (nginx). */
  cert: string | null;
  /** Caducidad del certificado (ms desde 1970) si se pudo leer. */
  certExpires: number | null;
  routes: SiteRoute[];
  /** Archivo y línea donde se define. */
  file: string | null;
  line: number | null;
}

export interface ServerInfo {
  server: WebServer;
  /** De dónde salió la configuración. */
  source: "dump" | "files" | "api" | "adapt";
  /** Archivo principal (nginx.conf o Caddyfile). */
  configPath: string;
  /** Estado del servicio systemd (active, inactive, failed…) o null si no hay systemd o no existe la unidad. */
  status: string | null;
  sites: Site[];
  /** Problemas al leer la configuración. */
  warning: string | null;
}

export interface WebResult {
  servers: ServerInfo[];
}

// ---------------------------------------------------------------------------------------------
// nginx
// ---------------------------------------------------------------------------------------------

export interface NgxDirective {
  name: string;
  args: string[];
  block: NgxDirective[] | null;
  file: string;
  line: number;
}

interface Tok {
  t: string;
  /** Palabra (no { } ;). Las comillas ya se quitaron. */
  word: boolean;
  line: number;
}

/**
 * Quita los escapes de una palabra como lo hace nginx (igual dentro y fuera de comillas): «\"», «\'» y
 * «\\» dejan solo el carácter; «\t», «\r», «\n» son tabulador y saltos; cualquier otra barra se
 * conserva (así «location ~ \.php$» sigue siendo la expresión regular «\.php$»).
 */
export function unescapeNginx(raw: string): string {
  let w = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      const d = raw[i + 1];
      if (d === '"' || d === "'" || d === "\\") {
        w += d;
        i++;
        continue;
      }
      if (d === "t" || d === "r" || d === "n") {
        w += d === "t" ? "\t" : d === "r" ? "\r" : "\n";
        i++;
        continue;
      }
    }
    w += c;
  }
  return w;
}

/** Separa un archivo de nginx en palabras, «{», «}» y «;» (comentarios, comillas y ${var}). */
export function tokenizeNginx(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{" || c === "}" || c === ";") {
      out.push({ t: c, word: false, line });
      i++;
      continue;
    }
    const start = line;
    let raw = "";
    if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c) {
        // La barra protege el carácter siguiente (p. ej. una comilla); se interpreta al final.
        if (text[i] === "\\" && i + 1 < n) {
          if (text[i + 1] === "\n") line++;
          raw += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === "\n") line++;
        raw += text[i++];
      }
      i++;
      out.push({ t: unescapeNginx(raw), word: true, line: start });
      continue;
    }
    while (i < n) {
      const d = text[i];
      if (d === " " || d === "\t" || d === "\n" || d === "\r" || d === ";" || d === "{" || d === "}") {
        // «${var}» forma parte de la palabra.
        if (d === "{" && raw.endsWith("$")) {
          const end = text.indexOf("}", i);
          if (end < 0) break;
          raw += text.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        break;
      }
      // «\;», «\ » o «\{» no cortan la palabra.
      if (d === "\\" && i + 1 < n) {
        if (text[i + 1] === "\n") line++;
        raw += d + text[i + 1];
        i += 2;
        continue;
      }
      raw += d;
      i++;
    }
    out.push({ t: unescapeNginx(raw), word: true, line: start });
  }
  return out;
}

/** Árbol de directivas de un archivo. Tolera llaves sin cerrar (devuelve lo leído). */
export function parseNginxFile(text: string, file: string): NgxDirective[] {
  const toks = tokenizeNginx(text);
  let i = 0;
  const parseBlock = (): NgxDirective[] => {
    const out: NgxDirective[] = [];
    while (i < toks.length) {
      const t = toks[i];
      if (!t.word && t.t === "}") {
        i++;
        return out;
      }
      if (!t.word) {
        i++;
        continue;
      }
      const name = t.t;
      const line = t.line;
      const args: string[] = [];
      i++;
      while (i < toks.length && toks[i].word) args.push(toks[i++].t);
      if (i >= toks.length) {
        out.push({ name, args, block: null, file, line });
        break;
      }
      const end = toks[i];
      i++;
      if (end.t === "{") out.push({ name, args, block: parseBlock(), file, line });
      else if (end.t === ";") out.push({ name, args, block: null, file, line });
      else {
        // «}» sin «;»: directiva mal cerrada; se devuelve al bloque padre.
        out.push({ name, args, block: null, file, line });
        return out;
      }
    }
    return out;
  };
  return parseBlock();
}

/** Separa la salida de `nginx -T` (o su imitación) en archivo → contenido. */
export function splitNginxDump(lines: string[]): Map<string, string> {
  const files = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of lines) {
    const m = /^# configuration file (.+):$/.exec(line);
    if (m) {
      cur = [];
      files.set(m[1], cur);
      continue;
    }
    if (cur) cur.push(line);
  }
  const out = new Map<string, string>();
  for (const [k, v] of files) out.set(k, v.join("\n"));
  return out;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/**
 * Árbol completo a partir del archivo principal, sustituyendo cada `include` por el contenido de los
 * archivos que coinciden (rutas relativas: respecto a la carpeta del archivo principal, como nginx).
 */
export function resolveNginx(files: Map<string, string>, main: string): NgxDirective[] {
  const parsed = new Map<string, NgxDirective[]>();
  const get = (f: string) => {
    let p = parsed.get(f);
    if (!p) {
      p = parseNginxFile(files.get(f) ?? "", f);
      parsed.set(f, p);
    }
    return p;
  };
  const prefix = dirname(main);
  const names = [...files.keys()];
  const expand = (dirs: NgxDirective[], stack: string[]): NgxDirective[] => {
    const out: NgxDirective[] = [];
    for (const d of dirs) {
      if (d.name === "include" && !d.block && d.args[0]) {
        const pat = d.args[0].startsWith("/") ? d.args[0] : `${prefix}/${d.args[0]}`;
        const re = globToRegExp(pat);
        const matches = names.filter((f) => re.test(f)).sort();
        for (const f of matches) {
          if (stack.includes(f)) continue;
          out.push(...expand(get(f), [...stack, f]));
        }
        continue;
      }
      out.push(d.block ? { ...d, block: expand(d.block, stack) } : d);
    }
    return out;
  };
  const first = files.has(main) ? main : (names[0] ?? main);
  return expand(get(first), [first]);
}

/** «http://127.0.0.1:3000/api» → host/puerto (o socket unix). */
export function parseUpstreamUrl(url: string): { host: string | null; port: number | null; socket: string | null } {
  const m = /^(?:(https?|grpcs?|uwsgi|fastcgi):\/\/)?(.*)$/i.exec(url.trim());
  const scheme = (m?.[1] ?? "").toLowerCase();
  let rest = m?.[2] ?? url;
  if (rest.startsWith("unix:")) {
    const sock = rest.slice(5).replace(/:.*$/, "");
    return { host: null, port: null, socket: sock || null };
  }
  rest = rest.replace(/[/?#].*$/, "");
  if (!rest || rest.includes("$")) return { host: null, port: null, socket: null };
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort(scheme), socket: null };
  const i = rest.lastIndexOf(":");
  if (i > 0 && /^\d+$/.test(rest.slice(i + 1))) return { host: rest.slice(0, i), port: Number(rest.slice(i + 1)), socket: null };
  return { host: rest, port: defaultPort(scheme), socket: null };
}

function defaultPort(scheme: string): number | null {
  if (scheme === "http") return 80;
  if (scheme === "https") return 443;
  return null;
}

/** `listen 443 ssl`, `listen [::]:80 default_server`, `listen 127.0.0.1:8080`. */
export function parseNginxListen(args: string[]): Listen & { isDefault: boolean } {
  const a = args[0] ?? "80";
  const https = args.includes("ssl") || args.includes("quic") || args.includes("http3");
  const isDefault = args.includes("default_server") || args.includes("default");
  if (a.startsWith("unix:")) return { host: a, port: 0, https, isDefault };
  if (/^\d+$/.test(a)) return { host: null, port: Number(a), https, isDefault };
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: v6[1] === "::" ? null : v6[1], port: v6[2] ? Number(v6[2]) : 80, https, isDefault };
  const i = a.lastIndexOf(":");
  const host = i > 0 ? a.slice(0, i) : a;
  const port = i > 0 ? Number(a.slice(i + 1)) : 80;
  return { host: host === "*" || host === "0.0.0.0" ? null : host, port: Number.isFinite(port) ? port : 80, https, isDefault };
}

const first = (dirs: NgxDirective[], name: string) => dirs.find((d) => d.name === name && !d.block) ?? null;

function ngxTarget(dirs: NgxDirective[], upstreams: Map<string, string[]>, inheritedRoot: string | null): Target | null {
  const proxy = dirs.find((d) => /^(proxy|grpc|uwsgi|scgi)_pass$/.test(d.name));
  if (proxy?.args[0]) {
    const url = proxy.args[0];
    // proxy_pass http://nombre_de_upstream → primer servidor del upstream.
    const name = url.replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
    const ups = upstreams.get(name);
    const resolved = ups && ups.length ? ups[0] : null;
    const scheme = /^([a-z]+):\/\//i.exec(url)?.[1] ?? "http";
    const u = parseUpstreamUrl(resolved ? (resolved.startsWith("unix:") ? resolved : `${scheme}://${resolved}`) : url);
    return { kind: "proxy", url: resolved ? `${url} → ${ups!.join(", ")}` : url, ...u };
  }
  const fcgi = first(dirs, "fastcgi_pass");
  if (fcgi?.args[0]) {
    const u = parseUpstreamUrl(fcgi.args[0]);
    return { kind: "fastcgi", addr: fcgi.args[0], host: u.host, port: u.port };
  }
  const ret = first(dirs, "return");
  if (ret) {
    const code = /^\d{3}$/.test(ret.args[0] ?? "") ? Number(ret.args[0]) : null;
    const to = code === null ? (ret.args[0] ?? "") : (ret.args[1] ?? "");
    if (code !== null && (code < 300 || code >= 400)) return { kind: "other", text: `responde ${code}${to ? ` «${to}»` : ""}` };
    return { kind: "redirect", to, code };
  }
  const alias = first(dirs, "alias");
  if (alias?.args[0]) return { kind: "files", root: alias.args[0] };
  const root = first(dirs, "root");
  if (root?.args[0]) return { kind: "files", root: root.args[0] };
  if (inheritedRoot) return { kind: "files", root: inheritedRoot };
  return null;
}

function collectLocations(
  dirs: NgxDirective[],
  upstreams: Map<string, string[]>,
  root: string | null,
  out: SiteRoute[],
  parent = "",
): void {
  for (const d of dirs) {
    if (d.name !== "location" || !d.block) continue;
    const path = `${parent ? `${parent} › ` : ""}${d.args.join(" ")}`;
    const ownRoot = first(d.block, "root")?.args[0] ?? root;
    const t = ngxTarget(d.block, upstreams, ownRoot);
    if (t) out.push({ path, target: t });
    collectLocations(d.block, upstreams, ownRoot, out, path);
  }
}

export function sitesFromNginx(tree: NgxDirective[], certs: Map<string, number | null>): Site[] {
  const http = tree.filter((d) => d.name === "http" && d.block).flatMap((d) => d.block!);
  const upstreams = new Map<string, string[]>();
  for (const d of http) {
    if (d.name === "upstream" && d.block && d.args[0]) {
      upstreams.set(
        d.args[0],
        d.block.filter((s) => s.name === "server" && s.args[0]).map((s) => s.args[0]),
      );
    }
  }
  const httpCert = first(http, "ssl_certificate")?.args[0] ?? null;
  const sites: Site[] = [];
  for (const srv of http) {
    if (srv.name !== "server" || !srv.block) continue;
    const b = srv.block;
    const lst = b.filter((d) => d.name === "listen").map((d) => parseNginxListen(d.args));
    const listens: Listen[] = lst.length ? lst.map(({ host, port, https }) => ({ host, port, https })) : [{ host: null, port: 80, https: false }];
    const names = b
      .filter((d) => d.name === "server_name")
      .flatMap((d) => d.args)
      .filter((n) => n && n !== "_" && n !== '""');
    const https = listens.some((l) => l.https) || first(b, "ssl")?.args[0] === "on";
    const root = first(b, "root")?.args[0] ?? null;
    const routes: SiteRoute[] = [];
    // Lo que se hace a nivel de servidor (p. ej. «return 301 https://…» de los sitios que solo redirigen).
    const top = ngxTarget(b.filter((d) => d.name !== "root"), upstreams, null);
    if (top) routes.push({ path: "(todo el sitio)", target: top });
    collectLocations(b, upstreams, root, routes);
    if (routes.length === 0 && root) routes.push({ path: "/", target: { kind: "files", root } });
    const cert = https ? (first(b, "ssl_certificate")?.args[0] ?? httpCert) : null;
    sites.push({
      key: `nginx|${srv.file}|${srv.line}`,
      server: "nginx",
      names,
      listens,
      https,
      isDefault: lst.some((l) => l.isDefault),
      cert,
      certExpires: cert ? (certs.get(cert) ?? null) : null,
      routes,
      file: srv.file,
      line: srv.line,
    });
  }
  return sites;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** «Mar  5 12:00:00 2027 GMT» (openssl -enddate) → ms. */
export function parseOpensslDate(s: string): number | null {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]);
  if (mon < 0) return null;
  return Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

export function parseCerts(lines: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const l of lines) {
    const i = l.lastIndexOf("|");
    if (i <= 0) continue;
    out.set(l.slice(0, i), parseOpensslDate(l.slice(i + 1)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Caddy (configuración JSON)
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

/** «:443», «0.0.0.0:80», «[::1]:8080», «tcp/:443» → host/puerto. */
export function parseCaddyListen(s: string): { host: string | null; port: number } | null {
  const a = s.replace(/^[a-z0-9]+\//i, "");
  const i = a.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(a.slice(i + 1).replace(/-.*$/, ""));
  if (!Number.isFinite(port) || port <= 0) return null;
  const host = a.slice(0, i).replace(/^\[|\]$/g, "");
  return { host: host && host !== "0.0.0.0" && host !== "::" ? host : null, port };
}

/** Añade a `out` lo que hacen los manejadores y devuelve la carpeta raíz vigente al terminar. */
function caddyTargets(handlers: unknown[], path: string, root: string | null, out: SiteRoute[]): string | null {
  let curRoot = root;
  for (const h of handlers) {
    if (!isObj(h)) continue;
    switch (h.handler) {
      case "vars":
        if (typeof h.root === "string") curRoot = h.root;
        break;
      case "reverse_proxy": {
        const dials = arr(h.upstreams)
          .map((u) => (isObj(u) && typeof u.dial === "string" ? u.dial : null))
          .filter((d): d is string => !!d);
        const tr = isObj(h.transport) ? h.transport : null;
        const fastcgi = tr?.protocol === "fastcgi";
        const u = parseUpstreamUrl(dials[0] ?? "");
        if (fastcgi) out.push({ path, target: { kind: "fastcgi", addr: dials.join(", "), host: u.host, port: u.port } });
        else out.push({ path, target: { kind: "proxy", url: dials.join(", ") || "(dinámico)", ...u } });
        break;
      }
      case "file_server":
        out.push({ path, target: { kind: "files", root: typeof h.root === "string" ? h.root : (curRoot ?? "(carpeta actual)") } });
        break;
      case "static_response": {
        const headers = isObj(h.headers) ? h.headers : {};
        const loc = strs(headers.Location)[0];
        const code = typeof h.status_code === "number" ? h.status_code : Number(h.status_code) || null;
        if (loc) out.push({ path, target: { kind: "redirect", to: loc, code } });
        else out.push({ path, target: { kind: "other", text: `responde ${code ?? 200}` } });
        break;
      }
      case "subroute":
        for (const r of arr(h.routes)) {
          if (!isObj(r)) continue;
          const paths = arr(r.match).flatMap((m) => (isObj(m) ? strs(m.path) : []));
          const p = paths.length ? paths.join(", ") : path;
          const after = caddyTargets(arr(r.handle), p, curRoot, out);
          // «root * /srv» (vars sin condición) vale para las rutas siguientes del mismo bloque.
          if (arr(r.match).length === 0) curRoot = after;
        }
        break;
    }
  }
  return curRoot;
}

export function sitesFromCaddy(cfg: unknown, configPath: string): Site[] {
  const servers = isObj(cfg) && isObj(cfg.apps) && isObj(cfg.apps.http) && isObj(cfg.apps.http.servers) ? cfg.apps.http.servers : {};
  const byHost = new Map<string, Site>();
  const order: Site[] = [];
  for (const [name, srv] of Object.entries(servers)) {
    if (!isObj(srv)) continue;
    const listens = strs(srv.listen)
      .map(parseCaddyListen)
      .filter((l): l is { host: string | null; port: number } => !!l);
    const auto = isObj(srv.automatic_https) ? srv.automatic_https : {};
    const tls = arr(srv.tls_connection_policies).length > 0 || listens.some((l) => l.port === 443);
    const https = tls && auto.disable !== true;
    // Sin dominios, Caddy pone las rutas directamente en el servidor: «root * /srv» es una ruta suelta
    // (vars sin condición) que vale para las siguientes.
    let srvRoot: string | null = null;
    for (const route of arr(srv.routes)) {
      if (!isObj(route)) continue;
      const hosts = arr(route.match).flatMap((m) => (isObj(m) ? strs(m.host) : []));
      const paths = arr(route.match).flatMap((m) => (isObj(m) ? strs(m.path) : []));
      const routes: SiteRoute[] = [];
      const after = caddyTargets(arr(route.handle), paths.length ? paths.join(", ") : "/", srvRoot, routes);
      if (arr(route.match).length === 0) srvRoot = after;
      const k = `caddy|${name}|${[...hosts].sort().join(",")}`;
      let site = byHost.get(k);
      if (!site && routes.length === 0 && hosts.length === 0) continue;
      if (!site) {
        site = {
          key: k,
          server: "caddy",
          names: hosts,
          listens: listens.map((l) => ({ ...l, https: https && l.port !== 80 })),
          https,
          isDefault: hosts.length === 0,
          cert: null,
          certExpires: null,
          routes: [],
          file: configPath,
          line: null,
        };
        byHost.set(k, site);
        order.push(site);
      }
      site.routes.push(...routes);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------------------------
// Lectura completa
// ---------------------------------------------------------------------------------------------

export function parseWeb(stdout: string): WebResult {
  const s = splitSectionsRaw(stdout);
  const svc = new Map<string, string>();
  for (const l of s.get("svc") ?? []) {
    const [n, st] = l.trim().split(/\s+/);
    if (n && st) svc.set(n, st);
  }
  const servers: ServerInfo[] = [];

  const ng = (s.get("nginx") ?? []).find((l) => l.trim())?.trim().split(/\s+/);
  if (ng) {
    const source = ng[1] === "dump" ? "dump" : "files";
    const configPath = ng.slice(2).join(" ") || "/etc/nginx/nginx.conf";
    const files = splitNginxDump(s.get("nginxconf") ?? []);
    let sites: Site[] = [];
    let warning: string | null = null;
    if (files.size === 0) warning = "No se pudo leer la configuración de nginx (¿falta permiso? Prueba con sudo).";
    else {
      try {
        sites = sitesFromNginx(resolveNginx(files, configPath), parseCerts((s.get("certs") ?? []).filter((l) => l.trim())));
      } catch (e) {
        warning = `No se pudo interpretar la configuración: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!warning && source === "files")
        warning = "Configuración leída de los archivos (sin root no se puede usar «nginx -T»): puede faltar algún archivo sin permiso de lectura.";
    }
    servers.push({ server: "nginx", source, configPath, status: svc.get("nginx") ?? null, sites, warning });
  }

  const cd = (s.get("caddy") ?? []).find((l) => l.trim())?.trim().split(/\s+/);
  if (cd) {
    const source = cd[1] === "api" ? "api" : "adapt";
    const configPath = cd.slice(2).join(" ") || "/etc/caddy/Caddyfile";
    const text = (s.get("caddyjson") ?? []).join("\n").trim();
    let sites: Site[] = [];
    let warning: string | null = null;
    if (!text || text === "null") warning = "No se pudo leer la configuración de Caddy (ni por su API local ni con «caddy adapt»).";
    else {
      try {
        sites = sitesFromCaddy(JSON.parse(text), configPath);
      } catch {
        warning = "La configuración de Caddy no es un JSON válido.";
      }
    }
    servers.push({ server: "caddy", source, configPath, status: svc.get("caddy") ?? null, sites, warning });
  }
  return { servers };
}

// ---------------------------------------------------------------------------------------------
// Comprobar y recargar
// ---------------------------------------------------------------------------------------------

/** Comprueba la configuración sin aplicar nada. */
export function checkScript(info: Pick<ServerInfo, "server" | "configPath">): string {
  const path = "PATH=$PATH:/usr/sbin:/sbin:/usr/local/sbin";
  if (info.server === "nginx") return `${path}\nnginx -t -c ${shQuote(info.configPath)} 2>&1`;
  return `${path}\ncaddy validate --config ${shQuote(info.configPath)} 2>&1`;
}

/**
 * Pasos para recargar sin cortar las conexiones (primero se comprueba la configuración). Con systemd solo
 * si el servicio está en marcha por systemd; si no (arrancado a mano, contenedor…), con el propio programa.
 */
export function reloadSteps(info: Pick<ServerInfo, "server" | "configPath" | "status">): string[] {
  const q = shQuote(info.configPath);
  const systemd = info.status === "active";
  if (info.server === "nginx") {
    return [`nginx -t -c ${q}`, systemd ? "systemctl reload nginx" : `nginx -s reload -c ${q}`];
  }
  return [`caddy validate --config ${q}`, systemd ? "systemctl reload caddy" : `caddy reload --config ${q}`];
}

/** Texto de los días que faltan para que caduque un certificado. */
export function certStatus(expires: number | null, now = Date.now()): { text: string; level: "ok" | "warn" | "bad" } | null {
  if (expires === null) return null;
  const days = Math.floor((expires - now) / 86_400_000);
  if (days < 0) return { text: `caducó hace ${-days} ${-days === 1 ? "día" : "días"}`, level: "bad" };
  if (days === 0) return { text: "caduca hoy", level: "bad" };
  return { text: `caduca en ${days} ${days === 1 ? "día" : "días"}`, level: days < 14 ? "bad" : days < 30 ? "warn" : "ok" };
}
