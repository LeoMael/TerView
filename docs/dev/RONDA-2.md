# Ronda 2 — cambios en la BASE (léelo junto con REGLAS-AGENTES.md)

Todo lo de la ronda 1 está terminado e integrado (43/43 tests). Esta ronda implementa `docs/PENDIENTES.md`
(salvo el MCP). Mismas reglas: solo tus archivos; la BASE no se toca.

## Nuevo en la BASE (ya existe, úsalo)
- `types.rs` / `src/api/types.ts`:
  - `Settings` + `keepaliveSecs` (10), `autoReconnect` (true), `reconnectAttempts` (5), `editorFontSize`,
    `editorFontFamily`, `sshConfigSync` (false), `transferConflict` ("overwrite" | "skip" | "newer").
  - Eventos `EV_SESSION_RECONNECTING` (payload `SessionReconnecting`) y `EV_SESSION_RECONNECTED`
    (payload `SessionInfo`, **mismo sessionId**). `EV_SESSION_CLOSED` sigue para la pérdida definitiva.
  - `TransferStatus::Skipped` / `"skipped"` (no se transfirió por la política de conflictos).
  - `SshConfigExport`, `Snippet`, `SnippetScope`, `ExecResult`.
- `error.rs`: `AppError::NeedsOtp(String)` → kind `"NeedsOtp"` (mensaje = pregunta del servidor).
- Comandos nuevos registrados (stubs con firma final):
  `profiles_duplicate_server`, `profiles_export_ssh_config`, `profiles_import_ssh_config` (storage),
  `snippets_load`, `snippets_save`, `snippets_delete`, `exec_capture` (nuevo módulo `src-tauri/src/snippets/`).
  `ssh_connect` tiene un parámetro nuevo `otp: Option<String>`.
- `TransferManager::resume_session(session_id)` (stub en `transfer/mod.rs`): el módulo SSH lo llama al reconectar.
- Interfaz: `src/api/snippets.ts`, `profiles.duplicateServer/exportSshConfig/importSshConfig`, `ssh.connect(..., { otp })`.
- `src/stores/tabs.ts`: `status` ahora es `"connected" | "reconnecting" | "closed"`, más `reconnect`
  (datos del intento) y `reconnectCount` (sube en cada reconexión exitosa → reabrir terminales / recargar explorador).
- `src/stores/terminalBus.ts`: `registerTerminalWriter(sessionId, fn)` / `sendToTerminal(sessionId, text, execute)`.
- `src/components/ui/Logo.tsx`: `<Logo size={22} withName />` (isotipo en `src/assets/logo.svg`).
- Stubs de la interfaz: `src/components/Commands/CommandsPanel.tsx` (`CommandsPanel({sessionId, profileId, active, disabled})`)
  y `CommandPalette.tsx` (`CommandPalette()`, global).
- npm: `@xterm/addon-search` instalado.
