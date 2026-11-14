//! Motor de transferencias independiente de Tauri (probado directamente en los tests).
//!
//! - Una cola por sesión, en orden de llegada; hasta `concurrency()` trabajos a la vez
//!   POR SESIÓN (1..=8): dos servidores trabajan en paralelo con N cada uno.
//! - Cada trabajo toma prestado un canal SFTP de la reserva de su sesión.
//! - Política de conflictos (`Conflict`) leída al crear el lote; lo omitido queda `Skipped`.
//! - Enlaces simbólicos dentro de carpetas se recrean (nunca se siguen).
//! - Si la conexión se cae y se espera reconexión, los trabajos vuelven a la cola de su
//!   sesión ("Esperando reconexión…") sin gastar reintentos; `resume_session` los reanuda
//!   desde lo ya confirmado. `session_closed` (pérdida definitiva) los deja en error.
//! - El progreso vive en atómicos (`Ctrl`); un emisor cada ~200 ms calcula velocidades
//!   y envía SOLO los trabajos que cambiaron.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{File as SftpFile, StatusCode};
use tokio::sync::Notify;

use super::copy::{self, CopyError, CopyResult, Ctrl, STOP_CANCEL, STOP_PAUSE};
use super::paths::{
    local_file_name, local_io_message, local_name_key, local_root_name, numbered_name, remote_basename, remote_join,
    remote_kind, remote_parent, renamed_display, safe_remote_name, walk_local, RemoteKind,
};
use super::policy::{decide, Conflict, ConflictQuestion, Decision, ASK_MSG};
use super::pool::{Chan, Lease, Pools};
use crate::error::AppResult;
use crate::ssh::SshSession;
use crate::types::{TransferDirection, TransferJob, TransferStatus};

pub const CLOSED_MSG: &str = "La conexión se cerró";
/// Nota de los trabajos en cola mientras su sesión se reconecta.
pub const WAITING_MSG: &str = "Esperando reconexión…";
const TICK: Duration = Duration::from_millis(200);
const MAX_RETRIES: u32 = 3;
/// Si una sesión caída no se reconecta (ni se cierra) en este tiempo, se da por perdida.
const MAX_DOWN: Duration = Duration::from_secs(300);
/// Revisión periódica en reposo (canales ociosos, sesiones caídas).
const IDLE_CHECK: Duration = Duration::from_secs(30);

/// Lo que el motor necesita del exterior (Tauri en la app, un doble en los tests).
pub trait TransferEnv: Send + Sync + 'static {
    fn session<'a>(&'a self, id: &'a str) -> BoxFuture<'a, AppResult<Arc<SshSession>>>;
    /// Trabajos simultáneos deseados POR SESIÓN (se recorta a 1..=8).
    fn concurrency(&self) -> usize;
    /// Política de conflictos actual (se lee al crear cada lote).
    fn conflict_policy(&self) -> Conflict;
    /// ¿Se espera una reconexión automática cuando una sesión desaparece?
    fn auto_reconnect(&self) -> bool;
    fn emit_update(&self, jobs: Vec<TransferJob>);
    fn emit_removed(&self, ids: Vec<String>);
    /// Un trabajo choca con un destino existente y la política es "preguntar".
    fn emit_conflict(&self, question: ConflictQuestion);
    /// Preguntas que ya no están pendientes (respondidas en bloque, canceladas o pausadas).
    fn emit_conflict_done(&self, job_ids: Vec<String>);
}

/// Cómo repetir un recorrido de carpeta que falló.
#[derive(Clone, Debug)]
enum WalkSpec {
    UploadRoot { local: PathBuf, remote_dir: String },
    DownloadRoot { remote: String, local_dir: PathBuf },
    DownloadDir { remote: String, local: PathBuf, rel: String },
}

#[derive(Clone, Debug)]
enum Kind {
    /// Copia de un archivo. `mode`/`mtime`: atributos remotos (bajadas).
    File { mode: Option<u32>, mtime: Option<u32> },
    /// Enlace simbólico a recrear. Subida: `target` del enlace local. Bajada: se lee con
    /// `readlink` al ejecutar (`target` = None); `mtime` del enlace remoto.
    Link { target: Option<String>, mtime: Option<u32> },
    /// Recorrido que falló; "reintentar" lo repite.
    Walk(WalkSpec),
    /// Aviso no reintentable (p. ej. carpeta local ilegible).
    Info,
}

struct Entry {
    job: TransferJob,
    kind: Kind,
    ctrl: Option<Arc<Ctrl>>,
    /// El destino se tocó alguna vez (cancelar lo borra).
    touched: bool,
    /// Se pidió reanudar mientras se estaba pausando.
    resume_after_stop: bool,
    /// Respuesta del usuario a un conflicto (manda sobre la política del lote).
    decision: Option<Conflict>,
    dirty: bool,
    last_bytes: u64,
}

struct Batch {
    jobs: Vec<String>,
    policy: Conflict,
    paused: bool,
    canceled: bool,
    walkers: usize,
}

struct State {
    order: Vec<String>,
    jobs: HashMap<String, Entry>,
    batches: HashMap<String, Batch>,
    /// Cola por sesión (sessionId → ids).
    queues: HashMap<String, VecDeque<String>>,
    running: Vec<String>,
    /// Sesiones caídas esperando reconexión (desde cuándo).
    down: HashMap<String, Instant>,
    /// Sesiones cerradas definitivamente (lo que falle después no espera).
    closed: HashSet<String>,
    /// Preguntas de conflicto pendientes (jobId → pregunta). Esos trabajos quedan `Queued`
    /// fuera de la cola (no ocupan turno) hasta que se responda.
    questions: HashMap<String, ConflictQuestion>,
    dirty: Vec<String>,
    last_tick: Instant,
}

impl State {
    /// Encola un trabajo en la cola de su sesión.
    fn enqueue(&mut self, id: &str, front: bool) {
        let Some(sid) = self.jobs.get(id).map(|e| e.job.session_id.clone()) else { return };
        let q = self.queues.entry(sid).or_default();
        if front {
            q.push_front(id.to_string());
        } else {
            q.push_back(id.to_string());
        }
    }

    fn mark(&mut self, id: &str) {
        if let Some(e) = self.jobs.get_mut(id)
            && !e.dirty
        {
            e.dirty = true;
            self.dirty.push(id.to_string());
        }
    }

    /// ids de trabajos o de lotes → ids de trabajos (sin duplicados, en orden).
    fn expand(&self, ids: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if self.jobs.contains_key(id) {
                if seen.insert(id.clone()) {
                    out.push(id.clone());
                }
            } else if let Some(b) = self.batches.get(id) {
                for j in &b.jobs {
                    if seen.insert(j.clone()) {
                        out.push(j.clone());
                    }
                }
            }
        }
        out
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Engine {
    env: Arc<dyn TransferEnv>,
    st: Mutex<State>,
    pools: Pools,
    notify: Notify,
    /// Despierta a los trabajos que esperan (reintento) cuando una sesión vuelve o se cierra.
    resumed: Notify,
    emitter_started: AtomicBool,
}

struct NewJob {
    job: TransferJob,
    kind: Kind,
}

/// Resultado correcto de un trabajo.
#[derive(Debug)]
enum Outcome {
    Copied(u64),
    Skipped(String),
    /// El destino existe y hay que preguntar (el trabajo suelta su turno).
    Ask(Box<ConflictQuestion>),
}

impl Engine {
    pub fn new(env: Arc<dyn TransferEnv>) -> Arc<Engine> {
        Arc::new(Engine {
            env,
            st: Mutex::new(State {
                order: Vec::new(),
                jobs: HashMap::new(),
                batches: HashMap::new(),
                queues: HashMap::new(),
                running: Vec::new(),
                down: HashMap::new(),
                closed: HashSet::new(),
                questions: HashMap::new(),
                dirty: Vec::new(),
                last_tick: Instant::now(),
            }),
            pools: Pools::default(),
            notify: Notify::new(),
            resumed: Notify::new(),
            emitter_started: AtomicBool::new(false),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        match self.st.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    // ───────────────────────── API pública ─────────────────────────

    pub fn upload(self: &Arc<Self>, session_id: String, local_paths: Vec<String>, remote_dir: String) -> String {
        let batch_id = uuid::Uuid::new_v4().to_string();
        self.open_batch(&batch_id, self.env.conflict_policy());
        let me = self.clone();
        let b = batch_id.clone();
        tokio::spawn(async move {
            for p in local_paths {
                me.walk_upload_root(&b, &session_id, PathBuf::from(p), &remote_dir).await;
            }
            me.walker_done(&b);
        });
        batch_id
    }

    pub fn download(self: &Arc<Self>, session_id: String, remote_paths: Vec<String>, local_dir: String) -> String {
        let batch_id = uuid::Uuid::new_v4().to_string();
        self.open_batch(&batch_id, self.env.conflict_policy());
        let me = self.clone();
        let b = batch_id.clone();
        let local_dir = PathBuf::from(local_dir);
        tokio::spawn(async move {
            for p in remote_paths {
                me.walk_download_root(&b, &session_id, p, &local_dir).await;
            }
            me.walker_done(&b);
        });
        batch_id
    }

    /// Suelta los canales SFTP de una sesión (se cerró o se va a reconectar).
    pub fn forget_session(&self, session_id: &str) {
        self.pools.drop_session(session_id);
    }

    /// La sesión volvió (mismo id, conexión nueva): los trabajos que esperaban siguen y los
    /// que fallaron por la caída se reintentan desde lo ya confirmado.
    pub fn resume_session(self: &Arc<Self>, session_id: &str) {
        self.pools.drop_session(session_id);
        let ids: Vec<String> = {
            let mut st = self.lock();
            st.down.remove(session_id);
            st.closed.remove(session_id);
            st.order
                .iter()
                .filter(|id| {
                    st.jobs.get(*id).is_some_and(|e| {
                        e.job.session_id == session_id
                            && e.job.status == TransferStatus::Error
                            && e.job.error.as_deref() == Some(CLOSED_MSG)
                            && !matches!(e.kind, Kind::Info)
                    })
                })
                .cloned()
                .collect()
        };
        log::info!("transferencias: sesión {session_id} reconectada; {} trabajos a reanudar", ids.len());
        self.resumed.notify_waiters();
        if ids.is_empty() {
            self.schedule();
        } else {
            self.retry(&ids);
        }
    }

    /// La sesión se perdió definitivamente: lo que esperaba en su cola queda en error
    /// (reintentable si más tarde llegara `resume_session`).
    pub fn session_closed(self: &Arc<Self>, session_id: &str) {
        self.pools.drop_session(session_id);
        {
            let mut st = self.lock();
            st.down.remove(session_id);
            st.closed.insert(session_id.to_string());
            let queued: Vec<String> = st.queues.remove(session_id).map(Vec::from).unwrap_or_default();
            let now = now_ms();
            for id in queued {
                let Some(e) = st.jobs.get_mut(&id) else { continue };
                if e.job.status != TransferStatus::Queued || e.ctrl.is_some() {
                    continue;
                }
                e.job.status = TransferStatus::Error;
                e.job.error = Some(CLOSED_MSG.into());
                e.job.speed = 0.0;
                e.job.finished_at = Some(now);
                st.mark(&id);
            }
        }
        self.resumed.notify_waiters();
        self.kick();
    }

    /// Sesiones caídas demasiado tiempo sin reconectar → se dan por cerradas.
    fn expire_down(self: &Arc<Self>) {
        let expired: Vec<String> = {
            let st = self.lock();
            st.down
                .iter()
                .filter(|(_, t)| t.elapsed() > MAX_DOWN)
                .map(|(k, _)| k.clone())
                .collect()
        };
        for id in expired {
            log::warn!("transferencias: la sesión {id} no se reconectó a tiempo");
            self.session_closed(&id);
        }
    }

    /// Solo pruebas: canales de la reserva.
    #[cfg(test)]
    pub fn pools(&self) -> &Pools {
        &self.pools
    }

    pub fn list(&self) -> Vec<TransferJob> {
        let st = self.lock();
        st.order
            .iter()
            .filter_map(|id| st.jobs.get(id))
            .map(|e| {
                let mut j = e.job.clone();
                if let Some(c) = &e.ctrl {
                    j.transferred = c.progress.load(Ordering::Relaxed);
                }
                j
            })
            .collect()
    }

    pub fn pause(self: &Arc<Self>, ids: &[String]) {
        let mut answered = Vec::new();
        {
            let mut st = self.lock();
            for id in ids {
                if let Some(b) = st.batches.get_mut(id) {
                    b.paused = true;
                }
            }
            for id in st.expand(ids) {
                let Some(e) = st.jobs.get_mut(&id) else { continue };
                match e.job.status {
                    TransferStatus::Running => {
                        e.resume_after_stop = false;
                        if let Some(c) = &e.ctrl {
                            c.stop_with(STOP_PAUSE);
                        }
                    }
                    TransferStatus::Queued => {
                        e.job.status = TransferStatus::Paused;
                        e.job.speed = 0.0;
                        // Si esperaba una respuesta, al reanudar se vuelve a preguntar.
                        if st.questions.remove(&id).is_some() {
                            if let Some(e) = st.jobs.get_mut(&id) {
                                e.job.error = None;
                            }
                            answered.push(id.clone());
                        }
                        st.mark(&id);
                    }
                    _ => {}
                }
            }
        }
        if !answered.is_empty() {
            self.env.emit_conflict_done(answered);
        }
        self.kick();
    }

    pub fn resume(self: &Arc<Self>, ids: &[String]) {
        {
            let mut st = self.lock();
            for id in ids {
                if let Some(b) = st.batches.get_mut(id) {
                    b.paused = false;
                }
            }
            for id in st.expand(ids) {
                let Some(e) = st.jobs.get_mut(&id) else { continue };
                match e.job.status {
                    TransferStatus::Paused => {
                        e.job.status = TransferStatus::Queued;
                        st.enqueue(&id, false);
                        st.mark(&id);
                    }
                    TransferStatus::Running
                        if e.ctrl.as_ref().is_some_and(|c| c.stop.load(Ordering::SeqCst) == STOP_PAUSE) =>
                    {
                        e.resume_after_stop = true;
                    }
                    _ => {}
                }
            }
        }
        self.schedule();
    }

    pub fn cancel(self: &Arc<Self>, ids: &[String]) {
        let mut cleanup = Vec::new();
        let mut answered = Vec::new();
        {
            let mut st = self.lock();
            for id in ids {
                if let Some(b) = st.batches.get_mut(id) {
                    b.canceled = true;
                }
            }
            let now = now_ms();
            for id in st.expand(ids) {
                let Some(e) = st.jobs.get_mut(&id) else { continue };
                match e.job.status {
                    TransferStatus::Running => {
                        e.resume_after_stop = false;
                        if let Some(c) = &e.ctrl {
                            c.stop_with(STOP_CANCEL);
                        }
                    }
                    TransferStatus::Queued | TransferStatus::Paused | TransferStatus::Error => {
                        if e.touched && matches!(e.kind, Kind::File { .. }) {
                            cleanup.push(e.job.clone());
                        }
                        e.job.status = TransferStatus::Canceled;
                        e.job.speed = 0.0;
                        e.job.finished_at = Some(now);
                        if st.questions.remove(&id).is_some() {
                            if let Some(e) = st.jobs.get_mut(&id) {
                                e.job.error = None;
                            }
                            answered.push(id.clone());
                        }
                        st.mark(&id);
                    }
                    _ => {}
                }
            }
        }
        if !answered.is_empty() {
            self.env.emit_conflict_done(answered);
        }
        for job in cleanup {
            let me = self.clone();
            tokio::spawn(async move { me.delete_partial(&job).await });
        }
        self.kick();
    }

    pub fn retry(self: &Arc<Self>, ids: &[String]) {
        let mut walks = Vec::new();
        let mut removed = Vec::new();
        {
            let mut st = self.lock();
            for id in ids {
                if let Some(b) = st.batches.get_mut(id) {
                    b.canceled = false;
                }
            }
            for id in st.expand(ids) {
                let Some(e) = st.jobs.get_mut(&id) else { continue };
                if e.job.status != TransferStatus::Error {
                    continue;
                }
                match e.kind.clone() {
                    Kind::File { .. } | Kind::Link { .. } => {
                        e.job.status = TransferStatus::Queued;
                        e.job.error = None;
                        e.job.finished_at = None;
                        st.enqueue(&id, false);
                        st.mark(&id);
                    }
                    Kind::Walk(spec) => {
                        let batch = e.job.batch_id.clone();
                        let session = e.job.session_id.clone();
                        st.jobs.remove(&id);
                        st.order.retain(|x| x != &id);
                        if let Some(b) = st.batches.get_mut(&batch) {
                            b.jobs.retain(|x| x != &id);
                            b.walkers += 1;
                        }
                        removed.push(id.clone());
                        walks.push((batch, session, spec));
                    }
                    Kind::Info => {}
                }
            }
        }
        if !removed.is_empty() {
            self.env.emit_removed(removed);
        }
        for (batch, session, spec) in walks {
            let me = self.clone();
            tokio::spawn(async move {
                match spec {
                    WalkSpec::UploadRoot { local, remote_dir } => {
                        me.walk_upload_root(&batch, &session, local, &remote_dir).await
                    }
                    WalkSpec::DownloadRoot { remote, local_dir } => {
                        me.walk_download_root(&batch, &session, remote, &local_dir).await
                    }
                    WalkSpec::DownloadDir { remote, local, rel } => {
                        me.walk_download_tree(&batch, &session, remote, local, rel).await
                    }
                }
                me.walker_done(&batch);
            });
        }
        self.schedule();
    }

    /// Preguntas de conflicto pendientes (en orden de llegada de los trabajos).
    pub fn conflicts(&self) -> Vec<ConflictQuestion> {
        let st = self.lock();
        st.order.iter().filter_map(|id| st.questions.get(id)).cloned().collect()
    }

    /// Responde la pregunta de `job_id` con `answer` (Overwrite / Skip / Rename / Newer).
    /// Con `apply_to_all`, la respuesta pasa a ser la política del lote: responde también
    /// sus otras preguntas pendientes y las que vendrían después.
    /// Devuelve los ids de las preguntas respondidas (ya emitidos como resueltos).
    pub fn resolve(self: &Arc<Self>, job_id: &str, answer: Conflict, apply_to_all: bool) -> Vec<String> {
        if answer == Conflict::Ask {
            return Vec::new();
        }
        let answered: Vec<String> = {
            let mut st = self.lock();
            let batch_id = match st.questions.get(job_id) {
                Some(q) => q.batch_id.clone(),
                None => match st.jobs.get(job_id) {
                    Some(e) if apply_to_all => e.job.batch_id.clone(),
                    _ => return Vec::new(),
                },
            };
            let targets: Vec<String> = if apply_to_all {
                if let Some(b) = st.batches.get_mut(&batch_id) {
                    b.policy = answer;
                }
                st.order
                    .iter()
                    .filter(|id| st.questions.get(*id).is_some_and(|q| q.batch_id == batch_id))
                    .cloned()
                    .collect()
            } else {
                vec![job_id.to_string()]
            };
            let mut done = Vec::with_capacity(targets.len());
            for id in targets {
                if st.questions.remove(&id).is_none() {
                    continue;
                }
                if let Some(e) = st.jobs.get_mut(&id)
                    && e.job.status == TransferStatus::Queued
                    && e.ctrl.is_none()
                {
                    e.decision = Some(answer);
                    e.job.error = None;
                    // Al frente: el usuario espera ver el resultado de su respuesta.
                    st.enqueue(&id, true);
                    st.mark(&id);
                }
                done.push(id);
            }
            done
        };
        if !answered.is_empty() {
            self.env.emit_conflict_done(answered.clone());
        }
        self.schedule();
        answered
    }

    /// Quita terminados (done / skipped / canceled / error). Devuelve los ids quitados (ya emitidos).
    pub fn clear_finished(&self) -> Vec<String> {
        let removed: Vec<String> = {
            let mut st = self.lock();
            let removed: Vec<String> = st
                .order
                .iter()
                .filter(|id| {
                    st.jobs.get(*id).is_some_and(|e| {
                        e.ctrl.is_none()
                            && matches!(
                                e.job.status,
                                TransferStatus::Done
                                    | TransferStatus::Skipped
                                    | TransferStatus::Canceled
                                    | TransferStatus::Error
                            )
                    })
                })
                .cloned()
                .collect();
            if removed.is_empty() {
                return removed;
            }
            let set: std::collections::HashSet<&String> = removed.iter().collect();
            st.order.retain(|id| !set.contains(id));
            st.dirty.retain(|id| !set.contains(id));
            for b in st.batches.values_mut() {
                b.jobs.retain(|id| !set.contains(id));
            }
            st.batches.retain(|_, b| !b.jobs.is_empty() || b.walkers > 0);
            for id in &removed {
                st.jobs.remove(id);
            }
            removed
        };
        if !removed.is_empty() {
            self.env.emit_removed(removed.clone());
        }
        removed
    }

    /// ¿El lote terminó del todo (recorrido acabado y ningún trabajo pendiente)? Un lote que no
    /// existe cuenta como terminado. Lo usa "arrastrar al sistema" para no ofrecer una carpeta
    /// a medio descargar (el recorrido puede seguir añadiendo trabajos tras acabar los primeros).
    pub fn batch_finished(&self, batch_id: &str) -> bool {
        let st = self.lock();
        let Some(b) = st.batches.get(batch_id) else { return true };
        b.walkers == 0
            && b.jobs.iter().all(|id| {
                st.jobs.get(id).is_none_or(|e| {
                    e.ctrl.is_none()
                        && matches!(
                            e.job.status,
                            TransferStatus::Done
                                | TransferStatus::Skipped
                                | TransferStatus::Error
                                | TransferStatus::Canceled
                                | TransferStatus::Paused
                        )
                })
            })
    }

    // ───────────────────────── Lotes y recorridos ─────────────────────────

    fn open_batch(&self, batch_id: &str, policy: Conflict) {
        let mut st = self.lock();
        st.batches.insert(
            batch_id.to_string(),
            Batch {
                jobs: Vec::new(),
                policy,
                paused: false,
                canceled: false,
                walkers: 1,
            },
        );
    }

    fn walker_done(&self, batch_id: &str) {
        let mut st = self.lock();
        if let Some(b) = st.batches.get_mut(batch_id) {
            b.walkers = b.walkers.saturating_sub(1);
        }
    }

    fn batch_canceled(&self, batch_id: &str) -> bool {
        self.lock().batches.get(batch_id).is_none_or(|b| b.canceled)
    }

    #[allow(clippy::too_many_arguments)]
    fn make_job(
        batch_id: &str,
        session_id: &str,
        direction: TransferDirection,
        local: &Path,
        remote: &str,
        name: String,
        size: u64,
    ) -> TransferJob {
        TransferJob {
            id: uuid::Uuid::new_v4().to_string(),
            batch_id: batch_id.to_string(),
            session_id: session_id.to_string(),
            direction,
            local_path: local.to_string_lossy().into_owned(),
            remote_path: remote.to_string(),
            name,
            size,
            transferred: 0,
            status: TransferStatus::Queued,
            error: None,
            speed: 0.0,
            created_at: now_ms(),
            finished_at: None,
        }
    }

    fn error_job(mut job: TransferJob, msg: String, kind: Kind) -> NewJob {
        job.status = TransferStatus::Error;
        job.error = Some(msg);
        job.finished_at = Some(now_ms());
        NewJob { job, kind }
    }

    fn add_jobs(self: &Arc<Self>, batch_id: &str, new: Vec<NewJob>) {
        if new.is_empty() {
            return;
        }
        {
            let mut st = self.lock();
            let (paused, canceled) = match st.batches.get(batch_id) {
                Some(b) => (b.paused, b.canceled),
                None => return,
            };
            if canceled {
                return;
            }
            for NewJob { mut job, kind } in new {
                let id = job.id.clone();
                let enqueue = job.status == TransferStatus::Queued && !paused;
                if job.status == TransferStatus::Queued && paused {
                    job.status = TransferStatus::Paused;
                }
                st.order.push(id.clone());
                if let Some(b) = st.batches.get_mut(batch_id) {
                    b.jobs.push(id.clone());
                }
                st.jobs.insert(
                    id.clone(),
                    Entry {
                        job,
                        kind,
                        ctrl: None,
                        touched: false,
                        resume_after_stop: false,
                        decision: None,
                        dirty: false,
                        last_bytes: 0,
                    },
                );
                if enqueue {
                    st.enqueue(&id, false);
                }
                st.mark(&id);
            }
        }
        self.schedule();
    }

    async fn session_lease(&self, session_id: &str) -> Result<(Arc<SshSession>, Lease), String> {
        let session = match self.env.session(session_id).await {
            Ok(s) => s,
            Err(_) => {
                self.pools.drop_session(session_id);
                return Err(CLOSED_MSG.into());
            }
        };
        match self.pools.lease(session_id, &session).await {
            Ok(l) => Ok((session, l)),
            Err(e) => {
                if session.is_closed() {
                    Err(CLOSED_MSG.into())
                } else {
                    Err(format!("No se pudo abrir un canal SFTP: {e}"))
                }
            }
        }
    }

    async fn walk_upload_root(self: &Arc<Self>, batch_id: &str, session_id: &str, local: PathBuf, remote_dir: &str) {
        if self.batch_canceled(batch_id) {
            return;
        }
        let name = local_root_name(&local);
        let remote_root = remote_join(remote_dir, &name);
        let up = TransferDirection::Upload;
        let walk_kind = Kind::Walk(WalkSpec::UploadRoot {
            local: local.clone(),
            remote_dir: remote_dir.to_string(),
        });
        let meta = match tokio::fs::metadata(&local).await {
            Ok(m) => m,
            Err(e) => {
                let job = Self::make_job(batch_id, session_id, up, &local, &remote_root, name, 0);
                self.add_jobs(batch_id, vec![Self::error_job(job, local_io_message(&e), walk_kind)]);
                return;
            }
        };
        if meta.is_file() {
            let job = Self::make_job(batch_id, session_id, up, &local, &remote_root, name, meta.len());
            self.add_jobs(batch_id, vec![NewJob { job, kind: Kind::File { mode: None, mtime: None } }]);
            return;
        }
        if !meta.is_dir() {
            let job = Self::make_job(batch_id, session_id, up, &local, &remote_root, name, 0);
            self.add_jobs(
                batch_id,
                vec![Self::error_job(job, "No es un archivo ni una carpeta".into(), Kind::Info)],
            );
            return;
        }

        let root = local.clone();
        let plan = match tokio::task::spawn_blocking(move || walk_local(&root)).await {
            Ok(p) => p,
            Err(_) => return,
        };
        let dir_job = || Self::make_job(batch_id, session_id, up, &local, &remote_root, format!("{name}/"), 0);

        // 1) Estructura de carpetas (por niveles, en paralelo dentro de cada nivel).
        if let Err(msg) = self.remote_mkdirs(session_id, remote_dir, &plan.dirs).await {
            self.add_jobs(batch_id, vec![Self::error_job(dir_job(), msg, walk_kind)]);
            return;
        }
        if self.batch_canceled(batch_id) {
            return;
        }

        // 2) Archivos a la cola.
        let mut jobs: Vec<NewJob> = Vec::with_capacity(plan.files.len() + plan.errors.len());
        for f in plan.files {
            let remote = remote_join(remote_dir, &f.rel);
            let job = Self::make_job(batch_id, session_id, up, &f.path, &remote, f.rel, f.size);
            jobs.push(NewJob { job, kind: Kind::File { mode: None, mtime: None } });
        }
        for l in plan.links {
            let remote = remote_join(remote_dir, &l.rel);
            let job = Self::make_job(batch_id, session_id, up, &l.path, &remote, l.rel, 0);
            jobs.push(NewJob {
                job,
                kind: Kind::Link { target: Some(l.target), mtime: None },
            });
        }
        for (rel, msg) in plan.errors {
            let remote = remote_join(remote_dir, &rel);
            let path = local.parent().map(|p| p.join(&rel)).unwrap_or_else(|| PathBuf::from(&rel));
            let job = Self::make_job(batch_id, session_id, up, &path, &remote, rel, 0);
            jobs.push(Self::error_job(job, msg, Kind::Info));
        }
        self.add_jobs(batch_id, jobs);
    }

    /// Crea `dirs` (relativas a `remote_dir`, padres antes que hijos). Error solo si falla la raíz.
    async fn remote_mkdirs(&self, session_id: &str, remote_dir: &str, dirs: &[String]) -> Result<(), String> {
        if dirs.is_empty() {
            return Ok(());
        }
        let (session, mut lease) = self.session_lease(session_id).await?;
        let mut levels: Vec<Vec<&String>> = Vec::new();
        for d in dirs {
            let depth = d.matches('/').count();
            if levels.len() <= depth {
                levels.resize_with(depth + 1, Vec::new);
            }
            levels[depth].push(d);
        }
        for (i, level) in levels.iter().enumerate() {
            let chan: &Chan = lease.chan();
            let paths: Vec<String> = level.iter().map(|d| remote_join(remote_dir, d)).collect();
            let mut results: Vec<(String, Result<(), SftpError>)> = Vec::with_capacity(paths.len());
            for group in paths.chunks(32) {
                let futs: Vec<_> = group.iter().map(|p| copy::remote_mkdir(chan, p)).collect();
                let outs = futures::future::join_all(futs).await;
                results.extend(group.iter().cloned().zip(outs));
            }
            for (path, r) in results {
                if let Err(e) = r {
                    let msg = match copy::sftp_err(e) {
                        CopyError::Transient(m) => {
                            lease.mark_broken();
                            m
                        }
                        CopyError::Fatal(m) => m,
                        CopyError::Stopped | CopyError::Disconnected => "Cancelado".into(),
                    };
                    if session.is_closed() {
                        return Err(CLOSED_MSG.into());
                    }
                    if i == 0 {
                        return Err(format!("No se pudo crear la carpeta {path}: {msg}"));
                    }
                    // Subcarpetas: cada archivo intentará crear su carpeta (mkdir -p) al subir.
                    log::warn!("mkdir {path}: {msg}");
                }
            }
        }
        Ok(())
    }

    async fn walk_download_root(self: &Arc<Self>, batch_id: &str, session_id: &str, remote: String, local_dir: &Path) {
        if self.batch_canceled(batch_id) {
            return;
        }
        let mut name = remote_basename(&remote);
        if !safe_remote_name(&name) {
            name = "raiz".into();
        }
        let local = local_dir.join(local_file_name(&name));
        let down = TransferDirection::Download;
        let walk_kind = Kind::Walk(WalkSpec::DownloadRoot {
            remote: remote.clone(),
            local_dir: local_dir.to_path_buf(),
        });
        let attrs = match self.session_lease(session_id).await {
            Err(msg) => Err(msg),
            Ok((s, mut lease)) => match lease.chan().raw.stat(remote.clone()).await {
                Ok(a) => Ok(a.attrs),
                Err(e) => Err(walk_msg(e, &mut lease, &s).0),
            },
        };
        let attrs = match attrs {
            Ok(a) => a,
            Err(msg) => {
                let job = Self::make_job(batch_id, session_id, down, &local, &remote, name, 0);
                self.add_jobs(batch_id, vec![Self::error_job(job, msg, walk_kind)]);
                return;
            }
        };
        if remote_kind(attrs.permissions) == RemoteKind::Dir {
            self.walk_download_tree(batch_id, session_id, remote, local, name).await;
        } else {
            let job = Self::make_job(batch_id, session_id, down, &local, &remote, name, attrs.size.unwrap_or(0));
            self.add_jobs(
                batch_id,
                vec![NewJob {
                    job,
                    kind: Kind::File { mode: attrs.permissions, mtime: attrs.mtime },
                }],
            );
        }
    }

    /// Recorrido remoto por anchura: crea cada carpeta local y encola sus archivos en cuanto
    /// se listan (las transferencias empiezan sin esperar al recorrido completo).
    async fn walk_download_tree(self: &Arc<Self>, batch_id: &str, session_id: &str, remote: String, local: PathBuf, rel: String) {
        let down = TransferDirection::Download;
        let mut queue: VecDeque<(String, PathBuf, String)> = VecDeque::from([(remote, local, rel)]);
        let mut lease: Option<(Arc<SshSession>, Lease)> = None;
        while let Some((r, l, rel)) = queue.pop_front() {
            if self.batch_canceled(batch_id) {
                return;
            }
            let walk_err = |r: &str, l: &Path, rel: &str, msg: String| {
                let job = Self::make_job(batch_id, session_id, down, l, r, format!("{rel}/"), 0);
                Self::error_job(
                    job,
                    msg,
                    Kind::Walk(WalkSpec::DownloadDir {
                        remote: r.to_string(),
                        local: l.to_path_buf(),
                        rel: rel.to_string(),
                    }),
                )
            };
            // Nunca escribir a través de un enlace simbólico local que ocupe el nombre.
            if tokio::fs::symlink_metadata(&l).await.is_ok_and(|m| m.file_type().is_symlink()) {
                let msg = "En el destino hay un enlace simbólico con ese nombre".to_string();
                self.add_jobs(batch_id, vec![walk_err(&r, &l, &rel, msg)]);
                continue;
            }
            if let Err(e) = tokio::fs::create_dir_all(&l).await {
                self.add_jobs(batch_id, vec![walk_err(&r, &l, &rel, local_io_message(&e))]);
                continue;
            }
            if lease.is_none() {
                match self.session_lease(session_id).await {
                    Ok(pair) => lease = Some(pair),
                    Err(msg) => {
                        // Sin conexión: todo lo pendiente queda como error reintentable.
                        let mut errs = vec![walk_err(&r, &l, &rel, msg.clone())];
                        for (r2, l2, rel2) in queue.drain(..) {
                            errs.push(walk_err(&r2, &l2, &rel2, msg.clone()));
                        }
                        self.add_jobs(batch_id, errs);
                        return;
                    }
                }
            }
            let Some((s, le)) = lease.as_mut() else { return };
            let entries = match read_dir(le.chan(), &r).await {
                Ok(v) => v,
                Err(e) => {
                    let (msg, transient) = walk_msg(e, le, s);
                    if transient {
                        lease = None;
                    }
                    self.add_jobs(batch_id, vec![walk_err(&r, &l, &rel, msg)]);
                    continue;
                }
            };
            let mut jobs = Vec::new();
            let mut seen = HashSet::new();
            // Nombres locales ya usados en esta carpeta: en Windows dos nombres remotos pueden
            // acabar iguales (`a:b` y `a_b`, o `A.txt` y `a.txt`); el segundo se numera.
            let mut used_local = HashSet::new();
            for f in entries {
                if !safe_remote_name(&f.filename) || !seen.insert(f.filename.clone()) {
                    continue;
                }
                let rpath = remote_join(&r, &f.filename);
                let base = local_file_name(&f.filename);
                let mut lname = base.clone();
                let mut n = 2;
                while !used_local.insert(local_name_key(&lname)) {
                    lname = numbered_name(&base, n);
                    n += 1;
                }
                let lpath = l.join(&lname);
                let frel = format!("{rel}/{}", f.filename);
                let a = &f.attrs;
                match remote_kind(a.permissions) {
                    RemoteKind::Dir => queue.push_back((rpath, lpath, frel)),
                    RemoteKind::File | RemoteKind::Unknown => {
                        let job = Self::make_job(batch_id, session_id, down, &lpath, &rpath, frel, a.size.unwrap_or(0));
                        jobs.push(NewJob { job, kind: Kind::File { mode: a.permissions, mtime: a.mtime } });
                    }
                    // Enlaces: se recrean (no se siguen, así no hay bucles).
                    RemoteKind::Link => {
                        let job = Self::make_job(batch_id, session_id, down, &lpath, &rpath, frel, 0);
                        jobs.push(NewJob { job, kind: Kind::Link { target: None, mtime: a.mtime } });
                    }
                    // Sockets, FIFO, dispositivos: se omiten.
                    RemoteKind::Other => {}
                }
            }
            self.add_jobs(batch_id, jobs);
        }
    }

    // ───────────────────────── Planificador y trabajadores ─────────────────────────

    fn schedule(self: &Arc<Self>) {
        let limit = self.env.concurrency().clamp(1, 8);
        let mut start = Vec::new();
        {
            let mut guard = self.lock();
            let st = &mut *guard;
            // Trabajos en marcha por sesión: el límite es POR SESIÓN.
            let mut per: HashMap<String, usize> = HashMap::new();
            for id in &st.running {
                if let Some(e) = st.jobs.get(id) {
                    *per.entry(e.job.session_id.clone()).or_default() += 1;
                }
            }
            let sids: Vec<String> = st.queues.keys().cloned().collect();
            for sid in sids {
                // Sesión caída: su cola espera a la reconexión.
                if st.down.contains_key(&sid) {
                    continue;
                }
                let mut n = per.get(&sid).copied().unwrap_or(0);
                while n < limit {
                    let Some(id) = st.queues.get_mut(&sid).and_then(|q| q.pop_front()) else { break };
                    let Some(e) = st.jobs.get_mut(&id) else { continue };
                    if e.job.status != TransferStatus::Queued || e.ctrl.is_some() {
                        continue;
                    }
                    let ctrl = Arc::new(Ctrl::new(e.job.transferred));
                    ctrl.touched.store(e.touched, Ordering::Relaxed);
                    e.ctrl = Some(ctrl.clone());
                    e.job.status = TransferStatus::Running;
                    e.job.error = None;
                    e.job.speed = 0.0;
                    e.last_bytes = e.job.transferred;
                    st.running.push(id.clone());
                    st.mark(&id);
                    start.push((id, ctrl));
                    n += 1;
                }
                if st.queues.get(&sid).is_some_and(|q| q.is_empty()) {
                    st.queues.remove(&sid);
                }
            }
        }
        for (id, ctrl) in start {
            let me = self.clone();
            tokio::spawn(async move { me.run_job(id, ctrl).await });
        }
        self.kick();
    }

    async fn run_job(self: Arc<Self>, id: String, ctrl: Arc<Ctrl>) {
        let Some((mut job, kind, policy, check)) = ({
            let st = self.lock();
            st.jobs.get(&id).map(|e| {
                let batch = st.batches.get(&e.job.batch_id).map(|b| b.policy).unwrap_or_default();
                // La respuesta del usuario a este archivo manda sobre la del lote.
                let policy = e.decision.unwrap_or(batch);
                // La política solo se aplica antes de tocar el destino (no al reanudar).
                let check = !e.touched && e.job.transferred == 0;
                (e.job.clone(), e.kind.clone(), policy, check)
            })
        }) else {
            return;
        };
        let res = match kind {
            Kind::File { .. } | Kind::Link { .. } => self.execute(&mut job, &kind, policy, check, &ctrl).await,
            _ => Err(CopyError::Fatal("No reintentable".into())),
        };
        let stop = ctrl.stop.load(Ordering::SeqCst);
        let touched = ctrl.touched.load(Ordering::Relaxed);
        let canceled = matches!(res, Err(CopyError::Stopped)) && stop == STOP_CANCEL;
        if canceled && touched {
            self.delete_partial(&job).await;
        }
        let mut ask: Option<ConflictQuestion> = None;
        {
            let mut st = self.lock();
            st.running.retain(|x| x != &id);
            let mut requeue = false;
            let (batch_policy, batch_paused, batch_canceled) = st
                .batches
                .get(&job.batch_id)
                .map(|b| (b.policy, b.paused, b.canceled))
                .unwrap_or((Conflict::Overwrite, false, true));
            if let Some(e) = st.jobs.get_mut(&id) {
                // "Mantener ambos" pudo cambiar el destino.
                e.job.local_path.clone_from(&job.local_path);
                e.job.remote_path.clone_from(&job.remote_path);
                e.job.name.clone_from(&job.name);
                e.ctrl = None;
                e.touched = touched && !canceled;
                e.job.speed = 0.0;
                let progress = ctrl.progress.load(Ordering::Relaxed);
                match res {
                    Ok(Outcome::Copied(n)) => {
                        e.job.status = TransferStatus::Done;
                        e.job.size = n;
                        e.job.transferred = n;
                        e.job.error = None;
                        e.job.finished_at = Some(now_ms());
                    }
                    Ok(Outcome::Skipped(why)) => {
                        e.job.status = TransferStatus::Skipped;
                        e.job.transferred = 0;
                        e.job.error = Some(why);
                        e.job.finished_at = Some(now_ms());
                    }
                    Ok(Outcome::Ask(q)) => {
                        // `stop` se relee con el candado tomado: cancelar/pausar lo cambian
                        // también con el candado, así no se cuela una pregunta huérfana.
                        let stop = ctrl.stop.load(Ordering::SeqCst);
                        if stop == STOP_CANCEL || batch_canceled {
                            e.job.status = TransferStatus::Canceled;
                            e.job.finished_at = Some(now_ms());
                        } else if (stop == STOP_PAUSE || batch_paused) && !e.resume_after_stop {
                            e.job.status = TransferStatus::Paused;
                        } else if batch_policy != Conflict::Ask {
                            // Mientras tanto se respondió "aplicar a todos": sin preguntar.
                            e.job.status = TransferStatus::Queued;
                            requeue = true;
                        } else {
                            e.job.status = TransferStatus::Queued;
                            e.job.error = Some(ASK_MSG.into());
                            ask = Some(*q);
                        }
                    }
                    Err(CopyError::Stopped) if canceled => {
                        e.job.status = TransferStatus::Canceled;
                        e.job.transferred = progress;
                        e.job.finished_at = Some(now_ms());
                    }
                    Err(CopyError::Stopped) => {
                        e.job.transferred = progress;
                        if e.resume_after_stop {
                            e.job.status = TransferStatus::Queued;
                            requeue = true;
                        } else {
                            e.job.status = TransferStatus::Paused;
                        }
                    }
                    Err(CopyError::Disconnected) => {
                        // Vuelve a la cola de su sesión; sigue al reconectar.
                        e.job.transferred = progress;
                        e.job.status = TransferStatus::Queued;
                        e.job.error = Some(WAITING_MSG.into());
                        requeue = true;
                    }
                    Err(CopyError::Transient(m)) | Err(CopyError::Fatal(m)) => {
                        e.job.status = TransferStatus::Error;
                        e.job.error = Some(m);
                        e.job.transferred = progress;
                        e.job.finished_at = Some(now_ms());
                    }
                }
                e.resume_after_stop = false;
            }
            if requeue {
                st.enqueue(&id, true);
            }
            if let Some(q) = &ask {
                st.questions.insert(id.clone(), q.clone());
            }
            st.mark(&id);
        }
        if let Some(q) = ask {
            self.env.emit_conflict(q);
        }
        self.schedule();
    }

    /// La conexión de `session_id` desapareció. Si se espera reconexión, la sesión queda
    /// "caída" (su cola se congela) y el trabajo vuelve a la cola sin gastar reintentos.
    /// Si en realidad ya volvió, devuelve `Transient` para reintentar enseguida.
    async fn lost(&self, session_id: &str) -> CopyError {
        if !self.env.auto_reconnect() || self.lock().closed.contains(session_id) {
            return CopyError::Fatal(CLOSED_MSG.into());
        }
        self.lock().down.entry(session_id.to_string()).or_insert_with(Instant::now);
        // La reconexión pudo terminar justo antes de marcarla caída.
        if self.env.session(session_id).await.is_ok_and(|s| !s.is_closed()) {
            self.lock().down.remove(session_id);
            return CopyError::Transient("Se perdió la conexión".into());
        }
        CopyError::Disconnected
    }

    /// Copia con reintentos automáticos ante cortes del canal.
    async fn execute(
        &self,
        job: &mut TransferJob,
        kind: &Kind,
        policy: Conflict,
        check: bool,
        ctrl: &Ctrl,
    ) -> CopyResult<Outcome> {
        let mut attempt = 0u32;
        let mut recovered = 0u32;
        let mut check = check;
        let mut verify = ctrl.progress.load(Ordering::Relaxed) > 0;
        loop {
            if ctrl.token.is_cancelled() {
                return Err(CopyError::Stopped);
            }
            let leased = tokio::select! {
                biased;
                _ = ctrl.token.cancelled() => return Err(CopyError::Stopped),
                r = self.session_lease(&job.session_id) => r,
            };
            let (closed, mut lease, result) = match leased {
                Err(msg) if msg == CLOSED_MSG => (true, None, Err(CopyError::Transient(msg))),
                Err(msg) => (false, None, Err(CopyError::Transient(msg))),
                Ok((session, lease)) => {
                    let r = try_once(job, kind, policy, &mut check, verify, lease.chan(), ctrl).await;
                    (session.is_closed(), Some(lease), r)
                }
            };
            match result {
                Err(CopyError::Transient(msg)) => {
                    if let Some(l) = lease.as_mut() {
                        l.mark_broken();
                    }
                    drop(lease);
                    let wait = if closed {
                        match self.lost(&job.session_id).await {
                            CopyError::Transient(_) if recovered < 5 => recovered += 1,
                            CopyError::Transient(m) => return Err(CopyError::Fatal(m)),
                            other => return Err(other),
                        }
                        Duration::from_millis(300)
                    } else {
                        attempt += 1;
                        if attempt > MAX_RETRIES {
                            return Err(CopyError::Fatal(format!("{msg} (tras {MAX_RETRIES} reintentos)")));
                        }
                        Duration::from_millis(500 * (1 << (attempt - 1)))
                    };
                    log::warn!("transferencia {}: {msg}; reintento {attempt}", job.name);
                    tokio::select! {
                        biased;
                        _ = ctrl.token.cancelled() => return Err(CopyError::Stopped),
                        _ = self.resumed.notified() => {}
                        _ = tokio::time::sleep(wait) => {}
                    }
                    verify = true;
                }
                other => return other,
            }
        }
    }

    async fn delete_partial(&self, job: &TransferJob) {
        match job.direction {
            TransferDirection::Download => {
                let _ = tokio::fs::remove_file(&job.local_path).await;
            }
            TransferDirection::Upload => {
                if let Ok((_s, lease)) = self.session_lease(&job.session_id).await {
                    let _ = lease.chan().raw.remove(job.remote_path.clone()).await;
                }
            }
        }
    }

    // ───────────────────────── Emisor de progreso ─────────────────────────

    fn kick(self: &Arc<Self>) {
        self.notify.notify_one();
        if !self.emitter_started.swap(true, Ordering::SeqCst) {
            let me = self.clone();
            tokio::spawn(async move { me.emitter().await });
        }
    }

    async fn emitter(self: Arc<Self>) {
        loop {
            // En reposo: espera cambios; de paso cierra canales ociosos viejos y da por
            // perdidas las sesiones caídas que no volvieron.
            if tokio::time::timeout(IDLE_CHECK, self.notify.notified()).await.is_err() {
                self.pools.sweep();
                self.expire_down();
                continue;
            }
            self.lock().last_tick = Instant::now();
            loop {
                tokio::time::sleep(TICK).await;
                self.expire_down();
                let (jobs, active) = self.collect_changes();
                if !jobs.is_empty() {
                    self.env.emit_update(jobs);
                }
                if !active {
                    break;
                }
            }
        }
    }

    /// Actualiza progreso/velocidad de los activos y devuelve los trabajos cambiados.
    fn collect_changes(&self) -> (Vec<TransferJob>, bool) {
        let mut st = self.lock();
        let now = Instant::now();
        let dt = now.duration_since(st.last_tick).as_secs_f64().max(0.001);
        st.last_tick = now;
        let running = st.running.clone();
        for id in &running {
            let Some(e) = st.jobs.get_mut(id) else { continue };
            let Some(c) = &e.ctrl else { continue };
            let p = c.progress.load(Ordering::Relaxed);
            let inst = if p >= e.last_bytes { (p - e.last_bytes) as f64 / dt } else { 0.0 };
            e.last_bytes = p;
            let old = e.job.speed;
            let speed = if old <= 0.0 { inst } else { 0.35 * inst + 0.65 * old };
            let changed = p != e.job.transferred || (speed - old).abs() > 1.0;
            e.job.transferred = p;
            e.job.speed = if speed < 1.0 { 0.0 } else { speed };
            if changed {
                st.mark(id);
            }
        }
        let dirty = std::mem::take(&mut st.dirty);
        let mut out = Vec::with_capacity(dirty.len());
        for id in dirty {
            if let Some(e) = st.jobs.get_mut(&id) {
                e.dirty = false;
                out.push(e.job.clone());
            }
        }
        let active = !st.running.is_empty() || !st.dirty.is_empty();
        (out, active)
    }
}

// ───────────────────────── Un intento ─────────────────────────

/// Un intento con un canal ya prestado. Con "mantener ambos" cambia el destino de `job`.
#[allow(clippy::too_many_arguments)]
async fn try_once(
    job: &mut TransferJob,
    kind: &Kind,
    policy: Conflict,
    check: &mut bool,
    verify: bool,
    chan: &Chan,
    ctrl: &Ctrl,
) -> CopyResult<Outcome> {
    let up = job.direction == TransferDirection::Upload;
    let is_link = matches!(kind, Kind::Link { .. });
    let (mode, mtime) = match kind {
        Kind::File { mode, mtime } => (*mode, *mtime),
        Kind::Link { mtime, .. } => (None, *mtime),
        _ => return Err(CopyError::Fatal("No reintentable".into())),
    };

    if *check {
        let local = Path::new(&job.local_path);
        let (src_mtime, dest) = if up {
            let meta = if is_link {
                tokio::fs::symlink_metadata(local).await
            } else {
                tokio::fs::metadata(local).await
            };
            (copy::unix_secs_u64(meta.and_then(|m| m.modified())), remote_dest(chan, &job.remote_path).await?)
        } else {
            (mtime.map(u64::from), local_dest(local).await?)
        };
        match decide(policy, src_mtime, dest.map(|d| d.mtime)) {
            Decision::Transfer => {}
            Decision::Skip(why) => return Ok(Outcome::Skipped(why.into())),
            Decision::Ask => {
                let dest = dest.unwrap_or_default();
                let (source, destination) = if up {
                    (job.local_path.clone(), job.remote_path.clone())
                } else {
                    (job.remote_path.clone(), job.local_path.clone())
                };
                return Ok(Outcome::Ask(Box::new(ConflictQuestion {
                    job_id: job.id.clone(),
                    batch_id: job.batch_id.clone(),
                    session_id: job.session_id.clone(),
                    direction: job.direction,
                    name: job.name.clone(),
                    source,
                    destination,
                    source_size: (!is_link).then_some(job.size),
                    source_mtime: src_mtime,
                    dest_size: dest.size,
                    dest_mtime: dest.mtime,
                    is_link,
                })));
            }
            Decision::Rename => rename_destination(job, chan, up).await?,
        }
        // Bajada de un archivo: si el nombre lo ocupa un enlace simbólico local, se reemplaza
        // el enlace (nunca se escribe a través de él).
        let local = Path::new(&job.local_path);
        if !up
            && !is_link
            && let Ok(m) = tokio::fs::symlink_metadata(local).await
            && m.file_type().is_symlink()
        {
            remove_link_or_file(local)
                .await
                .map_err(|e| CopyError::Fatal(local_io_message(&e)))?;
        }
        *check = false;
    }

    let local = Path::new(&job.local_path);
    if let Kind::Link { target, .. } = kind {
        return if up {
            upload_link(chan, &job.remote_path, target.as_deref()).await
        } else {
            download_link(chan, &job.remote_path, local).await
        };
    }

    let mut offset = ctrl.progress.load(Ordering::Relaxed);
    if verify && offset > 0 {
        // Se continúa solo si el destino tiene al menos lo ya confirmado.
        let dest = if up {
            copy::remote_size(chan, &job.remote_path).await
        } else {
            copy::local_size(local).await
        };
        if dest.is_none_or(|s| s < offset) {
            offset = 0;
            ctrl.progress.store(0, Ordering::Relaxed);
        }
    }
    let n = if up {
        copy::upload_file(chan, local, &job.remote_path, offset, ctrl).await?
    } else {
        copy::download_file(chan, &job.remote_path, local, offset, job.size, mode, mtime, ctrl).await?
    };
    Ok(Outcome::Copied(n))
}

/// Primer nombre libre `nombre (N).ext` junto al destino ("mantener ambos"); actualiza la
/// ruta de destino y el nombre a mostrar del trabajo.
async fn rename_destination(job: &mut TransferJob, chan: &Chan, up: bool) -> CopyResult<()> {
    const MAX_TRIES: usize = 10_000;
    if up {
        let parent = remote_parent(&job.remote_path);
        let base = remote_basename(&job.remote_path);
        for n in 2..MAX_TRIES {
            let name = numbered_name(&base, n);
            let cand = remote_join(&parent, &name);
            if remote_dest(chan, &cand).await?.is_none() {
                job.remote_path = cand;
                job.name = renamed_display(&job.name, &name);
                return Ok(());
            }
        }
    } else {
        let local = PathBuf::from(&job.local_path);
        let base = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for n in 2..MAX_TRIES {
            let name = numbered_name(&base, n);
            let cand = local.with_file_name(&name);
            if local_dest(&cand).await?.is_none() {
                job.local_path = cand.to_string_lossy().into_owned();
                job.name = renamed_display(&job.name, &name);
                return Ok(());
            }
        }
    }
    Err(CopyError::Fatal("No se encontró un nombre libre para mantener ambos archivos".into()))
}

// ───────────────────────── Conflictos y enlaces ─────────────────────────

/// Fecha (segundos Unix) y tamaño de un destino que ya existe, si se conocen.
#[derive(Debug, Clone, Copy, Default)]
struct DestMeta {
    mtime: Option<u64>,
    size: Option<u64>,
}

/// ¿Existe el destino remoto? `None` = no existe (sin seguir enlaces).
async fn remote_dest(chan: &Chan, path: &str) -> CopyResult<Option<DestMeta>> {
    match chan.raw.lstat(path.to_string()).await {
        Ok(a) => Ok(Some(DestMeta {
            mtime: a.attrs.mtime.map(u64::from),
            size: a.attrs.size,
        })),
        Err(e) if copy::is_no_such_file(&e) => Ok(None),
        Err(e) => Err(copy::sftp_err(e)),
    }
}

/// ¿Existe el destino local? (sin seguir enlaces).
async fn local_dest(path: &Path) -> CopyResult<Option<DestMeta>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(m) => Ok(Some(DestMeta {
            mtime: copy::unix_secs_u64(m.modified()),
            size: m.is_file().then_some(m.len()),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CopyError::Fatal(local_io_message(&e))),
    }
}

/// Recrea un enlace simbólico local en el servidor (mismo objetivo). La política de
/// conflictos ya se aplicó en `attempt`.
async fn upload_link(chan: &Chan, remote: &str, target: Option<&str>) -> CopyResult<Outcome> {
    let Some(target) = target else {
        return Err(CopyError::Fatal("Falta el destino del enlace".into()));
    };
    let raw = &chan.raw;
    let dest = remote_dest(chan, remote).await?;
    if dest.is_some() {
        let is_dir = raw
            .lstat(remote.to_string())
            .await
            .is_ok_and(|a| remote_kind(a.attrs.permissions) == RemoteKind::Dir);
        if is_dir {
            return Err(CopyError::Fatal("Ya existe una carpeta con ese nombre en el servidor".into()));
        }
        raw.remove(remote.to_string()).await.map_err(copy::sftp_err)?;
    }
    // OpenSSH (sftp-server) espera los argumentos al revés que el estándar:
    // primero el objetivo y luego la ruta del enlace.
    match raw.symlink(target.to_string(), remote.to_string()).await {
        Ok(_) => Ok(Outcome::Copied(0)),
        Err(e) if copy::is_no_such_file(&e) => {
            copy::remote_mkdir_p(chan, &remote_parent(remote)).await.map_err(copy::sftp_err)?;
            raw.symlink(target.to_string(), remote.to_string())
                .await
                .map_err(copy::sftp_err)?;
            Ok(Outcome::Copied(0))
        }
        Err(e) => Err(copy::sftp_err(e)),
    }
}

/// Recrea un enlace simbólico remoto en el equipo local (mismo objetivo).
async fn download_link(chan: &Chan, remote: &str, local: &Path) -> CopyResult<Outcome> {
    let name = chan.raw.readlink(remote.to_string()).await.map_err(copy::sftp_err)?;
    let Some(target) = name.files.into_iter().next().map(|f| f.filename).filter(|t| !t.is_empty()) else {
        return Err(CopyError::Fatal("El servidor no devolvió el destino del enlace".into()));
    };
    let dest = local_dest(local).await?;
    let lerr = |e: std::io::Error| CopyError::Fatal(local_io_message(&e));
    if dest.is_some() {
        let meta = tokio::fs::symlink_metadata(local).await.map_err(lerr)?;
        if meta.is_dir() {
            return Err(CopyError::Fatal("Ya existe una carpeta con ese nombre (equipo local)".into()));
        }
    } else if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(lerr)?;
    }
    create_local_link(chan, remote, &target, local, dest.is_some()).await
}

#[cfg(unix)]
async fn create_local_link(_chan: &Chan, _remote: &str, target: &str, local: &Path, replace: bool) -> CopyResult<Outcome> {
    let lerr = |e: std::io::Error| CopyError::Fatal(local_io_message(&e));
    if replace {
        remove_link_or_file(local).await.map_err(lerr)?;
    }
    tokio::fs::symlink(target, local).await.map_err(lerr)?;
    Ok(Outcome::Copied(0))
}

/// Windows: crear enlaces simbólicos exige el Modo de desarrollador o permisos de administrador.
/// Si no se puede, el elemento se omite con un aviso (la transferencia sigue) y el archivo que
/// ocupara el nombre no se toca: el enlace se crea primero con un nombre temporal.
#[cfg(windows)]
async fn create_local_link(chan: &Chan, remote: &str, target: &str, local: &Path, replace: bool) -> CopyResult<Outcome> {
    // Objetivo absoluto del servidor (`/usr/…`): no existe en este equipo.
    if target.starts_with('/') {
        return Ok(Outcome::Skipped(
            "es un enlace simbólico a una ruta absoluta del servidor (no se puede recrear en Windows)".into(),
        ));
    }
    let win_target = target.replace('/', "\\");
    // Windows distingue enlaces a carpeta y a archivo: se mira a qué apunta en el servidor.
    let is_dir = chan
        .raw
        .stat(remote.to_string())
        .await
        .is_ok_and(|a| remote_kind(a.attrs.permissions) == RemoteKind::Dir);
    let tmp = if replace {
        let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        local.with_file_name(format!(".{name}.sshorus-{}", uuid::Uuid::new_v4().simple()))
    } else {
        local.to_path_buf()
    };
    let made = if is_dir {
        tokio::fs::symlink_dir(&win_target, &tmp).await
    } else {
        tokio::fs::symlink_file(&win_target, &tmp).await
    };
    if let Err(e) = made {
        // ERROR_PRIVILEGE_NOT_HELD (1314) o acceso denegado: sin permiso para crear enlaces.
        if e.raw_os_error() == Some(1314) || e.kind() == std::io::ErrorKind::PermissionDenied {
            return Ok(Outcome::Skipped(
                "es un enlace simbólico y Windows no permite crearlo sin el Modo de desarrollador o \
                 permisos de administrador"
                    .into(),
            ));
        }
        return Err(CopyError::Fatal(local_io_message(&e)));
    }
    if replace {
        let lerr = |e: std::io::Error| CopyError::Fatal(local_io_message(&e));
        if let Err(e) = remove_link_or_file(local).await {
            let _ = remove_link_or_file(&tmp).await;
            return Err(lerr(e));
        }
        if let Err(e) = tokio::fs::rename(&tmp, local).await {
            let _ = remove_link_or_file(&tmp).await;
            return Err(lerr(e));
        }
    }
    Ok(Outcome::Copied(0))
}

/// Borra un archivo o enlace simbólico local. En Windows los enlaces a carpeta se borran con
/// `remove_dir` (sin tocar lo que hay dentro del objetivo); `remove_file` fallaría.
async fn remove_link_or_file(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if let Ok(m) = tokio::fs::symlink_metadata(path).await
            && m.file_type().is_symlink_dir()
        {
            return tokio::fs::remove_dir(path).await;
        }
    }
    tokio::fs::remove_file(path).await
}

#[cfg(not(any(unix, windows)))]
async fn create_local_link(_chan: &Chan, _remote: &str, _target: &str, _local: &Path, _replace: bool) -> CopyResult<Outcome> {
    Ok(Outcome::Skipped("es un enlace simbólico (no admitido en este sistema)".into()))
}

/// Mensaje de un error SFTP durante un recorrido (y si fue un corte del canal). Marca el
/// canal roto ante cortes y devuelve `CLOSED_MSG` si cayó la conexión entera (así
/// `resume_session` repite el recorrido).
fn walk_msg(e: SftpError, lease: &mut Lease, session: &SshSession) -> (String, bool) {
    match copy::sftp_err(e) {
        CopyError::Transient(m) => {
            lease.mark_broken();
            if session.is_closed() { (CLOSED_MSG.into(), true) } else { (m, true) }
        }
        CopyError::Fatal(m) => (m, false),
        CopyError::Stopped | CopyError::Disconnected => ("Cancelado".into(), false),
    }
}

/// Lista una carpeta remota completa (sin "." ni "..").
async fn read_dir(chan: &Chan, path: &str) -> Result<Vec<SftpFile>, SftpError> {
    let handle = chan.raw.opendir(path.to_string()).await?.handle;
    let mut out = Vec::new();
    let res = loop {
        match chan.raw.readdir(handle.clone()).await {
            Ok(name) => out.extend(name.files.into_iter().filter(|f| f.filename != "." && f.filename != "..")),
            Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    let _ = chan.raw.close(handle).await;
    res.map(|_| out)
}
