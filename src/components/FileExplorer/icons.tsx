// Ícono por tipo / extensión de archivo.
import {
  File as FileIcon,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileDatabase,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileVideoCamera,
  Folder,
  FolderSymlink,
  type LucideIcon,
} from "lucide-react";
import type { FileEntry } from "../../api/types";
import { extname } from "../../lib/paths";

type Kind = "image" | "archive" | "code" | "shell" | "json" | "config" | "text" | "sheet" | "video" | "audio" | "key" | "db" | "lock";

const EXT: Record<string, Kind> = {};
const add = (kind: Kind, exts: string) => exts.split(" ").forEach((e) => (EXT[e] = kind));
add("image", "png jpg jpeg gif webp svg bmp ico tif tiff avif heic psd");
add("archive", "zip tar gz tgz bz2 tbz xz txz 7z rar zst lz4 deb rpm apk jar war ear iso dmg cab");
add(
  "code",
  "js mjs cjs ts tsx jsx py pyw rs go java c h cc cpp cxx hpp cs php rb swift kt kts scala lua pl pm r dart ex exs erl hs ml clj vue svelte astro css scss sass less html htm xml xhtml sql graphql gql tf hcl dockerfile makefile cmake gradle",
);
add("shell", "sh bash zsh fish ksh csh ps1 psm1 bat cmd");
add("json", "json jsonc json5 ndjson geojson");
add("config", "yaml yml toml ini conf cfg env properties service socket timer desktop editorconfig gitignore gitattributes dockerignore htaccess npmrc nvmrc");
add("text", "txt md markdown rst log pdf doc docx odt rtf tex adoc org nfo readme license changelog");
add("sheet", "csv tsv xls xlsx ods");
add("video", "mp4 mkv avi mov webm wmv flv m4v mpg mpeg");
add("audio", "mp3 wav flac ogg oga opus m4a aac wma mid midi");
add("key", "pem key crt cer csr der p12 pfx pub gpg asc kdbx");
add("db", "db sqlite sqlite3 mdb frm ibd dump");
add("lock", "lock");

const ICONS: Record<Kind, { Icon: LucideIcon; tone: string }> = {
  image: { Icon: FileImage, tone: "fx-ic-image" },
  archive: { Icon: FileArchive, tone: "fx-ic-archive" },
  code: { Icon: FileCode, tone: "fx-ic-code" },
  shell: { Icon: FileTerminal, tone: "fx-ic-shell" },
  json: { Icon: FileBraces, tone: "fx-ic-code" },
  config: { Icon: FileCog, tone: "fx-ic-config" },
  text: { Icon: FileText, tone: "fx-ic-text" },
  sheet: { Icon: FileSpreadsheet, tone: "fx-ic-shell" },
  video: { Icon: FileVideoCamera, tone: "fx-ic-image" },
  audio: { Icon: FileMusic, tone: "fx-ic-image" },
  key: { Icon: FileKey, tone: "fx-ic-archive" },
  db: { Icon: FileDatabase, tone: "fx-ic-config" },
  lock: { Icon: FileLock, tone: "fx-ic-text" },
};

/** Nombres sin extensión que se reconocen igual (Dockerfile, Makefile, .bashrc…). */
const NAMES: Record<string, Kind> = {
  dockerfile: "code",
  makefile: "code",
  "cmakelists.txt": "code",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".bash_profile": "shell",
  ".env": "config",
  authorized_keys: "key",
  known_hosts: "key",
  id_rsa: "key",
  id_ed25519: "key",
  readme: "text",
  license: "text",
};

export function isDirLike(e: FileEntry): boolean {
  return e.kind === "dir" || e.isDirLink;
}

export function EntryIcon({ entry, size = 16 }: { entry: FileEntry; size?: number }) {
  if (entry.kind === "dir") return <Folder size={size} className="fx-ic fx-ic-folder" />;
  if (entry.isDirLink) return <FolderSymlink size={size} className="fx-ic fx-ic-folder" />;
  if (entry.kind === "symlink") return <FileSymlink size={size} className="fx-ic fx-ic-text" />;
  const lower = entry.name.toLowerCase();
  const kind =
    NAMES[lower] ??
    EXT[extname(entry.name)] ??
    (lower.startsWith(".") ? EXT[lower.slice(1)] : undefined) ??
    (lower.startsWith(".env") ? "config" : undefined);
  if (!kind) return <FileIcon size={size} className="fx-ic fx-ic-file" />;
  const { Icon, tone } = ICONS[kind];
  return <Icon size={size} className={`fx-ic ${tone}`} />;
}
