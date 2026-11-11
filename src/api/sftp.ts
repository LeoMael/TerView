import { call } from "./core";
import type { FileEntry, RemoteText } from "./types";

export const sftp = {
  home: (sessionId: string) => call<string>("sftp_home", { sessionId }),
  listDir: (sessionId: string, path: string) => call<FileEntry[]>("sftp_list_dir", { sessionId, path }),
  stat: (sessionId: string, path: string) => call<FileEntry>("sftp_stat", { sessionId, path }),
  mkdir: (sessionId: string, path: string) => call<void>("sftp_mkdir", { sessionId, path }),
  createFile: (sessionId: string, path: string) => call<void>("sftp_create_file", { sessionId, path }),
  rename: (sessionId: string, from: string, to: string) => call<void>("sftp_rename", { sessionId, from, to }),
  delete: (sessionId: string, paths: string[]) => call<void>("sftp_delete", { sessionId, paths }),
  chmod: (sessionId: string, path: string, mode: number) => call<void>("sftp_chmod", { sessionId, path, mode }),
  readText: (sessionId: string, path: string) => call<RemoteText>("sftp_read_text", { sessionId, path }),
  writeText: (sessionId: string, path: string, content: string) =>
    call<FileEntry>("sftp_write_text", { sessionId, path, content }),
};
