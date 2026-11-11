//! Política de conflictos: qué hacer si el destino ya existe (`Settings::transfer_conflict`).

/// Se lee al crear el lote y vale para todos sus trabajos.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Conflict {
    /// Sobrescribir siempre (comportamiento clásico).
    #[default]
    Overwrite,
    /// Si el destino existe, no se toca (`Skipped`).
    Skip,
    /// Solo si el origen es más reciente que el destino.
    Newer,
}

impl Conflict {
    /// "overwrite" | "skip" | "newer" (cualquier otro valor = sobrescribir).
    pub fn parse(s: &str) -> Conflict {
        match s.trim().to_ascii_lowercase().as_str() {
            "skip" => Conflict::Skip,
            "newer" => Conflict::Newer,
            _ => Conflict::Overwrite,
        }
    }
}

pub const SKIP_EXISTS: &str = "ya existía";
pub const SKIP_NOT_NEWER: &str = "el destino es igual o más reciente";

/// Decide si se transfiere. `dest` = `None` si el destino no existe; si existe, su fecha
/// de modificación (segundos Unix) si se conoce. `src_mtime` = fecha del origen.
///
/// Devuelve `Ok(())` para transferir o `Err(motivo)` para omitir.
pub fn decide(policy: Conflict, src_mtime: Option<u64>, dest: Option<Option<u64>>) -> Result<(), &'static str> {
    let Some(dest_mtime) = dest else { return Ok(()) };
    match policy {
        Conflict::Overwrite => Ok(()),
        Conflict::Skip => Err(SKIP_EXISTS),
        Conflict::Newer => match (src_mtime, dest_mtime) {
            (Some(s), Some(d)) if s <= d => Err(SKIP_NOT_NEWER),
            // Origen más nuevo, o no se puede comparar: se transfiere (no perder cambios).
            _ => Ok(()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_values() {
        assert_eq!(Conflict::parse("overwrite"), Conflict::Overwrite);
        assert_eq!(Conflict::parse("skip"), Conflict::Skip);
        assert_eq!(Conflict::parse(" Newer "), Conflict::Newer);
        assert_eq!(Conflict::parse("rename"), Conflict::Overwrite);
        assert_eq!(Conflict::parse(""), Conflict::Overwrite);
    }

    #[test]
    fn missing_destination_always_transfers() {
        for p in [Conflict::Overwrite, Conflict::Skip, Conflict::Newer] {
            assert_eq!(decide(p, Some(10), None), Ok(()));
            assert_eq!(decide(p, None, None), Ok(()));
        }
    }

    #[test]
    fn overwrite_and_skip() {
        assert_eq!(decide(Conflict::Overwrite, Some(1), Some(Some(100))), Ok(()));
        assert_eq!(decide(Conflict::Skip, Some(100), Some(Some(1))), Err(SKIP_EXISTS));
        assert_eq!(decide(Conflict::Skip, None, Some(None)), Err(SKIP_EXISTS));
    }

    #[test]
    fn newer_compares_mtimes() {
        assert_eq!(decide(Conflict::Newer, Some(200), Some(Some(100))), Ok(()));
        assert_eq!(decide(Conflict::Newer, Some(100), Some(Some(100))), Err(SKIP_NOT_NEWER));
        assert_eq!(decide(Conflict::Newer, Some(50), Some(Some(100))), Err(SKIP_NOT_NEWER));
        // Sin fechas no se puede comparar: se transfiere.
        assert_eq!(decide(Conflict::Newer, None, Some(Some(100))), Ok(()));
        assert_eq!(decide(Conflict::Newer, Some(100), Some(None)), Ok(()));
    }
}
