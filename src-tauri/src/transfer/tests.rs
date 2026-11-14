//! Pruebas en vivo contra el servidor de pruebas (las unitarias están en `paths.rs`).
//!
//! cargo test --lib transfer -- --ignored --test-threads=1 --nocapture

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;

use super::engine::{Engine, TransferEnv, CLOSED_MSG, WAITING_MSG};
use super::policy::{Conflict, ConflictQuestion, ASK_MSG};
use crate::error::{AppError, AppResult};
use crate::ssh::connect::testutil::connect_test_server;
use crate::ssh::SshSession;
use crate::types::{TransferJob, TransferStatus};

struct TestEnv {
    /// Alias → conexión (se puede cambiar para simular reconexiones).
    sessions: Mutex<HashMap<String, Arc<SshSession>>>,
    concurrency: AtomicUsize,
    policy: Mutex<Conflict>,
    auto_reconnect: AtomicBool,
    updates: Mutex<Vec<TransferJob>>,
    removed: Mutex<Vec<String>>,
    questions: Mutex<Vec<ConflictQuestion>>,
    answered: Mutex<Vec<String>>,
}

impl TransferEnv for TestEnv {
    fn session<'a>(&'a self, id: &'a str) -> BoxFuture<'a, AppResult<Arc<SshSession>>> {
        Box::pin(async move {
            match self.sessions.lock().unwrap().get(id) {
                Some(s) if !s.is_closed() => Ok(s.clone()),
                _ => Err(AppError::SessionNotFound(id.into())),
            }
        })
    }
    fn concurrency(&self) -> usize {
        self.concurrency.load(Ordering::Relaxed)
    }
    fn conflict_policy(&self) -> Conflict {
        *self.policy.lock().unwrap()
    }
    fn auto_reconnect(&self) -> bool {
        self.auto_reconnect.load(Ordering::Relaxed)
    }
    fn emit_update(&self, jobs: Vec<TransferJob>) {
        self.updates.lock().unwrap().extend(jobs);
    }
    fn emit_removed(&self, ids: Vec<String>) {
        self.removed.lock().unwrap().extend(ids);
    }
    fn emit_conflict(&self, question: ConflictQuestion) {
        self.questions.lock().unwrap().push(question);
    }
    fn emit_conflict_done(&self, job_ids: Vec<String>) {
        self.answered.lock().unwrap().extend(job_ids);
    }
}

async fn setup(concurrency: usize) -> (Arc<Engine>, Arc<TestEnv>, Arc<SshSession>) {
    let session = connect_test_server().await;
    let env = Arc::new(TestEnv {
        sessions: Mutex::new(HashMap::from([(session.info.id.clone(), session.clone())])),
        concurrency: AtomicUsize::new(concurrency),
        policy: Mutex::new(Conflict::Overwrite),
        auto_reconnect: AtomicBool::new(true),
        updates: Mutex::new(Vec::new()),
        removed: Mutex::new(Vec::new()),
        questions: Mutex::new(Vec::new()),
        answered: Mutex::new(Vec::new()),
    });
    (Engine::new(env.clone()), env, session)
}

/// Ejecuta un comando en el servidor (para limpiar).
async fn remote_exec(session: &SshSession, cmd: &str) {
    let mut ch = session.open_channel().await.unwrap();
    ch.exec(true, cmd).await.unwrap();
    while let Some(msg) = ch.wait().await {
        if let russh::ChannelMsg::ExitStatus { .. } = msg {
            break;
        }
    }
}

/// Datos pseudoaleatorios reproducibles (xorshift).
fn pseudo_bytes(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sshorus-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn wait_batch(engine: &Engine, batch: &str, limit: Duration) {
    let t0 = Instant::now();
    loop {
        if engine.batch_finished(batch) {
            return;
        }
        assert!(t0.elapsed() < limit, "el lote {batch} no terminó a tiempo");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn batch_jobs(engine: &Engine, batch: &str) -> Vec<TransferJob> {
    engine.list().into_iter().filter(|j| j.batch_id == batch).collect()
}

fn assert_all_done(engine: &Engine, batch: &str) -> (usize, u64) {
    let jobs = batch_jobs(engine, batch);
    let bad: Vec<_> = jobs
        .iter()
        .filter(|j| j.status != TransferStatus::Done)
        .map(|j| format!("{} {:?} {:?}", j.name, j.status, j.error))
        .collect();
    assert!(bad.is_empty(), "trabajos sin terminar: {bad:?}");
    (jobs.len(), jobs.iter().map(|j| j.size).sum())
}

/// Compara dos árboles: mismos archivos, mismos bytes y mismas carpetas (también vacías).
fn assert_same_tree(a: &Path, b: &Path) {
    let list = |root: &Path| -> Vec<(String, bool)> {
        let mut v: Vec<(String, bool)> = walkdir::WalkDir::new(root)
            .min_depth(1)
            .into_iter()
            .map(|e| e.unwrap())
            .map(|e| {
                let rel = e.path().strip_prefix(root).unwrap().to_string_lossy().into_owned();
                (rel, e.file_type().is_dir())
            })
            .collect();
        v.sort();
        v
    };
    let la = list(a);
    let lb = list(b);
    assert_eq!(la, lb, "los árboles difieren");
    for (rel, is_dir) in la {
        if !is_dir {
            let x = std::fs::read(a.join(&rel)).unwrap();
            let y = std::fs::read(b.join(&rel)).unwrap();
            assert!(x == y, "contenido distinto en {rel}");
        }
    }
}

fn mbps(bytes: u64, d: Duration) -> f64 {
    bytes as f64 / 1_048_576.0 / d.as_secs_f64().max(1e-6)
}

#[tokio::test]
#[ignore]
async fn live_roundtrip_tree() {
    let (engine, env, session) = setup(4).await;
    let remote = format!("/config/tmp-xfer-{}", uuid::Uuid::new_v4());
    remote_exec(&session, &format!("mkdir -p {remote}")).await;

    // Árbol: 320 archivos pequeños en carpetas anidadas + carpetas vacías.
    let src = tmp_dir("src");
    let small = src.join("pequenos");
    let mut seed = 1u64;
    for i in 0..8 {
        for j in 0..4 {
            let d = small.join(format!("d{i}")).join(format!("sub{j}"));
            std::fs::create_dir_all(&d).unwrap();
            for k in 0..10 {
                seed += 1;
                let len = ((seed * 7919) % 20_000) as usize;
                std::fs::write(d.join(format!("f{k}.bin")), pseudo_bytes(len, seed)).unwrap();
            }
        }
    }
    std::fs::create_dir_all(small.join("vacia/mas-vacia")).unwrap();
    std::fs::write(small.join("vacio.txt"), b"").unwrap();
    let script = small.join("script.sh");
    std::fs::write(&script, b"#!/bin/sh\necho hola\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // Archivos grandes.
    let big = src.join("grandes");
    std::fs::create_dir_all(big.join("anidada")).unwrap();
    std::fs::write(big.join("a5.bin"), pseudo_bytes(5 * 1024 * 1024 + 123, 77)).unwrap();
    std::fs::write(big.join("anidada/b12.bin"), pseudo_bytes(12 * 1024 * 1024 + 7, 78)).unwrap();
    std::fs::write(big.join("c20.bin"), pseudo_bytes(20 * 1024 * 1024, 79)).unwrap();
    let sid = session.info.id.clone();

    // ── Subida: archivos pequeños
    let t = Instant::now();
    let b1 = engine.upload(sid.clone(), vec![small.to_string_lossy().into()], remote.clone());
    wait_batch(&engine, &b1, Duration::from_secs(120)).await;
    let d_small_up = t.elapsed();
    let (n_small, bytes_small) = assert_all_done(&engine, &b1);
    assert!(n_small >= 320);

    // ── Subida: archivos grandes
    let t = Instant::now();
    let b2 = engine.upload(sid.clone(), vec![big.to_string_lossy().into()], remote.clone());
    wait_batch(&engine, &b2, Duration::from_secs(120)).await;
    let d_big_up = t.elapsed();
    let (_, bytes_big) = assert_all_done(&engine, &b2);

    // ── Bajada de todo
    let dst = tmp_dir("dst");
    let t = Instant::now();
    let b3 = engine.download(sid.clone(), vec![format!("{remote}/pequenos")], dst.to_string_lossy().into());
    wait_batch(&engine, &b3, Duration::from_secs(120)).await;
    let d_small_down = t.elapsed();
    assert_all_done(&engine, &b3);
    let t = Instant::now();
    let b4 = engine.download(sid.clone(), vec![format!("{remote}/grandes")], dst.to_string_lossy().into());
    wait_batch(&engine, &b4, Duration::from_secs(120)).await;
    let d_big_down = t.elapsed();
    assert_all_done(&engine, &b4);

    println!(
        "\n[transfer] {n_small} archivos pequeños ({:.1} MB): subida {:.2?} = {:.0} archivos/s, bajada {:.2?} = {:.0} archivos/s",
        bytes_small as f64 / 1_048_576.0,
        d_small_up,
        n_small as f64 / d_small_up.as_secs_f64(),
        d_small_down,
        n_small as f64 / d_small_down.as_secs_f64(),
    );
    println!(
        "[transfer] grandes ({:.1} MB): subida {:.2?} = {:.1} MB/s, bajada {:.2?} = {:.1} MB/s\n",
        bytes_big as f64 / 1_048_576.0,
        d_big_up,
        mbps(bytes_big, d_big_up),
        d_big_down,
        mbps(bytes_big, d_big_down),
    );

    assert_same_tree(&src, &dst);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::metadata(dst.join("pequenos/script.sh")).unwrap().permissions().mode();
        assert!(m & 0o100 != 0, "se perdió el bit de ejecución (modo {m:o})");
    }

    // Limpiar terminados emite los ids quitados.
    let removed = engine.clear_finished();
    assert!(removed.len() >= n_small);
    assert!(engine.list().is_empty());
    assert_eq!(env.removed.lock().unwrap().len(), removed.len());
    assert!(!env.updates.lock().unwrap().is_empty());

    remote_exec(&session, &format!("rm -rf {remote}")).await;
    std::fs::remove_dir_all(&src).ok();
    std::fs::remove_dir_all(&dst).ok();
}

/// Espera a que un trabajo pase de `min` bytes (o termine).
async fn wait_progress(engine: &Engine, batch: &str, min: u64) -> TransferJob {
    let t0 = Instant::now();
    loop {
        if let Some(j) = batch_jobs(engine, batch).into_iter().next()
            && (j.transferred >= min || j.status == TransferStatus::Done) {
                return j;
            }
        assert!(t0.elapsed() < Duration::from_secs(60), "sin progreso");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

#[tokio::test]
#[ignore]
async fn live_pause_resume_and_cancel() {
    let (engine, _env, session) = setup(2).await;
    let remote = format!("/config/tmp-xfer-{}", uuid::Uuid::new_v4());
    remote_exec(&session, &format!("mkdir -p {remote}")).await;
    let sid = session.info.id.clone();
    let src = tmp_dir("pr-src");
    let size = 96 * 1024 * 1024 + 4321;
    let data = pseudo_bytes(size, 5);
    let file = src.join("grande.bin");
    std::fs::write(&file, &data).unwrap();

    // ── Subida: pausar a mitad y reanudar
    let b = engine.upload(sid.clone(), vec![file.to_string_lossy().into()], remote.clone());
    let j = wait_progress(&engine, &b, 2 * 1024 * 1024).await;
    engine.pause(std::slice::from_ref(&b));
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    let paused = batch_jobs(&engine, &b).remove(0);
    println!("[transfer] subida pausada en {} / {} bytes ({:?})", paused.transferred, size, paused.status);
    if j.status != TransferStatus::Done {
        assert_eq!(paused.status, TransferStatus::Paused);
        assert!(paused.transferred < size as u64);
    }
    engine.resume(std::slice::from_ref(&j.id));
    tokio::time::sleep(Duration::from_millis(50)).await;
    wait_batch(&engine, &b, Duration::from_secs(60)).await;
    assert_all_done(&engine, &b);

    // ── Bajada: pausar a mitad, reanudar y comparar
    let dst = tmp_dir("pr-dst");
    let b = engine.download(sid.clone(), vec![format!("{remote}/grande.bin")], dst.to_string_lossy().into());
    wait_progress(&engine, &b, 2 * 1024 * 1024).await;
    engine.pause(std::slice::from_ref(&b));
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    let paused = batch_jobs(&engine, &b).remove(0);
    println!("[transfer] bajada pausada en {} / {} bytes ({:?})", paused.transferred, size, paused.status);
    engine.resume(std::slice::from_ref(&b));
    tokio::time::sleep(Duration::from_millis(50)).await;
    wait_batch(&engine, &b, Duration::from_secs(60)).await;
    assert_all_done(&engine, &b);
    let got = std::fs::read(dst.join("grande.bin")).unwrap();
    assert!(got == data, "el archivo reanudado difiere");

    // ── Cancelar subida a mitad: el parcial remoto desaparece
    let b = engine.upload(sid.clone(), vec![file.to_string_lossy().into()], format!("{remote}/otra"));
    // (la carpeta "otra" no existe: la subida la crea con mkdir -p)
    let j = wait_progress(&engine, &b, 1024 * 1024).await;
    engine.cancel(std::slice::from_ref(&j.id));
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    let c = batch_jobs(&engine, &b).remove(0);
    if c.status == TransferStatus::Canceled {
        let mut ch = session.open_channel().await.unwrap();
        ch.exec(true, format!("test -e {remote}/otra/grande.bin")).await.unwrap();
        let mut code = None;
        while let Some(msg) = ch.wait().await {
            if let russh::ChannelMsg::ExitStatus { exit_status } = msg {
                code = Some(exit_status);
                break;
            }
        }
        assert_eq!(code, Some(1), "el parcial remoto sigue existiendo");
    } else {
        println!("[transfer] la subida terminó antes de cancelar ({:?})", c.status);
    }

    // ── Cancelar bajada a mitad: el parcial local desaparece
    let dst2 = tmp_dir("pr-dst2");
    let b = engine.download(sid.clone(), vec![format!("{remote}/grande.bin")], dst2.to_string_lossy().into());
    wait_progress(&engine, &b, 1024 * 1024).await;
    engine.cancel(std::slice::from_ref(&b));
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    let c = batch_jobs(&engine, &b).remove(0);
    if c.status == TransferStatus::Canceled {
        assert!(!dst2.join("grande.bin").exists(), "el parcial local sigue existiendo");
    }

    // ── Reintentar: un error (origen inexistente) queda como error y no se cuelga
    let b = engine.download(sid.clone(), vec![format!("{remote}/no-existe")], dst2.to_string_lossy().into());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    let e = batch_jobs(&engine, &b).remove(0);
    assert_eq!(e.status, TransferStatus::Error);
    println!("[transfer] error esperado: {:?}", e.error);

    remote_exec(&session, &format!("rm -rf {remote}")).await;
    std::fs::remove_dir_all(&src).ok();
    std::fs::remove_dir_all(&dst).ok();
    std::fs::remove_dir_all(&dst2).ok();
}

#[tokio::test]
#[ignore]
async fn live_session_gone() {
    let (engine, env, session) = setup(4).await;
    // Sin reconexión automática: falla enseguida.
    env.auto_reconnect.store(false, Ordering::Relaxed);
    let src = tmp_dir("gone");
    std::fs::write(src.join("a.txt"), b"hola").unwrap();
    let b = engine.upload("no-existe".into(), vec![src.join("a.txt").to_string_lossy().into()], "/config".into());
    wait_batch(&engine, &b, Duration::from_secs(10)).await;
    let j = batch_jobs(&engine, &b).remove(0);
    assert_eq!(j.status, TransferStatus::Error);
    assert_eq!(j.error.as_deref(), Some(super::engine::CLOSED_MSG));
    drop(session);
    std::fs::remove_dir_all(&src).ok();
}

// ───────────────────────── Ronda 2: conflictos, enlaces, concurrencia, reconexión ─────────────────────────

/// Ejecuta un comando remoto y devuelve su salida estándar.
async fn remote_out(session: &SshSession, cmd: &str) -> String {
    let mut ch = session.open_channel().await.unwrap();
    ch.exec(true, cmd).await.unwrap();
    let mut out = Vec::new();
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => out.extend_from_slice(&data),
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn set_mtime(path: &Path, secs_ago: u64) {
    let t = std::time::SystemTime::now() - Duration::from_secs(secs_ago);
    std::fs::File::options().write(true).open(path).unwrap().set_modified(t).unwrap();
}

fn status_of(engine: &Engine, batch: &str, name: &str) -> (TransferStatus, Option<String>) {
    let j = batch_jobs(engine, batch)
        .into_iter()
        .find(|j| j.name == name)
        .unwrap_or_else(|| panic!("no hay trabajo {name}"));
    (j.status, j.error)
}

#[tokio::test]
#[ignore]
async fn live_conflict_policies() {
    let (engine, env, session) = setup(4).await;
    let sid = session.info.id.clone();
    let remote = format!("/config/tmp-conf-{}", uuid::Uuid::new_v4());
    // Remoto: a.txt reciente (1 h), b.txt viejo (2 días).
    remote_exec(
        &session,
        &format!(
            "mkdir -p {remote}/pol && printf remoto-a > {remote}/pol/a.txt && printf remoto-b > {remote}/pol/b.txt \
             && touch -d '1 hour ago' {remote}/pol/a.txt && touch -d '2 days ago' {remote}/pol/b.txt"
        ),
    )
    .await;
    // Local: a, b y c con fecha de hace 1 día.
    let src = tmp_dir("conf-src");
    let pol = src.join("pol");
    std::fs::create_dir_all(&pol).unwrap();
    for n in ["a", "b", "c"] {
        let p = pol.join(format!("{n}.txt"));
        std::fs::write(&p, format!("local-{n}")).unwrap();
        set_mtime(&p, 86_400);
    }
    let cat = |f: &'static str| {
        let s = session.clone();
        let r = remote.clone();
        async move { remote_out(&s, &format!("cat {r}/pol/{f}")).await }
    };

    // ── skip: a y b existen → omitidos; c no existe → subido
    *env.policy.lock().unwrap() = Conflict::Skip;
    let b = engine.upload(sid.clone(), vec![pol.to_string_lossy().into()], remote.clone());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_eq!(status_of(&engine, &b, "pol/a.txt").0, TransferStatus::Skipped);
    assert_eq!(status_of(&engine, &b, "pol/b.txt").0, TransferStatus::Skipped);
    assert_eq!(status_of(&engine, &b, "pol/c.txt").0, TransferStatus::Done);
    assert_eq!(cat("a.txt").await, "remoto-a");
    assert_eq!(cat("c.txt").await, "local-c");

    // ── newer: a remoto es más nuevo → omitido; b remoto es más viejo → subido
    *env.policy.lock().unwrap() = Conflict::Newer;
    let b = engine.upload(sid.clone(), vec![pol.to_string_lossy().into()], remote.clone());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    let (st, why) = status_of(&engine, &b, "pol/a.txt");
    assert_eq!(st, TransferStatus::Skipped);
    println!("[conflictos] newer omite a.txt: {why:?}");
    assert_eq!(status_of(&engine, &b, "pol/b.txt").0, TransferStatus::Done);
    // c remoto tiene la misma fecha que el local (se copió la fecha) → omitido
    assert_eq!(status_of(&engine, &b, "pol/c.txt").0, TransferStatus::Skipped);
    assert_eq!(cat("a.txt").await, "remoto-a");
    assert_eq!(cat("b.txt").await, "local-b");

    // ── overwrite: todo se sube
    *env.policy.lock().unwrap() = Conflict::Overwrite;
    let b = engine.upload(sid.clone(), vec![pol.to_string_lossy().into()], remote.clone());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_all_done(&engine, &b);
    assert_eq!(cat("a.txt").await, "local-a");

    // ── Bajadas. Remoto: a reciente (ahora), b de hace 3 días. Local: a y b de hace 1 día.
    remote_exec(
        &session,
        &format!(
            "printf remoto2-a > {remote}/pol/a.txt && printf remoto2-b > {remote}/pol/b.txt \
             && touch -d '3 days ago' {remote}/pol/b.txt"
        ),
    )
    .await;
    let dst = tmp_dir("conf-dst");
    let lpol = dst.join("pol");
    std::fs::create_dir_all(&lpol).unwrap();
    for n in ["a", "b"] {
        let p = lpol.join(format!("{n}.txt"));
        std::fs::write(&p, format!("viejo-{n}")).unwrap();
        set_mtime(&p, 86_400);
    }
    let read = |n: &str| std::fs::read_to_string(lpol.join(n)).unwrap();

    *env.policy.lock().unwrap() = Conflict::Skip;
    let b = engine.download(sid.clone(), vec![format!("{remote}/pol")], dst.to_string_lossy().into());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_eq!(status_of(&engine, &b, "pol/a.txt").0, TransferStatus::Skipped);
    assert_eq!(status_of(&engine, &b, "pol/b.txt").0, TransferStatus::Skipped);
    assert_eq!(status_of(&engine, &b, "pol/c.txt").0, TransferStatus::Done);
    assert_eq!(read("a.txt"), "viejo-a");

    *env.policy.lock().unwrap() = Conflict::Newer;
    let b = engine.download(sid.clone(), vec![format!("{remote}/pol")], dst.to_string_lossy().into());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_eq!(status_of(&engine, &b, "pol/a.txt").0, TransferStatus::Done);
    assert_eq!(status_of(&engine, &b, "pol/b.txt").0, TransferStatus::Skipped);
    assert_eq!(read("a.txt"), "remoto2-a");
    assert_eq!(read("b.txt"), "viejo-b");

    *env.policy.lock().unwrap() = Conflict::Overwrite;
    let b = engine.download(sid.clone(), vec![format!("{remote}/pol")], dst.to_string_lossy().into());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_all_done(&engine, &b);
    assert_eq!(read("b.txt"), "remoto2-b");

    // Limpiar incluye los omitidos.
    engine.clear_finished();
    assert!(engine.list().is_empty());

    remote_exec(&session, &format!("rm -rf {remote}")).await;
    std::fs::remove_dir_all(&src).ok();
    std::fs::remove_dir_all(&dst).ok();
}

#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn live_symlink_roundtrip() {
    use std::os::unix::fs::symlink;
    let (engine, _env, session) = setup(4).await;
    let sid = session.info.id.clone();
    let remote = format!("/config/tmp-links-{}", uuid::Uuid::new_v4());
    remote_exec(&session, &format!("mkdir -p {remote}")).await;

    let src = tmp_dir("links-src");
    let root = src.join("arbol");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("a.txt"), b"hola").unwrap();
    std::fs::write(root.join("sub/b.txt"), b"mundo").unwrap();
    symlink("a.txt", root.join("rel")).unwrap(); // relativo a archivo
    symlink("sub", root.join("dir-link")).unwrap(); // a carpeta (no se sigue)
    symlink("/etc/hostname", root.join("abs")).unwrap(); // absoluto
    symlink("no-existe", root.join("roto")).unwrap(); // colgante
    symlink("..", root.join("sub/bucle")).unwrap(); // bucle: no debe recorrerse

    let b = engine.upload(sid.clone(), vec![root.to_string_lossy().into()], remote.clone());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_all_done(&engine, &b);
    let out = remote_out(
        &session,
        &format!("cd {remote}/arbol && for l in rel dir-link abs roto sub/bucle; do printf '%s=%s\\n' $l \"$(readlink $l)\"; done"),
    )
    .await;
    println!("[enlaces] remoto:\n{out}");
    for (l, t) in [("rel", "a.txt"), ("dir-link", "sub"), ("abs", "/etc/hostname"), ("roto", "no-existe"), ("sub/bucle", "..")] {
        assert!(out.contains(&format!("{l}={t}\n")), "el enlace remoto {l} no apunta a {t}");
    }

    // Bajada: los enlaces vuelven como enlaces locales con el mismo destino.
    let dst = tmp_dir("links-dst");
    let b = engine.download(sid.clone(), vec![format!("{remote}/arbol")], dst.to_string_lossy().into());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_all_done(&engine, &b);
    let back = dst.join("arbol");
    for (l, t) in [("rel", "a.txt"), ("dir-link", "sub"), ("abs", "/etc/hostname"), ("roto", "no-existe"), ("sub/bucle", "..")] {
        let m = std::fs::symlink_metadata(back.join(l)).unwrap();
        assert!(m.file_type().is_symlink(), "{l} no es un enlace");
        assert_eq!(std::fs::read_link(back.join(l)).unwrap(), PathBuf::from(t));
    }
    assert_eq!(std::fs::read(back.join("sub/b.txt")).unwrap(), b"mundo");

    // Volver a bajar con "sobrescribir": los enlaces se reemplazan sin errores.
    let b = engine.download(sid.clone(), vec![format!("{remote}/arbol")], dst.to_string_lossy().into());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_all_done(&engine, &b);
    // Y volver a subir: igual.
    let b = engine.upload(sid.clone(), vec![root.to_string_lossy().into()], remote.clone());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_all_done(&engine, &b);

    remote_exec(&session, &format!("rm -rf {remote}")).await;
    std::fs::remove_dir_all(&src).ok();
    std::fs::remove_dir_all(&dst).ok();
}

#[tokio::test]
#[ignore]
async fn live_per_session_concurrency() {
    const N: usize = 2;
    let (engine, env, s1) = setup(N).await;
    let s2 = connect_test_server().await;
    env.sessions.lock().unwrap().insert(s2.info.id.clone(), s2.clone());
    let remote = format!("/config/tmp-conc-{}", uuid::Uuid::new_v4());
    remote_exec(&s1, &format!("mkdir -p {remote}/uno {remote}/dos")).await;

    let src = tmp_dir("conc");
    let files = src.join("lote");
    std::fs::create_dir_all(&files).unwrap();
    for i in 0..10 {
        std::fs::write(files.join(format!("f{i}.bin")), pseudo_bytes(3 * 1024 * 1024, i)).unwrap();
    }
    let b1 = engine.upload(s1.info.id.clone(), vec![files.to_string_lossy().into()], format!("{remote}/uno"));
    let b2 = engine.upload(s2.info.id.clone(), vec![files.to_string_lossy().into()], format!("{remote}/dos"));

    let (mut max1, mut max2, mut max_total) = (0usize, 0usize, 0usize);
    let t0 = Instant::now();
    while !(engine.batch_finished(&b1) && engine.batch_finished(&b2)) {
        let list = engine.list();
        let run = |sid: &str| list.iter().filter(|j| j.session_id == sid && j.status == TransferStatus::Running).count();
        let (r1, r2) = (run(&s1.info.id), run(&s2.info.id));
        max1 = max1.max(r1);
        max2 = max2.max(r2);
        max_total = max_total.max(r1 + r2);
        assert!(t0.elapsed() < Duration::from_secs(120), "no terminó a tiempo");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    println!("[concurrencia] máx. por sesión: {max1} y {max2}; total simultáneo: {max_total} (límite {N} por sesión)");
    assert!(max1 <= N && max2 <= N, "se superó el límite por sesión");
    assert!(max_total > N, "el límite parece global (total {max_total})");
    assert_all_done(&engine, &b1);
    assert_all_done(&engine, &b2);

    remote_exec(&s1, &format!("rm -rf {remote}")).await;
    std::fs::remove_dir_all(&src).ok();
}

async fn wait_until(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < limit {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    f()
}

#[tokio::test]
#[ignore]
async fn live_resume_session_after_drop() {
    let (engine, env, session_a) = setup(2).await;
    // Alias estable para la sesión (como el sessionId que conserva la reconexión).
    let sid = "sesion-reconectable".to_string();
    env.sessions.lock().unwrap().insert(sid.clone(), session_a.clone());
    let remote = format!("/config/tmp-resume-{}", uuid::Uuid::new_v4());
    remote_exec(&session_a, &format!("mkdir -p {remote}")).await;
    let src = tmp_dir("resume");
    let size = 64 * 1024 * 1024 + 99;
    let data = pseudo_bytes(size, 42);
    std::fs::write(src.join("grande.bin"), &data).unwrap();
    for i in 0..6 {
        std::fs::write(src.join(format!("p{i}.txt")), format!("pequeño {i}")).unwrap();
    }
    let paths = |names: &[&str]| -> Vec<String> { names.iter().map(|n| src.join(n).to_string_lossy().into()).collect() };

    // ── 1) Solo mueren los canales (la conexión sigue): reintento transparente.
    let b = engine.upload(sid.clone(), paths(&["grande.bin"]), remote.clone());
    wait_progress(&engine, &b, 4 * 1024 * 1024).await;
    engine.pools().kill_channels(&sid);
    wait_batch(&engine, &b, Duration::from_secs(90)).await;
    assert_all_done(&engine, &b);
    println!("[reconexión] canales cerrados a mitad: la subida terminó con reintento");

    // ── 2) Cae la conexión entera durante una subida grande + varios archivos en cola.
    let mut names = vec!["grande.bin"];
    let small: Vec<String> = (0..6).map(|i| format!("p{i}.txt")).collect();
    names.extend(small.iter().map(|s| s.as_str()));
    let b = engine.upload(sid.clone(), paths(&names), format!("{remote}/dos"));
    let before = wait_progress(&engine, &b, 8 * 1024 * 1024).await;
    engine.pools().kill_channels(&sid);
    session_a
        .handle
        .disconnect(russh::Disconnect::ByApplication, "prueba", "es")
        .await
        .ok();
    env.sessions.lock().unwrap().remove(&sid);
    assert!(wait_until(Duration::from_secs(5), || session_a.is_closed()).await);

    // Nada pasa a error: todo espera en cola ("Esperando reconexión…").
    let parked = wait_until(Duration::from_secs(15), || {
        let jobs = batch_jobs(&engine, &b);
        jobs.iter().any(|j| j.name == "grande.bin" && j.status == TransferStatus::Queued && j.error.as_deref() == Some(WAITING_MSG))
            && jobs.iter().all(|j| matches!(j.status, TransferStatus::Queued | TransferStatus::Done))
    })
    .await;
    let snapshot: Vec<_> = batch_jobs(&engine, &b).into_iter().map(|j| (j.name, j.status, j.error, j.transferred)).collect();
    assert!(parked, "los trabajos no quedaron esperando: {snapshot:?}");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        batch_jobs(&engine, &b).iter().all(|j| j.status != TransferStatus::Error && j.status != TransferStatus::Running),
        "algún trabajo se ejecutó o falló sin conexión"
    );
    let waiting = batch_jobs(&engine, &b).into_iter().find(|j| j.name == "grande.bin").unwrap();
    println!(
        "[reconexión] en espera: grande.bin en {} bytes (antes del corte {})",
        waiting.transferred, before.transferred
    );

    // Reconecta (conexión nueva, MISMO id) y avisa al motor.
    let session_b = connect_test_server().await;
    env.sessions.lock().unwrap().insert(sid.clone(), session_b.clone());
    env.updates.lock().unwrap().clear();
    engine.resume_session(&sid);
    wait_batch(&engine, &b, Duration::from_secs(120)).await;
    assert_all_done(&engine, &b);
    // El trabajo grande continuó desde su desplazamiento: nunca volvió a bajar de ahí.
    let min_after = env
        .updates
        .lock()
        .unwrap()
        .iter()
        .filter(|j| j.id == waiting.id)
        .map(|j| j.transferred)
        .min()
        .unwrap_or(0);
    println!("[reconexión] tras reanudar, progreso mínimo visto: {min_after} bytes");
    assert!(waiting.transferred > 0, "no había progreso confirmado antes del corte");
    assert!(min_after >= waiting.transferred, "la subida volvió a empezar desde 0");

    // Comparar contenido remoto (bajándolo).
    let dst = tmp_dir("resume-dst");
    let d = engine.download(sid.clone(), vec![format!("{remote}/dos/grande.bin")], dst.to_string_lossy().into());
    wait_batch(&engine, &d, Duration::from_secs(60)).await;
    assert_all_done(&engine, &d);
    assert!(std::fs::read(dst.join("grande.bin")).unwrap() == data, "el archivo reanudado difiere");

    // ── 3) Pérdida definitiva y luego reconexión: los errores por la caída se reanudan.
    let b = engine.upload(sid.clone(), paths(&["grande.bin"]), format!("{remote}/tres"));
    wait_progress(&engine, &b, 4 * 1024 * 1024).await;
    session_b
        .handle
        .disconnect(russh::Disconnect::ByApplication, "prueba", "es")
        .await
        .ok();
    env.sessions.lock().unwrap().remove(&sid);
    assert!(
        wait_until(Duration::from_secs(15), || batch_jobs(&engine, &b)[0].status == TransferStatus::Queued).await,
        "no quedó esperando"
    );
    engine.session_closed(&sid);
    assert!(wait_until(Duration::from_secs(5), || {
        let j = &batch_jobs(&engine, &b)[0];
        j.status == TransferStatus::Error && j.error.as_deref() == Some(CLOSED_MSG)
    })
    .await);
    let session_c = connect_test_server().await;
    env.sessions.lock().unwrap().insert(sid.clone(), session_c.clone());
    engine.resume_session(&sid);
    tokio::time::sleep(Duration::from_millis(50)).await;
    wait_batch(&engine, &b, Duration::from_secs(120)).await;
    assert_all_done(&engine, &b);

    remote_exec(&session_c, &format!("rm -rf {remote}")).await;
    std::fs::remove_dir_all(&src).ok();
    std::fs::remove_dir_all(&dst).ok();
}

// ───────────────────────── Política "preguntar" ─────────────────────────

/// Espera hasta que haya `n` preguntas pendientes en el lote y las devuelve.
async fn wait_questions(engine: &Engine, batch: &str, n: usize) -> Vec<ConflictQuestion> {
    let ok = wait_until(Duration::from_secs(30), || {
        engine.conflicts().iter().filter(|q| q.batch_id == batch).count() >= n
    })
    .await;
    assert!(ok, "no llegaron {n} preguntas");
    engine.conflicts().into_iter().filter(|q| q.batch_id == batch).collect()
}

#[tokio::test]
#[ignore]
async fn live_conflict_ask() {
    let (engine, env, session) = setup(2).await;
    let sid = session.info.id.clone();
    let remote = format!("/config/tmp-ask-{}", uuid::Uuid::new_v4());
    // Remoto: a, b, c y d existen; e no.
    remote_exec(
        &session,
        &format!(
            "mkdir -p {remote}/q && for n in a b c d; do printf remoto-$n > {remote}/q/$n.txt; done \
             && touch -d '2 days ago' {remote}/q/d.txt"
        ),
    )
    .await;
    let src = tmp_dir("ask-src");
    let q = src.join("q");
    std::fs::create_dir_all(&q).unwrap();
    for n in ["a", "b", "c", "d", "e"] {
        std::fs::write(q.join(format!("{n}.txt")), format!("local-{n}")).unwrap();
    }
    set_mtime(&q.join("d.txt"), 86_400);
    let cat = |f: String| {
        let s = session.clone();
        let r = remote.clone();
        async move { remote_out(&s, &format!("cat '{r}/q/{f}'")).await }
    };

    *env.policy.lock().unwrap() = Conflict::Ask;
    let b = engine.upload(sid.clone(), vec![q.to_string_lossy().into()], remote.clone());
    // Las 4 preguntas llegan sin bloquear: e.txt termina mientras tanto.
    let qs = wait_questions(&engine, &b, 4).await;
    assert_eq!(env.questions.lock().unwrap().iter().filter(|x| x.batch_id == b).count(), 4);
    let ok = wait_until(Duration::from_secs(30), || status_of(&engine, &b, "q/e.txt").0 == TransferStatus::Done).await;
    assert!(ok, "e.txt debía subirse sin esperar a las preguntas");
    let by_name = |n: &str| qs.iter().find(|x| x.name == n).unwrap().clone();
    let qa = by_name("q/a.txt");
    assert_eq!(qa.dest_size, Some(8));
    assert_eq!(qa.source_size, Some(7));
    assert!(qa.destination.ends_with("/q/a.txt"));
    assert_eq!(status_of(&engine, &b, "q/a.txt"), (TransferStatus::Queued, Some(ASK_MSG.into())));
    assert!(!engine.batch_finished(&b));

    // Una por una: a → sobrescribir, b → omitir, c → mantener ambos.
    engine.resolve(&qa.job_id, Conflict::Overwrite, false);
    engine.resolve(&by_name("q/b.txt").job_id, Conflict::Skip, false);
    engine.resolve(&by_name("q/c.txt").job_id, Conflict::Rename, false);
    // d → "solo si es más nuevo" para todo el lote (el remoto es más viejo: se sube).
    engine.resolve(&by_name("q/d.txt").job_id, Conflict::Newer, true);
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert!(engine.conflicts().is_empty());
    assert_eq!(status_of(&engine, &b, "q/a.txt").0, TransferStatus::Done);
    assert_eq!(status_of(&engine, &b, "q/b.txt").0, TransferStatus::Skipped);
    assert_eq!(status_of(&engine, &b, "q/c (2).txt").0, TransferStatus::Done);
    assert_eq!(status_of(&engine, &b, "q/d.txt").0, TransferStatus::Done);
    assert_eq!(cat("a.txt".into()).await, "local-a");
    assert_eq!(cat("b.txt".into()).await, "remoto-b");
    assert_eq!(cat("c.txt".into()).await, "remoto-c");
    assert_eq!(cat("c (2).txt".into()).await, "local-c");
    assert_eq!(cat("d.txt".into()).await, "local-d");

    // "Aplicar a todos" con preguntas pendientes: todas se responden de una vez.
    let b = engine.upload(sid.clone(), vec![q.to_string_lossy().into()], remote.clone());
    let qs = wait_questions(&engine, &b, 5).await;
    engine.resolve(&qs[0].job_id, Conflict::Skip, true);
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert!(batch_jobs(&engine, &b).iter().all(|j| j.status == TransferStatus::Skipped));
    let answered = env.answered.lock().unwrap().clone();
    assert!(qs.iter().all(|x| answered.contains(&x.job_id)));

    // Cancelar el lote descarta sus preguntas.
    let b = engine.upload(sid.clone(), vec![q.to_string_lossy().into()], remote.clone());
    let qs = wait_questions(&engine, &b, 5).await;
    engine.cancel(std::slice::from_ref(&b));
    assert!(engine.conflicts().is_empty());
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert!(batch_jobs(&engine, &b).iter().all(|j| j.status == TransferStatus::Canceled));
    let answered = env.answered.lock().unwrap().clone();
    assert!(qs.iter().all(|x| answered.contains(&x.job_id)));

    // Bajada con "mantener ambos": el archivo local existente no se toca.
    let dst = tmp_dir("ask-dst");
    std::fs::write(dst.join("a.txt"), "viejo").unwrap();
    let b = engine.download(sid.clone(), vec![format!("{remote}/q/a.txt")], dst.to_string_lossy().into());
    let qs = wait_questions(&engine, &b, 1).await;
    assert_eq!(qs[0].source_size, Some(7));
    assert_eq!(qs[0].dest_size, Some(5));
    engine.resolve(&qs[0].job_id, Conflict::Rename, false);
    wait_batch(&engine, &b, Duration::from_secs(30)).await;
    assert_all_done(&engine, &b);
    assert_eq!(std::fs::read_to_string(dst.join("a.txt")).unwrap(), "viejo");
    assert_eq!(std::fs::read_to_string(dst.join("a (2).txt")).unwrap(), "local-a");

    engine.clear_finished();
    remote_exec(&session, &format!("rm -rf {remote}")).await;
    std::fs::remove_dir_all(&src).ok();
    std::fs::remove_dir_all(&dst).ok();
}
