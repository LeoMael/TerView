//! Lo que el servidor MCP necesita de SSHorus, detrás de un trait para poder probar la lógica sin
//! Tauri (las pruebas usan un motor simulado o el servidor SSH de pruebas).

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use super::approval::{ApprovalRequest, Decision, PendingApprovals};
use super::ui::UiBridge;
use crate::error::{AppError, AppResult};
use crate::sftp::{FilePart, SftpStore};
use crate::snippets::{exec, ExecRegistry, SnippetStore};
use crate::ssh::SessionStore;
use crate::storage::vault::Vault;
use crate::storage::{ProfileStore, SettingsStore};
use crate::transfer::TransferManager;
use crate::types::{ExecResult, FileEntry, ProfilesData, SessionInfo, Snippet, TransferJob};
use crate::audit::model::AuditReport;
use crate::vulnscan::model::Report;
use crate::vulnscan::scan::{scan_session, ScanOptions};
use crate::vulnscan::{store as vuln_store, VulnScanSettings};

/// Evento: nueva petición de aprobación (payload `ApprovalRequest`).
pub const EV_APPROVAL: &str = "mcp://approval";
/// Evento: la petición ya no está pendiente (payload: id). Cierra el diálogo.
pub const EV_APPROVAL_DONE: &str = "mcp://approval-done";

pub trait Backend: Send + Sync + 'static {
    /// SSHorus está bloqueado (bóveda con PIN sin abrir).
    fn vault_locked(&self) -> bool;
    /// Servidores y proyectos guardados (sin contraseñas: nunca las hay en este dato).
    fn profiles(&self) -> ProfilesData;
    fn sessions(&self) -> impl Future<Output = Vec<SessionInfo>> + Send;
    /// Ejecuta en un canal exec aparte, cancelable con `cancel_exec(exec_id)`. `stdin` (si lo hay) se
    /// escribe en la entrada del comando y después se envía EOF; puede llevar la contraseña de sudo: nunca
    /// se registra.
    fn exec(
        &self,
        session_id: &str,
        command: &str,
        stdin: Option<&[u8]>,
        timeout_secs: u32,
        exec_id: &str,
    ) -> impl Future<Output = AppResult<ExecResult>> + Send;
    fn cancel_exec(&self, exec_id: &str) -> bool;
    fn list_dir(&self, session_id: &str, path: &str) -> impl Future<Output = AppResult<Vec<FileEntry>>> + Send;
    fn stat(&self, session_id: &str, path: &str) -> impl Future<Output = AppResult<FileEntry>> + Send;
    fn read_part(
        &self,
        session_id: &str,
        path: &str,
        offset: u64,
        max_bytes: u64,
    ) -> impl Future<Output = AppResult<FilePart>> + Send;
    fn write_text(&self, session_id: &str, path: &str, content: &str) -> impl Future<Output = AppResult<FileEntry>> + Send;
    fn upload(&self, session_id: &str, local_paths: Vec<String>, remote_dir: String) -> impl Future<Output = AppResult<String>> + Send;
    fn download(&self, session_id: &str, remote_paths: Vec<String>, local_dir: String) -> impl Future<Output = AppResult<String>> + Send;
    fn transfers(&self) -> Vec<TransferJob>;
    /// «Mis comandos».
    fn snippets(&self) -> Vec<Snippet>;
    /// Ajustes del escáner de vulnerabilidades (los mismos que usa la interfaz).
    fn vuln_settings(&self) -> VulnScanSettings;
    /// Último informe de vulnerabilidades guardado de un servidor (None si nunca se analizó).
    fn vuln_latest(&self, server_id: &str) -> impl Future<Output = AppResult<Option<Report>>> + Send;
    /// Última auditoría guardada de un servidor (None si nunca se auditó).
    fn audit_latest(&self, server_id: &str) -> impl Future<Output = AppResult<Option<AuditReport>>> + Send;
    /// Análisis de vulnerabilidades SIN sudo por la conexión `session_id` (lo guarda en el historial
    /// si `opts.save`). Se detiene, también en el servidor, al cancelar `cancel` o con
    /// `cancel_exec(exec_id)` (botón «Detener» del panel de actividad).
    fn vuln_scan(
        &self,
        session_id: &str,
        opts: ScanOptions,
        exec_id: &str,
        cancel: &CancellationToken,
    ) -> impl Future<Output = AppResult<Report>> + Send;
    /// Pide algo a la interfaz (abrir una pestaña, el catálogo, puertos…). Ver `ui.rs`.
    fn ui_request(&self, kind: &str, payload: Value, timeout: Duration) -> impl Future<Output = AppResult<Value>> + Send;
    /// Muestra el diálogo de permiso y espera la respuesta (el tiempo límite lo pone quien llama).
    fn ask_approval(&self, req: ApprovalRequest) -> impl Future<Output = Decision> + Send;
    /// La petición dejó de estar pendiente (respondida o vencida).
    fn approval_done(&self, id: &str);
}

/// El motor real: usa el estado de la app Tauri.
pub struct TauriBackend {
    pub app: AppHandle,
    pub pending: Arc<PendingApprovals>,
    pub ui: Arc<UiBridge>,
}

impl TauriBackend {
    fn sessions_store(&self) -> AppResult<&SessionStore> {
        self.app
            .try_state::<SessionStore>()
            .map(|s| s.inner())
            .ok_or_else(|| AppError::Invalid("SSHorus aún está arrancando".into()))
    }

    async fn ssh(&self, session_id: &str) -> AppResult<Arc<crate::ssh::SshSession>> {
        self.sessions_store()?.get(session_id).await
    }

    fn sftp(&self) -> AppResult<&SftpStore> {
        self.app
            .try_state::<SftpStore>()
            .map(|s| s.inner())
            .ok_or_else(|| AppError::Invalid("SSHorus aún está arrancando".into()))
    }

    /// Trae la ventana principal al frente para que veas el diálogo.
    fn bring_to_front(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
    }
}

impl Backend for TauriBackend {
    fn vault_locked(&self) -> bool {
        Vault::global().status().locked
    }

    fn profiles(&self) -> ProfilesData {
        self.app.try_state::<ProfileStore>().map(|s| s.data()).unwrap_or_default()
    }

    async fn sessions(&self) -> Vec<SessionInfo> {
        match self.sessions_store() {
            Ok(s) => s.list().await,
            Err(_) => Vec::new(),
        }
    }

    async fn exec(
        &self,
        session_id: &str,
        command: &str,
        stdin: Option<&[u8]>,
        timeout_secs: u32,
        exec_id: &str,
    ) -> AppResult<ExecResult> {
        let registry = self
            .app
            .try_state::<ExecRegistry>()
            .ok_or_else(|| AppError::Invalid("SSHorus aún está arrancando".into()))?;
        let ticket = registry.register(exec_id)?;
        let session = self.ssh(session_id).await?;
        exec::run_cancellable(&session, command, stdin, timeout_secs, &ticket.token).await
    }

    fn cancel_exec(&self, exec_id: &str) -> bool {
        self.app.try_state::<ExecRegistry>().is_some_and(|r| r.cancel(exec_id))
    }

    async fn list_dir(&self, session_id: &str, path: &str) -> AppResult<Vec<FileEntry>> {
        let ssh = self.ssh(session_id).await?;
        self.sftp()?.list_dir(&ssh, path).await
    }

    async fn stat(&self, session_id: &str, path: &str) -> AppResult<FileEntry> {
        let ssh = self.ssh(session_id).await?;
        self.sftp()?.stat(&ssh, path).await
    }

    async fn read_part(&self, session_id: &str, path: &str, offset: u64, max_bytes: u64) -> AppResult<FilePart> {
        let ssh = self.ssh(session_id).await?;
        self.sftp()?.read_part(&ssh, path, offset, max_bytes).await
    }

    async fn write_text(&self, session_id: &str, path: &str, content: &str) -> AppResult<FileEntry> {
        let ssh = self.ssh(session_id).await?;
        self.sftp()?.write_text(&ssh, path, content).await
    }

    async fn upload(&self, session_id: &str, local_paths: Vec<String>, remote_dir: String) -> AppResult<String> {
        self.ssh(session_id).await?;
        let x = self
            .app
            .try_state::<TransferManager>()
            .ok_or_else(|| AppError::Invalid("SSHorus aún está arrancando".into()))?;
        Ok(x.engine(&self.app).upload(session_id.to_string(), local_paths, remote_dir))
    }

    async fn download(&self, session_id: &str, remote_paths: Vec<String>, local_dir: String) -> AppResult<String> {
        self.ssh(session_id).await?;
        let x = self
            .app
            .try_state::<TransferManager>()
            .ok_or_else(|| AppError::Invalid("SSHorus aún está arrancando".into()))?;
        Ok(x.engine(&self.app).download(session_id.to_string(), remote_paths, local_dir))
    }

    fn transfers(&self) -> Vec<TransferJob> {
        self.app.try_state::<TransferManager>().map(|x| x.list()).unwrap_or_default()
    }

    fn snippets(&self) -> Vec<Snippet> {
        self.app.try_state::<SnippetStore>().map(|s| s.list()).unwrap_or_default()
    }

    fn vuln_settings(&self) -> VulnScanSettings {
        self.app.try_state::<SettingsStore>().map(|s| s.get().vulnscan.sanitized()).unwrap_or_default()
    }

    async fn vuln_latest(&self, server_id: &str) -> AppResult<Option<Report>> {
        let id = server_id.to_string();
        tokio::task::spawn_blocking(move || vuln_store::latest_report(&id))
            .await
            .map_err(|e| AppError::Io(format!("no se pudo leer el historial: {e}")))?
    }

    async fn audit_latest(&self, server_id: &str) -> AppResult<Option<AuditReport>> {
        let id = server_id.to_string();
        tokio::task::spawn_blocking(move || crate::audit::store::latest_report(&id))
            .await
            .map_err(|e| AppError::Io(format!("no se pudo leer el historial: {e}")))?
    }

    async fn vuln_scan(&self, session_id: &str, opts: ScanOptions, exec_id: &str, cancel: &CancellationToken) -> AppResult<Report> {
        let registry = self
            .app
            .try_state::<ExecRegistry>()
            .ok_or_else(|| AppError::Invalid("SSHorus aún está arrancando".into()))?;
        let ticket = registry.register(exec_id)?;
        let session = self.ssh(session_id).await?;
        scan_with_stop(&session, &opts, cancel, &ticket.token).await
    }

    async fn ui_request(&self, kind: &str, payload: Value, timeout: Duration) -> AppResult<Value> {
        self.ui.request(&self.app, kind, payload, timeout).await
    }

    async fn ask_approval(&self, req: ApprovalRequest) -> Decision {
        let rx = self.pending.add(req.clone());
        if let Err(e) = self.app.emit(EV_APPROVAL, &req) {
            log::warn!("no se pudo mostrar la petición del asistente: {e}");
        }
        self.bring_to_front();
        rx.await.unwrap_or(Decision::Deny)
    }

    fn approval_done(&self, id: &str) {
        self.pending.remove(id);
        let _ = self.app.emit(EV_APPROVAL_DONE, id);
    }
}

/// `scan_session` que también se detiene con `stop` (el token del registro de ejecuciones, que usa
/// el botón «Detener» del panel de actividad).
pub(crate) async fn scan_with_stop(
    session: &crate::ssh::SshSession,
    opts: &ScanOptions,
    cancel: &CancellationToken,
    stop: &CancellationToken,
) -> AppResult<Report> {
    let quiet = |_: &str, _: usize, _: usize, _: &str| {};
    let scan = scan_session(session, opts, cancel, &quiet);
    tokio::pin!(scan);
    tokio::select! {
        r = &mut scan => r,
        () = stop.cancelled() => {
            cancel.cancel();
            scan.await
        }
    }
}
