//! Política de conflictos: qué hacer si el destino ya existe (`Settings::transfer_conflict`).

use serde::Serialize;

/// Se lee al crear el lote y vale para todos sus trabajos. Con `Ask`, cada trabajo que choca
/// espera la respuesta del usuario; "aplicar a todos" cambia la política del lote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Conflict {
    /// Sobrescribir siempre (comportamiento clásico).
    #[default]
    Overwrite,
    /// Si el destino existe, no se toca (`Skipped`).
    Skip,
    /// Solo si el origen es más reciente que el destino.
    Newer,
    /// Preguntar archivo por archivo.
    Ask,
    /// Mantener ambos: se transfiere con otro nombre (`nombre (2).ext`). Solo como respuesta.
    Rename,
}

impl Conflict {
    /// Ajuste: "overwrite" | "skip" | "newer" | "ask" (cualquier otro valor = sobrescribir).
    pub fn parse(s: &str) -> Conflict {
        match s.trim().to_ascii_lowercase().as_str() {
            "skip" => Conflict::Skip,
            "newer" => Conflict::Newer,
            "ask" => Conflict::Ask,
            _ => Conflict::Overwrite,
        }
    }

    /// Respuesta del diálogo: "overwrite" | "skip" | "rename" | "newer".
    pub fn parse_answer(s: &str) -> Option<Conflict> {
        match s.trim().to_ascii_lowercase().as_str() {
            "overwrite" => Some(Conflict::Overwrite),
            "skip" => Some(Conflict::Skip),
            "rename" => Some(Conflict::Rename),
            "newer" => Some(Conflict::Newer),
            _ => None,
        }
    }
}

pub const SKIP_EXISTS: &str = "ya existía";
pub const SKIP_NOT_NEWER: &str = "el destino es igual o más reciente";
/// Nota del trabajo mientras espera la respuesta del usuario.
pub const ASK_MSG: &str = "Esperando tu decisión: el destino ya existe";

/// Qué hacer con un trabajo antes de tocar el destino.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Transfer,
    Skip(&'static str),
    /// Preguntar al usuario (el trabajo suelta su turno y espera).
    Ask,
    /// Transferir con un nombre libre (`nombre (2).ext`).
    Rename,
}

/// Decide si se transfiere. `dest` = `None` si el destino no existe; si existe, su fecha
/// de modificación (segundos Unix) si se conoce. `src_mtime` = fecha del origen.
pub fn decide(policy: Conflict, src_mtime: Option<u64>, dest: Option<Option<u64>>) -> Decision {
    let Some(dest_mtime) = dest else { return Decision::Transfer };
    match policy {
        Conflict::Overwrite => Decision::Transfer,
        Conflict::Skip => Decision::Skip(SKIP_EXISTS),
        Conflict::Ask => Decision::Ask,
        Conflict::Rename => Decision::Rename,
        Conflict::Newer => match (src_mtime, dest_mtime) {
            (Some(s), Some(d)) if s <= d => Decision::Skip(SKIP_NOT_NEWER),
            // Origen más nuevo, o no se puede comparar: se transfiere (no perder cambios).
            _ => Decision::Transfer,
        },
    }
}

/// Pregunta pendiente (evento `transfer://conflict`). Fechas en segundos Unix.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictQuestion {
    pub job_id: String,
    pub batch_id: String,
    pub session_id: String,
    /// "upload" | "download"
    pub direction: crate::types::TransferDirection,
    /// Nombre a mostrar (ruta relativa dentro del lote).
    pub name: String,
    /// Ruta de origen (local al subir, remota al bajar).
    pub source: String,
    /// Ruta de destino que ya existe.
    pub destination: String,
    pub source_size: Option<u64>,
    pub source_mtime: Option<u64>,
    pub dest_size: Option<u64>,
    pub dest_mtime: Option<u64>,
    /// Es un enlace simbólico (no un archivo).
    pub is_link: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_values() {
        assert_eq!(Conflict::parse("overwrite"), Conflict::Overwrite);
        assert_eq!(Conflict::parse("skip"), Conflict::Skip);
        assert_eq!(Conflict::parse(" Newer "), Conflict::Newer);
        assert_eq!(Conflict::parse("ask"), Conflict::Ask);
        // "rename" no es un ajuste (solo una respuesta).
        assert_eq!(Conflict::parse("rename"), Conflict::Overwrite);
        assert_eq!(Conflict::parse(""), Conflict::Overwrite);
    }

    #[test]
    fn parse_answers() {
        assert_eq!(Conflict::parse_answer("overwrite"), Some(Conflict::Overwrite));
        assert_eq!(Conflict::parse_answer("skip"), Some(Conflict::Skip));
        assert_eq!(Conflict::parse_answer("Rename"), Some(Conflict::Rename));
        assert_eq!(Conflict::parse_answer("newer"), Some(Conflict::Newer));
        // Responder "preguntar" no tiene sentido.
        assert_eq!(Conflict::parse_answer("ask"), None);
        assert_eq!(Conflict::parse_answer("x"), None);
    }

    #[test]
    fn missing_destination_always_transfers() {
        for p in [Conflict::Overwrite, Conflict::Skip, Conflict::Newer, Conflict::Ask, Conflict::Rename] {
            assert_eq!(decide(p, Some(10), None), Decision::Transfer);
            assert_eq!(decide(p, None, None), Decision::Transfer);
        }
    }

    #[test]
    fn overwrite_and_skip() {
        assert_eq!(decide(Conflict::Overwrite, Some(1), Some(Some(100))), Decision::Transfer);
        assert_eq!(decide(Conflict::Skip, Some(100), Some(Some(1))), Decision::Skip(SKIP_EXISTS));
        assert_eq!(decide(Conflict::Skip, None, Some(None)), Decision::Skip(SKIP_EXISTS));
    }

    #[test]
    fn ask_and_rename_only_when_destination_exists() {
        assert_eq!(decide(Conflict::Ask, Some(1), Some(Some(100))), Decision::Ask);
        assert_eq!(decide(Conflict::Ask, None, Some(None)), Decision::Ask);
        assert_eq!(decide(Conflict::Rename, Some(1), Some(Some(1))), Decision::Rename);
    }

    #[test]
    fn newer_compares_mtimes() {
        assert_eq!(decide(Conflict::Newer, Some(200), Some(Some(100))), Decision::Transfer);
        assert_eq!(decide(Conflict::Newer, Some(100), Some(Some(100))), Decision::Skip(SKIP_NOT_NEWER));
        assert_eq!(decide(Conflict::Newer, Some(50), Some(Some(100))), Decision::Skip(SKIP_NOT_NEWER));
        // Sin fechas no se puede comparar: se transfiere.
        assert_eq!(decide(Conflict::Newer, None, Some(Some(100))), Decision::Transfer);
        assert_eq!(decide(Conflict::Newer, Some(100), Some(None)), Decision::Transfer);
    }
}
