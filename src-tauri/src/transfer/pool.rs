//! Reserva de canales SFTP por sesión.
//!
//! Abrir un canal SFTP cuesta varios viajes de ida y vuelta (canal + subsistema + init +
//! límites). Con miles de archivos pequeños eso domina el tiempo, así que cada sesión
//! guarda hasta `MAX_CHANNELS` canales y los trabajos los toman prestados y devuelven.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use russh_sftp::client::rawsession::Limits;
use russh_sftp::client::{Config, RawSftpSession};
use russh_sftp::extensions::LIMITS;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::AppResult;
use crate::ssh::SshSession;

/// Canales por sesión: el límite de trabajos simultáneos es POR SESIÓN (máx. 8) + margen
/// para los recorridos de carpetas. Cada sesión tiene su propia reserva.
pub const MAX_CHANNELS: usize = 10;
/// Tamaño de bloque preferido (≈256 KB; OpenSSH acepta 261 120 bytes por paquete).
pub const CHUNK: usize = 255 * 1024;
/// Bytes en vuelo por archivo (lecturas/escrituras encadenadas sin esperar respuesta).
pub const INFLIGHT_BYTES: usize = 4 * 1024 * 1024;
/// Canales ociosos más viejos que esto se cierran.
const IDLE_TTL: Duration = Duration::from_secs(60);

/// Un canal SFTP abierto con sus límites ya negociados.
pub struct Chan {
    pub raw: RawSftpSession,
    pub write_chunk: usize,
    pub read_chunk: usize,
}

impl Chan {
    pub async fn open(session: &SshSession) -> AppResult<Chan> {
        let channel = session.open_channel().await?;
        channel.request_subsystem(true, "sftp").await?;
        let cfg = Config {
            // Con varios archivos en paralelo por un enlace lento, una respuesta puede tardar.
            request_timeout_secs: 120,
            ..Config::default()
        };
        let max_packet = cfg.max_packet_len as usize;
        let mut raw = RawSftpSession::new_with_config(channel.into_stream(), cfg);
        let version = raw.init().await?;
        let mut write_chunk = 32 * 1024;
        let mut read_chunk = 32 * 1024;
        if version.extensions.get(LIMITS).is_some_and(|v| v == "1") {
            let limits = Limits::from(raw.limits().await?);
            raw.set_limits(limits);
            // Margen para la cabecera de lectura (13 bytes) dentro del paquete máximo.
            let cap = CHUNK.min(max_packet.saturating_sub(64));
            if let Some(w) = limits.write_len {
                write_chunk = (w as usize).min(cap);
            }
            if let Some(r) = limits.read_len {
                read_chunk = (r as usize).min(cap);
            }
            if let Some(p) = limits.packet_len {
                let p = (p as usize).saturating_sub(1024).max(4096);
                write_chunk = write_chunk.min(p);
                read_chunk = read_chunk.min(p);
            }
        }
        Ok(Chan {
            raw,
            write_chunk: write_chunk.max(4096),
            read_chunk: read_chunk.max(4096),
        })
    }

    /// Cuántas peticiones encadenar para tener ~`INFLIGHT_BYTES` en vuelo.
    pub fn depth(chunk: usize) -> usize {
        (INFLIGHT_BYTES / chunk.max(1)).clamp(4, 128)
    }
}

struct Idle {
    chan: Arc<Chan>,
    since: Instant,
}

/// Canales de UNA conexión SSH.
pub struct Pool {
    /// Conexión dueña de los canales: si la sesión se reconecta (mismo id, conexión nueva)
    /// la reserva vieja se descarta.
    owner: Weak<SshSession>,
    sem: Arc<Semaphore>,
    idle: Mutex<Vec<Idle>>,
    /// Solo pruebas: todos los canales abiertos (para simular caídas).
    #[cfg(test)]
    all: Mutex<Vec<Weak<Chan>>>,
}

impl Pool {
    fn new(owner: &Arc<SshSession>) -> Self {
        Pool {
            owner: Arc::downgrade(owner),
            sem: Arc::new(Semaphore::new(MAX_CHANNELS)),
            idle: Mutex::new(Vec::new()),
            #[cfg(test)]
            all: Mutex::new(Vec::new()),
        }
    }

    fn pop_idle(&self) -> Option<Arc<Chan>> {
        let mut idle = self.idle.lock().ok()?;
        let now = Instant::now();
        idle.retain(|i| now.duration_since(i.since) < IDLE_TTL);
        idle.pop().map(|i| i.chan)
    }

    fn push_idle(&self, chan: Arc<Chan>) {
        if let Ok(mut idle) = self.idle.lock() {
            idle.push(Idle {
                chan,
                since: Instant::now(),
            });
        }
    }

    fn sweep(&self) {
        if let Ok(mut idle) = self.idle.lock() {
            let now = Instant::now();
            idle.retain(|i| now.duration_since(i.since) < IDLE_TTL);
        }
    }
}

/// Préstamo de un canal. Al soltarlo vuelve a la reserva salvo que se marque roto.
pub struct Lease {
    chan: Arc<Chan>,
    pool: Arc<Pool>,
    broken: bool,
    _permit: OwnedSemaphorePermit,
}

impl Lease {
    pub fn chan(&self) -> &Chan {
        &self.chan
    }

    /// El canal falló (se cortó, expiró…): no se devuelve a la reserva.
    pub fn mark_broken(&mut self) {
        self.broken = true;
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if !self.broken {
            self.pool.push_idle(self.chan.clone());
        }
    }
}

/// Todas las reservas: sessionId → Pool.
#[derive(Default)]
pub struct Pools {
    pools: Mutex<HashMap<String, Arc<Pool>>>,
}

impl Pools {
    fn pool(&self, session_id: &str, session: &Arc<SshSession>) -> Arc<Pool> {
        let mut map = match self.pools.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        let current = Arc::downgrade(session);
        match map.get(session_id) {
            Some(p) if Weak::ptr_eq(&p.owner, &current) => p.clone(),
            _ => {
                let p = Arc::new(Pool::new(session));
                map.insert(session_id.to_string(), p.clone());
                p
            }
        }
    }

    /// Toma un canal de la sesión `session_id` (reutiliza uno ocioso o abre otro).
    pub async fn lease(&self, session_id: &str, session: &Arc<SshSession>) -> AppResult<Lease> {
        let pool = self.pool(session_id, session);
        let permit = pool
            .sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| crate::error::AppError::Canceled)?;
        let chan = match pool.pop_idle() {
            Some(c) => c,
            None => {
                let c = Arc::new(Chan::open(session).await?);
                #[cfg(test)]
                if let Ok(mut all) = pool.all.lock() {
                    all.push(Arc::downgrade(&c));
                }
                c
            }
        };
        Ok(Lease {
            chan,
            pool,
            broken: false,
            _permit: permit,
        })
    }

    /// Cierra los canales ociosos de una sesión y la olvida (se cerró o se reconectó).
    pub fn drop_session(&self, session_id: &str) {
        let old = match self.pools.lock() {
            Ok(mut map) => map.remove(session_id),
            Err(_) => None,
        };
        if let Some(p) = old
            && let Ok(mut idle) = p.idle.lock()
        {
            for i in idle.drain(..) {
                let _ = i.chan.raw.close_session();
            }
        }
    }

    /// Solo pruebas: cierra a la fuerza los canales SFTP de una sesión (ociosos y prestados)
    /// para simular una caída.
    #[cfg(test)]
    pub fn kill_channels(&self, session_id: &str) {
        let pool = match self.pools.lock() {
            Ok(map) => map.get(session_id).cloned(),
            Err(_) => None,
        };
        if let Some(p) = pool {
            if let Ok(idle) = p.idle.lock() {
                for i in idle.iter() {
                    let _ = i.chan.raw.close_session();
                }
            }
            if let Ok(all) = p.all.lock() {
                for c in all.iter().filter_map(|w| w.upgrade()) {
                    let _ = c.raw.close_session();
                }
            }
        }
    }

    /// Cierra canales ociosos viejos.
    pub fn sweep(&self) {
        let pools: Vec<Arc<Pool>> = match self.pools.lock() {
            Ok(m) => m.values().cloned().collect(),
            Err(_) => return,
        };
        for p in pools {
            p.sweep();
        }
    }
}
