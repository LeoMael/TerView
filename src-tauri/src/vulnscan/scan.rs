//! Análisis completo desde el motor, SIN sudo (como el usuario de la conexión).
//!
//! La interfaz no lo usa (ella ejecuta las fases con su elevación y `execId`), pero sirve para las
//! pruebas contra el servidor de pruebas y para reutilizarlo desde otros módulos (p. ej. un servidor
//! MCP que ofrezca `scan_vulnerabilities`). Hace las mismas fases con los mismos scripts.

use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::commands::{analyze_and_save, plan_from, select_images, script_for, ScriptRequest};
use super::model::*;
use crate::error::AppResult;
use crate::snippets::exec;
use crate::ssh::SshSession;
use crate::types::ExecResult;

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub server_id: String,
    pub use_osv: bool,
    pub use_distro_tool: bool,
    pub scan_images: bool,
    pub use_trivy: bool,
    pub image_limit: usize,
    /// Guardar el informe en el historial del servidor.
    pub save: bool,
}

impl ScanOptions {
    pub fn new(server_id: &str) -> Self {
        ScanOptions {
            server_id: server_id.into(),
            use_osv: true,
            use_distro_tool: true,
            scan_images: true,
            use_trivy: true,
            image_limit: 50,
            save: true,
        }
    }
}

fn raw(r: ExecResult) -> RawOutput {
    RawOutput { stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code, timed_out: r.timed_out, truncated: r.truncated }
}

async fn run(session: &SshSession, req: &ScriptRequest, timeout: u32, cancel: &CancellationToken) -> AppResult<RawOutput> {
    let script = script_for(req);
    exec::run_cancellable(session, &script, None, timeout, cancel).await.map(raw)
}

/// Fases 1 a 6 sin elevar. `progress(fase, hechos, total, texto)`.
pub async fn scan_session(
    session: &SshSession,
    opts: &ScanOptions,
    cancel: &CancellationToken,
    progress: super::analyze::ProgressFn<'_>,
) -> AppResult<Report> {
    let started = Instant::now();
    let mut input = ScanInput { server_id: opts.server_id.clone(), use_osv: opts.use_osv, ..Default::default() };

    progress("detect", 0, 1, "Detectando el sistema");
    input.detect = run(session, &ScriptRequest::Detect, 20, cancel).await?;
    let plan = plan_from(&input.detect.stdout);
    input.elevated = plan.is_root;

    progress("inventory", 0, 1, "Inventario de paquetes y programas");
    input.inventory = run(session, &ScriptRequest::Inventory, 60, cancel).await?;

    if opts.use_distro_tool
        && let Some(tool) = plan.distro_tool
    {
        progress("distro", 0, 1, tool.label());
        let req = ScriptRequest::Distro { tool, codename: Some(plan.codename.clone()) };
        match run(session, &req, 300, cancel).await {
            Ok(out) => {
                input.distro_tool = Some(tool);
                input.distro_output = Some(out);
            }
            Err(crate::error::AppError::Canceled) => return Err(crate::error::AppError::Canceled),
            Err(e) => input.notes.push(ScanNote::new("distro", NoteLevel::Warn, format!("{}: {e}", tool.label()))),
        }
    }

    if opts.scan_images {
        let mut engines = Vec::new();
        if plan.podman {
            engines.push(Engine::Podman);
        }
        if plan.docker {
            engines.push(Engine::Docker);
        }
        for engine in engines {
            let listing = run(session, &ScriptRequest::Images { engine, user: None }, 60, cancel).await?;
            let view = select_images(engine, &listing.stdout, opts.image_limit);
            input.images.push(ImageRaw { engine: Some(engine), listing: Some(listing.stdout), ..Default::default() });
            let n = view.selected.len();
            for (i, img) in view.selected.iter().enumerate() {
                progress("images", i, n, &format!("Imagen {} de {n}", i + 1));
                let req = ScriptRequest::Image { engine, user: None, image_id: img.id.clone(), trivy: opts.use_trivy };
                let (output, error) = match run(session, &req, 180, cancel).await {
                    Ok(o) => (Some(o), None),
                    Err(crate::error::AppError::Canceled) => return Err(crate::error::AppError::Canceled),
                    Err(e) => (None, Some(e.to_string())),
                };
                input.images.push(ImageRaw { engine: Some(engine), image_id: img.id.clone(), output, error, ..Default::default() });
            }
        }
    }
    input.server_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(0);
    analyze_and_save(&input, cancel, progress, opts.save).await
}
