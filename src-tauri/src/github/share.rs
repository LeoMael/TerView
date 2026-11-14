//! Colecciones de comandos compartidas por gist o por archivo de un repo de GitHub.
//!
//! Formato (JSON): una lista de `Snippet` o `{ "format": "sshorus-commands", "version": 1, "snippets": [...] }`.
//! Al importar se aceptan campos parciales (solo `name` y `command` son obligatorios) y todos quedan
//! como comandos globales nuevos (id "", sin servidor/proyecto: esos ids no existen en otra PC).

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::types::{Snippet, SnippetScope};

pub const FORMAT: &str = "sshorus-commands";
pub const MAX_SNIPPETS: usize = 1000;
const MAX_FIELD: usize = 64 * 1024;

/// De dónde sacar la colección.
#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    Gist(String),
    /// URL https de raw.githubusercontent.com o gist.githubusercontent.com.
    Raw(String),
}

/// Interpreta lo que pegó el usuario: id de gist, URL de gist, URL raw o URL `blob` de github.com.
pub fn resolve(input: &str) -> AppResult<Source> {
    let s = input.trim();
    let bad = || {
        AppError::Invalid(
            "Pega el enlace de un gist, de un archivo de GitHub (…/blob/…) o de raw.githubusercontent.com".into(),
        )
    };
    if super::api::valid_gist_id(s) {
        return Ok(Source::Gist(s.to_ascii_lowercase()));
    }
    let url = reqwest::Url::parse(s).map_err(|_| bad())?;
    if url.scheme() != "https" {
        return Err(bad());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let segs: Vec<&str> = url
        .path_segments()
        .map(|p| p.filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    match host.as_str() {
        "gist.github.com" => {
            // /usuario/id  o  /id
            let id = segs.last().ok_or_else(bad)?;
            if super::api::valid_gist_id(id) {
                Ok(Source::Gist(id.to_ascii_lowercase()))
            } else {
                Err(bad())
            }
        }
        "raw.githubusercontent.com" | "gist.githubusercontent.com" => {
            let mut u = url.clone();
            u.set_query(None);
            u.set_fragment(None);
            Ok(Source::Raw(u.to_string()))
        }
        "github.com" => {
            // /dueño/repo/blob/rama/ruta…  →  raw.githubusercontent.com/dueño/repo/rama/ruta…
            if segs.len() >= 5 && segs[2] == "blob" {
                let rest = segs[3..].join("/");
                Ok(Source::Raw(format!(
                    "https://raw.githubusercontent.com/{}/{}/{rest}",
                    segs[0], segs[1]
                )))
            } else {
                Err(bad())
            }
        }
        _ => Err(bad()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LooseSnippet {
    name: Option<String>,
    command: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    dangerous: bool,
    #[serde(default)]
    sudo: bool,
    #[serde(default)]
    read_only: bool,
}

fn cut(s: String) -> String {
    if s.len() <= MAX_FIELD {
        return s;
    }
    let mut end = MAX_FIELD;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Lee una colección (lista o `{snippets: [...]}`) y devuelve comandos globales nuevos.
pub fn parse_collection(text: &str) -> AppResult<Vec<Snippet>> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| AppError::Invalid(format!("el archivo no es un JSON válido: {e}")))?;
    let items = match &v {
        Value::Array(a) => a.clone(),
        Value::Object(o) => match o.get("snippets").or_else(|| o.get("commands")) {
            Some(Value::Array(a)) => a.clone(),
            _ => {
                return Err(AppError::Invalid(
                    "el JSON no contiene una lista de comandos («snippets»)".into(),
                ));
            }
        },
        _ => {
            return Err(AppError::Invalid(
                "el JSON no contiene una lista de comandos".into(),
            ));
        }
    };
    if items.len() > MAX_SNIPPETS {
        return Err(AppError::Invalid(format!(
            "demasiados comandos (máximo {MAX_SNIPPETS})"
        )));
    }
    let mut out = Vec::new();
    for it in items {
        let Ok(l) = serde_json::from_value::<LooseSnippet>(it) else {
            continue;
        };
        let name = l.name.map(|s| s.trim().to_string()).unwrap_or_default();
        let command = l.command.map(|s| s.trim().to_string()).unwrap_or_default();
        if name.is_empty() || command.is_empty() {
            continue;
        }
        out.push(Snippet {
            id: String::new(),
            name: cut(name),
            description: l
                .description
                .map(|d| cut(d.trim().to_string()))
                .filter(|d| !d.is_empty()),
            command: cut(command),
            category: l
                .category
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| "Importados".into()),
            scope: SnippetScope::Global,
            scope_id: None,
            dangerous: l.dangerous,
            sudo: l.sudo,
            read_only: l.read_only,
        });
    }
    if out.is_empty() {
        return Err(AppError::Invalid(
            "no se encontró ningún comando válido (cada uno necesita «name» y «command»)".into(),
        ));
    }
    Ok(out)
}

/// JSON para publicar una colección (sin ids ni ámbitos locales).
pub fn to_collection(snippets: &[Snippet]) -> AppResult<String> {
    let list: Vec<Value> = snippets
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "description": s.description,
                "command": s.command,
                "category": s.category,
                "dangerous": s.dangerous,
                "sudo": s.sudo,
                "readOnly": s.read_only,
            })
        })
        .collect();
    let doc = json!({ "format": FORMAT, "version": 1, "snippets": list });
    Ok(serde_json::to_string_pretty(&doc)?)
}
