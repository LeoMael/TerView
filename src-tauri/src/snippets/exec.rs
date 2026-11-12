//! Ejecutar un comando en un canal `exec` aparte (sin PTY) y capturar su salida.

use std::time::{Duration, Instant};

use russh::{ChannelMsg, Sig};

use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;
use crate::types::ExecResult;

/// Límite por flujo (stdout y stderr por separado).
pub const MAX_STREAM_BYTES: usize = 2 * 1024 * 1024;

pub fn clamp_timeout(secs: u32) -> u64 {
    u64::from(secs.clamp(1, 600))
}

/// Añade `data` a `buf` sin pasar de `MAX_STREAM_BYTES`. Devuelve true si hubo que recortar.
fn push_limited(buf: &mut Vec<u8>, data: &[u8]) -> bool {
    let room = MAX_STREAM_BYTES.saturating_sub(buf.len());
    if data.len() <= room {
        buf.extend_from_slice(data);
        false
    } else {
        buf.extend_from_slice(&data[..room]);
        true
    }
}

/// Ejecuta `command` y espera a que termine o venza `timeout_secs` (1..=600).
pub async fn run(session: &SshSession, command: &str, timeout_secs: u32) -> AppResult<ExecResult> {
    run_inner(session, command, None, timeout_secs).await
}

/// Como [`run`], pero escribe `stdin` en la entrada estándar del comando y después envía EOF.
///
/// `stdin` puede contener contraseñas: NUNCA se registra ni se incluye en mensajes de error.
/// Se escribe a la vez que se lee la salida (un comando que no lee su entrada no bloquea la lectura).
pub async fn run_with_stdin(
    session: &SshSession,
    command: &str,
    stdin: &[u8],
    timeout_secs: u32,
) -> AppResult<ExecResult> {
    run_inner(session, command, Some(stdin), timeout_secs).await
}

async fn run_inner(
    session: &SshSession,
    command: &str,
    stdin: Option<&[u8]>,
    timeout_secs: u32,
) -> AppResult<ExecResult> {
    if command.trim().is_empty() {
        return Err(AppError::Invalid("El comando está vacío".into()));
    }
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(clamp_timeout(timeout_secs));

    let channel = session.open_channel().await?;
    channel.exec(true, command.as_bytes()).await?;
    let (mut reader, writer) = channel.split();

    // Escritura de stdin + EOF, en paralelo con la lectura. Si no hay stdin no se envía nada
    // (mismo comportamiento que antes: el comando ve una entrada abierta sin datos).
    let write_stdin = async {
        if let Some(data) = stdin {
            // Errores de escritura (p. ej. el comando ya terminó y cerró el canal) se ignoran:
            // el resultado real llega por el código de salida. Nunca se formatea `data`.
            if writer.data(data).await.is_ok() {
                let _ = writer.eof().await;
            }
        }
    };
    tokio::pin!(write_stdin);
    let mut writing = stdin.is_some();

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut timed_out = false;
    let mut exit_code: Option<u32> = None;
    let mut signal: Option<String> = None;

    loop {
        let msg = tokio::select! {
            () = &mut write_stdin, if writing => {
                writing = false;
                continue;
            }
            r = tokio::time::timeout_at(deadline, reader.wait()) => r,
        };
        match msg {
            Err(_) => {
                timed_out = true;
                // Intentamos terminar el proceso remoto (no todos los servidores lo aceptan) y cerramos.
                let _ = writer.signal(Sig::TERM).await;
                let _ = writer.eof().await;
                let _ = writer.close().await;
                break;
            }
            Ok(None) => break,
            Ok(Some(msg)) => match msg {
                ChannelMsg::Data { data } => truncated |= push_limited(&mut stdout, &data),
                ChannelMsg::ExtendedData { data, ext: 1 } => truncated |= push_limited(&mut stderr, &data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::ExitSignal { signal_name, .. } => signal = Some(format!("{signal_name:?}")),
                ChannelMsg::Failure => {
                    let _ = writer.close().await;
                    return Err(AppError::Ssh("el servidor rechazó la ejecución del comando".into()));
                }
                ChannelMsg::Close => break,
                _ => {}
            },
        }
    }

    let mut stderr_text = String::from_utf8_lossy(&stderr).into_owned();
    if let (None, Some(sig)) = (exit_code, signal) {
        if !stderr_text.is_empty() && !stderr_text.ends_with('\n') {
            stderr_text.push('\n');
        }
        stderr_text.push_str(&format!("[terminado por la señal {sig}]\n"));
    }

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: stderr_text,
        exit_code,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        truncated,
        timed_out,
    })
}
