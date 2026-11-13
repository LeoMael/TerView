//! Alias de `~/.ssh/config` que de verdad están exportados (para el contexto del asistente).
//!
//! Solo cuenta un servidor si el bloque de TerView tiene su `Host <alias>` con el mismo
//! `HostName`, `User` y `Port`: así el asistente no recibe un alias que ssh no conoce.

use std::collections::HashMap;

use serde::Serialize;

use crate::storage::ssh_config::{assign_aliases_with, split_line, AliasOverrides, BEGIN_MARKER, END_MARKER};
use crate::types::ServerProfile;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedAlias {
    pub server_id: String,
    pub alias: String,
}

#[derive(Debug, Default, Clone)]
struct HostEntry {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
}

/// Entradas `Host` del bloque de TerView (alias → datos). Vacío si no hay bloque.
fn parse_block(config: &str) -> HashMap<String, HostEntry> {
    let mut out: HashMap<String, HostEntry> = HashMap::new();
    let mut inside = false;
    let mut current: Option<String> = None;
    for line in config.lines() {
        let t = line.trim();
        if t == BEGIN_MARKER {
            inside = true;
            continue;
        }
        if t == END_MARKER {
            break;
        }
        if !inside {
            continue;
        }
        let Some((key, args)) = split_line(t) else { continue };
        match key.as_str() {
            "host" => {
                // TerView escribe un solo alias concreto por `Host` (el `Host *` final no cuenta).
                current = args.first().filter(|a| !a.contains(['*', '?', '!'])).cloned();
                if let Some(a) = &current {
                    out.entry(a.clone()).or_default();
                }
            }
            "hostname" | "user" | "port" => {
                let (Some(a), Some(v)) = (&current, args.first()) else { continue };
                let e = out.entry(a.clone()).or_default();
                match key.as_str() {
                    "hostname" => e.hostname = Some(v.clone()),
                    "user" => e.user = Some(v.clone()),
                    _ => e.port = v.parse().ok(),
                }
            }
            _ => {}
        }
    }
    out
}

fn clean(v: &str) -> String {
    v.chars().filter(|c| !c.is_control() && *c != '"').collect::<String>().trim().to_string()
}

/// Servidores cuyo alias está en el bloque de TerView con sus mismos datos.
pub fn exported_aliases(config: &str, servers: &[ServerProfile], overrides: &AliasOverrides) -> Vec<ExportedAlias> {
    let block = parse_block(config);
    if block.is_empty() {
        return Vec::new();
    }
    let aliases = assign_aliases_with(servers, overrides);
    servers
        .iter()
        .zip(aliases)
        .filter(|(s, alias)| {
            block.get(alias).is_some_and(|e| {
                e.hostname.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(&clean(&s.host)))
                    && e.user.as_deref() == Some(clean(&s.username).as_str())
                    && e.port.unwrap_or(22) == s.port
            })
        })
        .map(|(s, alias)| ExportedAlias { server_id: s.id.clone(), alias })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AuthMethod;

    fn srv(id: &str, name: &str, host: &str, user: &str, port: u16) -> ServerProfile {
        ServerProfile {
            id: id.into(),
            name: name.into(),
            host: host.into(),
            port,
            username: user.into(),
            auth: AuthMethod::Key,
            key_path: None,
            default_path: None,
            color: None,
            tmux: None,
            sudo_mode: Default::default(),
        }
    }

    const CONFIG: &str = "Host viejo\n    HostName 9.9.9.9\n\n# >>> TerView (no editar a mano) >>>\nHost web\n    HostName 10.0.0.1\n    User deploy\n\nHost db\n    HostName db.lan\n    Port 2222\n    User root\n\n# Lo que sigue vuelve a aplicarse a todos los hosts\nHost *\n# <<< TerView <<<\nHost otro\n    HostName 1.1.1.1\n";

    #[test]
    fn solo_los_que_coinciden() {
        let servers = vec![
            srv("1", "web", "10.0.0.1", "deploy", 22),
            srv("2", "db", "db.lan", "root", 2222),
            // Cambió de host desde la última exportación: su alias no lleva a él.
            srv("3", "api", "10.0.0.9", "app", 22),
        ];
        let got = exported_aliases(CONFIG, &servers, &AliasOverrides::new());
        assert_eq!(
            got,
            vec![
                ExportedAlias { server_id: "1".into(), alias: "web".into() },
                ExportedAlias { server_id: "2".into(), alias: "db".into() },
            ]
        );
    }

    #[test]
    fn puerto_distinto_no_cuenta() {
        let servers = vec![srv("2", "db", "db.lan", "root", 22)];
        assert!(exported_aliases(CONFIG, &servers, &AliasOverrides::new()).is_empty());
    }

    #[test]
    fn sin_bloque() {
        let servers = vec![srv("1", "web", "10.0.0.1", "deploy", 22)];
        assert!(exported_aliases("Host web\n  HostName 10.0.0.1\n", &servers, &AliasOverrides::new()).is_empty());
    }

    #[test]
    fn alias_elegido_a_mano() {
        let cfg = "# >>> TerView (no editar a mano) >>>\nHost prod-web\n    HostName 10.0.0.1\n    User deploy\n# <<< TerView <<<\n";
        let servers = vec![srv("1", "web", "10.0.0.1", "deploy", 22)];
        let mut o = AliasOverrides::new();
        o.insert("1".into(), "prod-web".into());
        assert_eq!(exported_aliases(cfg, &servers, &o)[0].alias, "prod-web");
    }
}
