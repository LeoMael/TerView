//! Túneles remotos (`-R`): el servidor abre canales `forwarded-tcpip` y aquí se conectan
//! con el destino en tu PC.
//!
//! El manejador SSH (`ssh::handler`) no conoce el `sessionId`, así que las rutas se buscan por
//! servidor (host:puerto de la conexión) + puerto abierto en el servidor. Dos conexiones al mismo
//! servidor no pueden tener el mismo puerto abierto a la vez (el servidor lo impide).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use russh::client::{ChannelOpenHandle, Msg};
use russh::{Channel, ChannelOpenFailure};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use crate::tunnels::io::{Stats, pipe};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RouteKey {
    server_host: String,
    server_port: u16,
    bound_port: u32,
}

impl RouteKey {
    pub fn new(server_host: &str, server_port: u16, bound_port: u32) -> Self {
        Self {
            server_host: server_host.trim().to_ascii_lowercase(),
            server_port,
            bound_port,
        }
    }
}

#[derive(Clone)]
pub struct Route {
    pub dest_host: String,
    pub dest_port: u16,
    pub stats: Arc<Stats>,
    pub cancel: CancellationToken,
}

static ROUTES: LazyLock<Mutex<HashMap<RouteKey, Route>>> = LazyLock::new(Default::default);

pub fn register(key: RouteKey, route: Route) {
    if let Ok(mut m) = ROUTES.lock() {
        m.insert(key, route);
    }
}

pub fn unregister(key: &RouteKey) {
    if let Ok(mut m) = ROUTES.lock() {
        m.remove(key);
    }
}

/// Llamado desde `ClientHandler::server_channel_open_forwarded_tcpip`. No bloquea: la conexión
/// local y la copia van en una tarea aparte. Sin ruta → se rechaza el canal.
pub fn on_forwarded_tcpip(
    server_host: &str,
    server_port: u16,
    channel: Channel<Msg>,
    connected_port: u32,
    reply: ChannelOpenHandle,
) {
    let key = RouteKey::new(server_host, server_port, connected_port);
    let route = ROUTES.lock().ok().and_then(|m| m.get(&key).cloned());
    let Some(route) = route else {
        log::debug!("túnel remoto: canal para el puerto {connected_port} sin túnel activo");
        // Al soltar `reply` se rechaza el canal.
        return;
    };
    if route.cancel.is_cancelled() {
        return;
    }
    tokio::spawn(async move {
        let target = (route.dest_host.as_str(), route.dest_port);
        let res = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(target)).await;
        match res {
            Ok(Ok(tcp)) => {
                let _ = tcp.set_nodelay(true);
                reply.accept().await;
                pipe(tcp, channel.into_stream(), route.stats, route.cancel).await;
            }
            Ok(Err(e)) => {
                route.stats.note_error(format!(
                    "No se pudo conectar con {}:{} en tu PC: {e}",
                    route.dest_host, route.dest_port
                ));
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
            }
            Err(_) => {
                route.stats.note_error(format!(
                    "{}:{} no respondió a tiempo en tu PC",
                    route.dest_host, route.dest_port
                ));
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
            }
        }
    });
}
