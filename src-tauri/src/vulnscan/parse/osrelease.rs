//! `/etc/os-release` (formato CLAVE=valor, con o sin comillas).

use crate::vulnscan::model::OsRelease;

fn unquote(v: &str) -> String {
    let v = v.trim();
    let inner = if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
        &v[1..v.len() - 1]
    } else {
        v
    };
    inner.replace("\\\"", "\"").replace("\\$", "$").replace("\\\\", "\\")
}

pub fn parse(text: &str) -> OsRelease {
    let mut os = OsRelease::default();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = unquote(v);
        match k.trim() {
            "ID" => os.id = v.to_ascii_lowercase(),
            "ID_LIKE" => os.id_like = v.split_whitespace().map(|s| s.to_ascii_lowercase()).collect(),
            "VERSION_ID" => os.version_id = v,
            "VERSION" => os.version = v,
            "VERSION_CODENAME" => os.version_codename = v,
            "UBUNTU_CODENAME" if os.version_codename.is_empty() => os.version_codename = v,
            "PRETTY_NAME" => os.pretty_name = v,
            "NAME" => os.name = v,
            _ => {}
        }
    }
    os
}

impl OsRelease {
    /// Nombre para mostrar: «Debian GNU/Linux 12 (bookworm)».
    pub fn display(&self) -> String {
        if !self.pretty_name.is_empty() {
            self.pretty_name.clone()
        } else if !self.name.is_empty() {
            format!("{} {}", self.name, self.version_id).trim().to_string()
        } else {
            self.id.clone()
        }
    }

    /// Es (o deriva de) esta distro.
    pub fn is_like(&self, id: &str) -> bool {
        self.id == id || self.id_like.iter().any(|x| x == id)
    }
}
