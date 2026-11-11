// Detección del lenguaje de Monaco a partir del nombre del archivo.
import { basename, extname } from "../../lib/paths";

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "shell",
  gnumakefile: "shell",
  "nginx.conf": "ini",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_aliases": "shell",
  ".bash_logout": "shell",
  ".profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  ".zshenv": "shell",
  ".env": "ini",
  ".gitconfig": "ini",
  ".gitignore": "plaintext",
  ".dockerignore": "plaintext",
  ".editorconfig": "ini",
  ".htaccess": "ini",
  "crontab": "shell",
  "authorized_keys": "plaintext",
  "known_hosts": "plaintext",
  "hosts": "plaintext",
  "fstab": "plaintext",
  "sshd_config": "ini",
  "ssh_config": "ini",
  "caddyfile": "ini",
  "jenkinsfile": "java",
  "vagrantfile": "ruby",
  "gemfile": "ruby",
  "rakefile": "ruby",
  "package.json": "json",
  "composer.json": "json",
  "tsconfig.json": "json",
  "cmakelists.txt": "plaintext",
};

const BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json", map: "json",
  html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html",
  css: "css", scss: "scss", sass: "scss", less: "less",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  yml: "yaml", yaml: "yaml",
  xml: "xml", svg: "xml", xsd: "xml", xsl: "xml", plist: "xml", csproj: "xml", pom: "xml",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", fish: "shell", command: "shell",
  ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat",
  py: "python", pyw: "python", pyi: "python",
  rb: "ruby", erb: "ruby",
  php: "php", phtml: "php",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", groovy: "java", gradle: "java",
  go: "go", rs: "rust", swift: "swift", dart: "dart",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", ino: "cpp",
  cs: "csharp", fs: "fsharp", vb: "vb",
  lua: "lua", pl: "perl", pm: "perl", r: "r", jl: "julia", ex: "elixir", exs: "elixir", clj: "clojure",
  sql: "sql", mysql: "mysql", pgsql: "pgsql",
  ini: "ini", cfg: "ini", conf: "ini", cnf: "ini", properties: "ini", env: "ini", desktop: "ini",
  service: "ini", timer: "ini", socket: "ini", mount: "ini", target: "ini", toml: "ini", inf: "ini",
  tf: "hcl", tfvars: "hcl", hcl: "hcl", nomad: "hcl",
  dockerfile: "dockerfile",
  graphql: "graphql", gql: "graphql",
  proto: "protobuf",
  twig: "twig", liquid: "liquid", hbs: "handlebars", handlebars: "handlebars", pug: "pug",
  tcl: "tcl", sol: "solidity", rst: "restructuredtext", coffee: "coffee",
  log: "plaintext", txt: "plaintext", csv: "plaintext", tsv: "plaintext",
};

/** Id de lenguaje de Monaco para una ruta remota. */
export function detectLanguage(path: string): string {
  const name = basename(path).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name.startsWith(".env")) return "ini";
  if (name.startsWith("docker-compose") || name.startsWith("compose.")) return "yaml";
  const ext = extname(name);
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  // Configuración típica de servidores
  if (/\/(nginx|apache2|httpd)\//.test(path) || /\/(sites-available|sites-enabled|conf\.d)\//.test(path)) return "ini";
  if (/\/etc\/systemd\//.test(path)) return "ini";
  if (/\/etc\/cron/.test(path)) return "shell";
  if (/(^|\/)\.?(bash|zsh)rc$/.test(name)) return "shell";
  if (/\/s?bin\//.test(path) && !ext) return "shell";
  if (name.endsWith("rc") && name.startsWith(".")) return "shell";
  return "plaintext";
}

const LABELS: Record<string, string> = {
  plaintext: "Texto plano", javascript: "JavaScript", typescript: "TypeScript", json: "JSON", html: "HTML",
  css: "CSS", scss: "SCSS", less: "Less", markdown: "Markdown", yaml: "YAML", xml: "XML", shell: "Shell",
  powershell: "PowerShell", bat: "Batch", python: "Python", ruby: "Ruby", php: "PHP", java: "Java",
  kotlin: "Kotlin", go: "Go", rust: "Rust", cpp: "C/C++", csharp: "C#", sql: "SQL", mysql: "MySQL",
  pgsql: "PostgreSQL", ini: "INI / Config", hcl: "HCL", dockerfile: "Dockerfile", lua: "Lua", perl: "Perl",
};

export function languageLabel(id: string): string {
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Lista para el selector de lenguaje del editor. */
export const LANGUAGE_CHOICES: string[] = [
  "plaintext", "shell", "ini", "yaml", "json", "xml", "markdown", "dockerfile", "javascript", "typescript",
  "html", "css", "scss", "python", "php", "ruby", "go", "rust", "java", "cpp", "csharp", "sql", "lua", "perl",
  "powershell", "hcl",
];
