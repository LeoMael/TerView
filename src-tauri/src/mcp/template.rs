//! Plantillas de la Biblioteca de comandos: `{{nombre}}` / `{{nombre:defecto}}`.
//!
//! Igual que `src/components/Commands/template.ts` (`renderTemplate`): cada valor se cita según
//! dónde está la variable (fuera de comillas, entre comillas simples o dobles), así un valor con
//! espacios o símbolos nunca rompe ni amplía el comando. Además, para el asistente, los valores no
//! pueden empezar por «-» (serían opciones del comando) ni llevar saltos de línea.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use regex::Regex;

/// `{{nombre}}` o `{{nombre:defecto}}` al principio del texto. Expresión fija (probada en los tests).
fn var_at(text: &str) -> Option<regex::Captures<'_>> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\{\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}\}").ok())
        .as_ref()?
        .captures(text)
}

/// Variables de la plantilla (nombre → valor por defecto), en orden y sin repetir.
pub fn parse_vars(template: &str) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    let mut i = 0;
    while let Some(off) = template[i..].find("{{") {
        let at = i + off;
        if let Some(c) = var_at(&template[at..]) {
            let name = c[1].to_string();
            let def = c.get(2).map(|m| m.as_str().to_string());
            match out.iter_mut().find(|(n, _)| *n == name) {
                Some((_, d)) => {
                    if d.is_none() {
                        *d = def;
                    }
                }
                None => out.push((name, def)),
            }
            i = at + c[0].len();
        } else {
            i = at + 2;
        }
    }
    out
}

fn is_safe(v: &str) -> bool {
    !v.is_empty()
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./~^-".contains(&b))
}

/// Cita un valor para la shell (fuera de comillas).
pub fn shell_quote(v: &str) -> String {
    if v.is_empty() {
        return "''".into();
    }
    if is_safe(v) {
        return v.to_string();
    }
    format!("'{}'", v.replace('\'', r"'\''"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ctx {
    None,
    Single,
    Double,
}

fn quote_for(ctx: Ctx, v: &str) -> String {
    match ctx {
        Ctx::Single => v.replace('\'', r"'\''"),
        Ctx::Double => {
            let mut s = String::with_capacity(v.len());
            for ch in v.chars() {
                if matches!(ch, '\\' | '"' | '$' | '`') {
                    s.push('\\');
                }
                s.push(ch);
            }
            s
        }
        Ctx::None => shell_quote(v),
    }
}

/// Comprueba un valor dado por el asistente.
pub fn check_value(name: &str, v: &str) -> Result<(), String> {
    if v.starts_with('-') {
        return Err(format!("El valor de «{name}» no puede empezar por «-»."));
    }
    if v.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err(format!("El valor de «{name}» no puede tener saltos de línea."));
    }
    if v.len() > 1000 {
        return Err(format!("El valor de «{name}» es demasiado largo."));
    }
    Ok(())
}

/// Sustituye las variables. Error si falta alguna obligatoria o un valor no es válido.
pub fn render(template: &str, values: &BTreeMap<String, String>) -> Result<String, String> {
    let given: HashMap<&str, &str> = values.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    for (k, v) in &given {
        check_value(k, v)?;
    }
    let known: Vec<String> = parse_vars(template).into_iter().map(|(n, _)| n).collect();
    if let Some(extra) = given.keys().find(|k| !known.iter().any(|n| n == *k)) {
        return Err(format!("La plantilla no tiene la variable «{extra}». Variables: {}.", list(&known)));
    }
    let mut out = String::with_capacity(template.len());
    let mut ctx = Ctx::None;
    let mut missing: Vec<String> = Vec::new();
    let mut i = 0;
    let bytes = template.as_bytes();
    while i < template.len() {
        if template[i..].starts_with("{{")
            && let Some(c) = var_at(&template[i..])
        {
            let name = &c[1];
            let def = c.get(2).map(|m| m.as_str());
            let value = given.get(name).copied().filter(|v| !v.is_empty()).or(def);
            match value {
                Some(v) => out.push_str(&quote_for(ctx, v)),
                None => {
                    if !missing.iter().any(|m| m == name) {
                        missing.push(name.to_string());
                    }
                }
            }
            i += c[0].len();
            continue;
        }
        let ch = template[i..].chars().next().unwrap_or(' ');
        let len = ch.len_utf8();
        let escaped = ch == '\\' && i + 1 < template.len() && ctx != Ctx::Single;
        if escaped {
            let next = template[i + 1..].chars().next().unwrap_or(' ');
            out.push(ch);
            out.push(next);
            i += 1 + next.len_utf8();
            continue;
        }
        match (ctx, bytes[i]) {
            (Ctx::None, b'\'') => ctx = Ctx::Single,
            (Ctx::None, b'"') => ctx = Ctx::Double,
            (Ctx::Single, b'\'') | (Ctx::Double, b'"') => ctx = Ctx::None,
            _ => {}
        }
        out.push(ch);
        i += len;
    }
    if !missing.is_empty() {
        return Err(format!("Faltan valores para: {}.", list(&missing)));
    }
    Ok(out)
}

fn list(names: &[String]) -> String {
    if names.is_empty() {
        return "(ninguna)".into();
    }
    names.iter().map(|n| format!("«{n}»")).collect::<Vec<_>>().join(", ")
}
