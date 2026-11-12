//! Copia bidireccional con contadores (bytes, conexiones) para los túneles.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_util::sync::CancellationToken;

/// Tamaño del búfer de cada sentido.
const BUF: usize = 64 * 1024;

/// Contadores de un túnel en marcha (compartidos con sus conexiones).
#[derive(Default)]
pub struct Stats {
    pub open: AtomicU32,
    pub total: AtomicU64,
    pub up: AtomicU64,
    pub down: AtomicU64,
    /// Algo cambió desde el último aviso a la interfaz.
    pub dirty: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl Stats {
    pub fn note_error(&self, msg: String) {
        log::info!("túnel: {msg}");
        if let Ok(mut e) = self.last_error.lock() {
            *e = Some(msg);
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    /// Cuenta una conexión abierta mientras viva el guardián.
    pub fn connection(self: &Arc<Self>) -> ConnGuard {
        self.open.fetch_add(1, Ordering::Relaxed);
        self.total.fetch_add(1, Ordering::Relaxed);
        self.dirty.store(true, Ordering::Relaxed);
        ConnGuard(self.clone())
    }
}

pub struct ConnGuard(Arc<Stats>);

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::Relaxed);
        self.0.dirty.store(true, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy)]
enum Dir {
    /// Lo leído de aquí va de tu PC al servidor.
    Up,
    /// Lo leído de aquí va del servidor a tu PC.
    Down,
}

/// Envoltura que suma los bytes leídos al contador de su sentido.
struct Counted<S> {
    inner: S,
    stats: Arc<Stats>,
    dir: Dir,
}

impl<S: AsyncRead + Unpin> AsyncRead for Counted<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let res = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &res {
            let n = (buf.filled().len() - before) as u64;
            if n > 0 {
                let c = match self.dir {
                    Dir::Up => &self.stats.up,
                    Dir::Down => &self.stats.down,
                };
                c.fetch_add(n, Ordering::Relaxed);
                self.stats.dirty.store(true, Ordering::Relaxed);
            }
        }
        res
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counted<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Une `local` (lado de tu PC) con `remote` (canal SSH) hasta que ambos terminen o se cancele.
pub async fn pipe<L, R>(local: L, remote: R, stats: Arc<Stats>, cancel: CancellationToken)
where
    L: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin,
{
    let _guard = stats.connection();
    let mut a = Counted {
        inner: local,
        stats: stats.clone(),
        dir: Dir::Up,
    };
    let mut b = Counted {
        inner: remote,
        stats,
        dir: Dir::Down,
    };
    tokio::select! {
        _ = cancel.cancelled() => {}
        r = tokio::io::copy_bidirectional_with_sizes(&mut a, &mut b, BUF, BUF) => {
            if let Err(e) = r {
                log::debug!("túnel: conexión terminada con error: {e}");
            }
        }
    }
}
