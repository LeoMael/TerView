//! Servidor SOCKS5 mínimo (RFC 1928): sin autenticación, solo CONNECT, IPv4/IPv6/dominio.

use std::net::{Ipv4Addr, Ipv6Addr};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const VER: u8 = 5;
const NO_AUTH: u8 = 0;
const NO_ACCEPTABLE: u8 = 0xFF;
const CMD_CONNECT: u8 = 1;

/// Respuestas (campo REP).
pub const REP_OK: u8 = 0;
pub const REP_FAILURE: u8 = 1;
pub const REP_NOT_ALLOWED: u8 = 2;
pub const REP_HOST_UNREACHABLE: u8 = 4;
pub const REP_REFUSED: u8 = 5;
const REP_CMD_UNSUPPORTED: u8 = 7;
const REP_ATYP_UNSUPPORTED: u8 = 8;

/// Negocia y lee la petición. Devuelve el destino (host, puerto); la respuesta final la manda
/// `reply` cuando se sepa si el servidor pudo conectar.
pub async fn handshake<S>(s: &mut S) -> Result<(String, u16), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let io = |e: std::io::Error| format!("SOCKS: {e}");
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await.map_err(io)?;
    if head[0] != VER {
        return Err(format!(
            "SOCKS: versión {} no soportada (solo SOCKS5)",
            head[0]
        ));
    }
    let mut methods = vec![0u8; usize::from(head[1])];
    s.read_exact(&mut methods).await.map_err(io)?;
    if !methods.contains(&NO_AUTH) {
        let _ = s.write_all(&[VER, NO_ACCEPTABLE]).await;
        return Err("SOCKS: el cliente exige autenticación (no soportada)".into());
    }
    s.write_all(&[VER, NO_AUTH]).await.map_err(io)?;

    let mut req = [0u8; 4];
    s.read_exact(&mut req).await.map_err(io)?;
    if req[0] != VER {
        return Err("SOCKS: petición mal formada".into());
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await.map_err(io)?;
            Ipv4Addr::from(a).to_string()
        }
        3 => {
            let len = s.read_u8().await.map_err(io)?;
            let mut name = vec![0u8; usize::from(len)];
            s.read_exact(&mut name).await.map_err(io)?;
            String::from_utf8(name).map_err(|_| "SOCKS: nombre de dominio no válido".to_string())?
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await.map_err(io)?;
            Ipv6Addr::from(a).to_string()
        }
        other => {
            let _ = reply(s, REP_ATYP_UNSUPPORTED).await;
            return Err(format!("SOCKS: tipo de dirección {other} no soportado"));
        }
    };
    let port = s.read_u16().await.map_err(io)?;
    if req[1] != CMD_CONNECT {
        let _ = reply(s, REP_CMD_UNSUPPORTED).await;
        return Err("SOCKS: solo se admite CONNECT (no BIND ni UDP)".into());
    }
    if host.is_empty() || port == 0 {
        let _ = reply(s, REP_HOST_UNREACHABLE).await;
        return Err("SOCKS: destino vacío".into());
    }
    Ok((host, port))
}

/// Respuesta a la petición (dirección enlazada 0.0.0.0:0: los clientes no la usan para CONNECT).
pub async fn reply<S: AsyncWrite + Unpin>(s: &mut S, rep: u8) -> std::io::Result<()> {
    s.write_all(&[VER, rep, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    s.flush().await
}
