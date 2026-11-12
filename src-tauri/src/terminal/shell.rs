//! Núcleo de la terminal, independiente de Tauri: abre una shell con PTY sobre un
//! canal SSH y la atiende con una tarea tokio.

use std::sync::Arc;
use std::time::Duration;

use russh::{ChannelMsg, Pty};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;

/// Tiempo máximo que se retiene la salida antes de enviarla a la interfaz.
const FLUSH_DELAY: Duration = Duration::from_millis(6);
/// Tamaño a partir del cual se envía la salida sin esperar.
const FLUSH_BYTES: usize = 64 * 1024;
/// Si tras pedir el cierre el servidor no responde, se abandona el canal.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

/// Modos de terminal razonables para una shell interactiva (xterm.js envía DEL para borrar).
const TERMINAL_MODES: &[(Pty, u32)] = &[
    (Pty::VINTR, 3),     // Ctrl+C
    (Pty::VQUIT, 28),    // Ctrl+\
    (Pty::VERASE, 127),  // Retroceso = DEL
    (Pty::VKILL, 21),    // Ctrl+U
    (Pty::VEOF, 4),      // Ctrl+D
    (Pty::VSUSP, 26),    // Ctrl+Z
    (Pty::ICRNL, 1),
    (Pty::IUTF8, 1),
    (Pty::ECHO, 1),
    (Pty::ECHOE, 1),
    (Pty::ECHOK, 1),
    (Pty::ISIG, 1),
    (Pty::ICANON, 1),
    (Pty::IEXTEN, 1),
    (Pty::OPOST, 1),
    (Pty::ONLCR, 1),
    (Pty::TTY_OP_ISPEED, 38400),
    (Pty::TTY_OP_OSPEED, 38400),
];

#[derive(Debug)]
enum TermCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// Mando de una shell en marcha. Clonable; la tarea termina sola al cerrarse el canal.
#[derive(Clone)]
pub struct TerminalHandle {
    tx: mpsc::UnboundedSender<TermCmd>,
}

impl TerminalHandle {
    fn send(&self, cmd: TermCmd) -> AppResult<()> {
        self.tx
            .send(cmd)
            .map_err(|_| AppError::NotFound("la terminal ya terminó".into()))
    }

    pub fn write(&self, data: Vec<u8>) -> AppResult<()> {
        self.send(TermCmd::Write(data))
    }

    pub fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.send(TermCmd::Resize(cols.max(1), rows.max(1)))
    }

    pub fn close(&self) {
        let _ = self.tx.send(TermCmd::Close);
    }

    /// true cuando la tarea de la shell ya terminó.
    pub fn is_finished(&self) -> bool {
        self.tx.is_closed()
    }
}

/// Qué se arranca en la terminal.
#[derive(Debug, Clone)]
pub enum ShellStart {
    /// La shell de login del usuario.
    Shell,
    /// Un comando con PTY (p. ej. engancharse a una sesión tmux).
    Exec(String),
}

/// Abre una shell interactiva. `on_data` recibe la salida (agrupada); `on_exit` se llama
/// una vez al terminar, con el código de salida si el servidor lo envió.
#[cfg(test)]
pub async fn spawn_shell(
    session: Arc<SshSession>,
    cols: u32,
    rows: u32,
    on_data: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
) -> AppResult<TerminalHandle> {
    spawn_terminal(session, ShellStart::Shell, cols, rows, on_data, on_exit).await
}

/// Abre una terminal con PTY: la shell de login o un comando (tmux). `on_data` recibe la salida
/// (agrupada); `on_exit` se llama una vez al terminar, con el código de salida si el servidor lo envió.
pub async fn spawn_terminal(
    session: Arc<SshSession>,
    start: ShellStart,
    cols: u32,
    rows: u32,
    on_data: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
) -> AppResult<TerminalHandle> {
    let mut channel = session.open_channel().await?;
    let setup = async {
        channel
            .request_pty(false, "xterm-256color", cols.max(1), rows.max(1), 0, 0, TERMINAL_MODES)
            .await?;
        // Pedimos respuesta para detectar un rechazo del servidor.
        match &start {
            ShellStart::Shell => channel.request_shell(true).await?,
            ShellStart::Exec(cmd) => channel.exec(true, cmd.as_bytes()).await?,
        }
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(Vec::new()),
                Some(ChannelMsg::Failure) => {
                    return Err(AppError::Ssh("el servidor rechazó abrir la shell".into()))
                }
                // Salida que llegue antes de la confirmación: se conserva.
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    return Ok(data.to_vec());
                }
                Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                    return Err(AppError::Ssh("el canal se cerró al abrir la shell".into()))
                }
                Some(_) => {}
            }
        }
    };
    let early = match tokio::time::timeout(Duration::from_secs(15), setup).await {
        Ok(Ok(early)) => early,
        Ok(Err(e)) => {
            let _ = channel.close().await;
            return Err(e);
        }
        Err(_) => {
            let _ = channel.close().await;
            return Err(AppError::Network("el servidor no respondió al abrir la shell".into()));
        }
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();

    tokio::spawn(async move {
        let _session = session; // mantiene viva la conexión mientras dure la shell
        let mut buf: Vec<u8> = early;
        let mut deadline: Option<Instant> = if buf.is_empty() { None } else { Some(Instant::now()) };
        let mut exit_code: Option<u32> = None;
        let mut closing_since: Option<Instant> = None;
        let mut cmds_open = true;

        loop {
            let close_deadline = closing_since.map(|t| t + CLOSE_TIMEOUT);
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        buf.extend_from_slice(&data);
                        if buf.len() >= FLUSH_BYTES {
                            flush(&on_data, &mut buf);
                            deadline = None;
                        } else if deadline.is_none() {
                            deadline = Some(Instant::now() + FLUSH_DELAY);
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                    Some(ChannelMsg::Eof) => {}
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                cmd = rx.recv(), if cmds_open => match cmd {
                    Some(TermCmd::Write(bytes)) => {
                        if let Err(e) = channel.data_bytes(bytes).await {
                            log::warn!("terminal: error al escribir: {e}");
                            break;
                        }
                    }
                    Some(TermCmd::Resize(c, r)) => {
                        if let Err(e) = channel.window_change(c, r, 0, 0).await {
                            log::warn!("terminal: error al redimensionar: {e}");
                        }
                    }
                    Some(TermCmd::Close) | None => {
                        // None: se soltaron todos los mandos → cerrar igualmente.
                        cmds_open = false;
                        if closing_since.is_none() {
                            closing_since = Some(Instant::now());
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                        }
                    }
                },
                _ = sleep_opt(deadline) => {
                    flush(&on_data, &mut buf);
                    deadline = None;
                }
                _ = sleep_opt(close_deadline) => break,
            }
        }

        flush(&on_data, &mut buf);
        // Primero se suelta el receptor (is_finished = true) y luego se avisa.
        drop(rx);
        drop(channel);
        on_exit(exit_code);
    });

    Ok(TerminalHandle { tx })
}

fn flush(on_data: &impl Fn(Vec<u8>), buf: &mut Vec<u8>) {
    if !buf.is_empty() {
        on_data(std::mem::take(buf));
    }
}

async fn sleep_opt(at: Option<Instant>) {
    match at {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::connect::testutil::connect_test_server;

    async fn read_until(
        rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
        acc: &mut String,
        needle: &str,
    ) -> bool {
        let fut = async {
            while !acc.contains(needle) {
                match rx.recv().await {
                    Some(d) => acc.push_str(&String::from_utf8_lossy(&d)),
                    None => return false,
                }
            }
            true
        };
        tokio::time::timeout(Duration::from_secs(10), fut).await.unwrap_or(false)
    }

    #[tokio::test]
    #[ignore]
    async fn shell_echo_resize_exit() {
        let session = connect_test_server().await;
        let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<Option<u32>>();
        let handle = spawn_shell(
            session,
            100,
            30,
            move |d| {
                let _ = data_tx.send(d);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .await
        .expect("abrir shell");

        handle.write(b"echo hola-$((1+1))\n".to_vec()).expect("write");
        let mut out = String::new();
        assert!(read_until(&mut data_rx, &mut out, "hola-2").await, "salida: {out:?}");

        handle.resize(120, 40).expect("resize");
        out.clear();
        handle.write(b"stty size\n".to_vec()).expect("write");
        assert!(read_until(&mut data_rx, &mut out, "40 120").await, "salida: {out:?}");

        handle.write(b"exit 3\n".to_vec()).expect("write");
        let code = tokio::time::timeout(Duration::from_secs(10), exit_rx)
            .await
            .expect("on_exit a tiempo")
            .expect("on_exit llamado");
        assert_eq!(code, Some(3));
        assert!(handle.is_finished());
        assert!(handle.write(b"x".to_vec()).is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn close_from_client_calls_on_exit() {
        let session = connect_test_server().await;
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<Option<u32>>();
        let handle = spawn_shell(session, 80, 24, |_| {}, move |code| {
            let _ = exit_tx.send(code);
        })
        .await
        .expect("abrir shell");
        handle.close();
        tokio::time::timeout(Duration::from_secs(10), exit_rx)
            .await
            .expect("on_exit a tiempo")
            .expect("on_exit llamado");
        assert!(handle.is_finished());
    }

    #[tokio::test]
    #[ignore]
    async fn big_output_is_coalesced() {
        let session = connect_test_server().await;
        let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let handle = spawn_shell(session, 80, 24, move |d| {
            let _ = data_tx.send(d);
        }, |_| {})
        .await
        .expect("abrir shell");
        handle
            .write(b"seq 1 200000; echo FIN-$((2*3))\n".to_vec())
            .expect("write");
        let mut chunks = 0usize;
        let mut total = 0usize;
        let mut acc = String::new();
        let done = tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(d) = data_rx.recv().await {
                chunks += 1;
                total += d.len();
                acc.push_str(&String::from_utf8_lossy(&d));
                if acc.contains("FIN-6") {
                    return true;
                }
                if acc.len() > 4096 {
                    acc.drain(..acc.len() - 64);
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(done);
        // ~1.3 MB: sin agrupar serían cientos de paquetes de 32 KB o menos.
        assert!(total > 1_000_000);
        assert!(chunks < total / 4096, "chunks={chunks} total={total}");
        handle.close();
    }
}
