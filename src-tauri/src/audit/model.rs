//! Informe de una auditoría (espejo de `src/api/audit.ts`).

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::vulnscan::model::AiExplanation;

/// Resultado de una comprobación.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warn,
    Bad,
    /// Dato informativo: no suma ni resta.
    Info,
    /// Sin comprobar (necesita sudo, falta la herramienta…).
    Skip,
}

impl CheckStatus {
    pub fn code(self) -> &'static str {
        match self {
            CheckStatus::Ok => "ok",
            CheckStatus::Warn => "warn",
            CheckStatus::Bad => "bad",
            CheckStatus::Info => "info",
            CheckStatus::Skip => "skip",
        }
    }
}

/// Comando que arregla un problema (se muestra antes y se ejecuta solo tras confirmar).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub command: String,
    /// Puede cortar el acceso o un servicio: confirmación fuerte.
    #[serde(default)]
    pub danger: bool,
    /// Solo se muestra para copiarlo (hay que revisarlo a mano).
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub category: String,
    pub title: String,
    pub status: CheckStatus,
    /// Una línea, sin nombres de usuario ni direcciones (es lo que va a la IA).
    pub detail: String,
    /// Lo afectado (usuarios, puertos, archivos…). Solo se ve en este equipo.
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub fix: Option<Fix>,
    /// Peso en la nota (1 leve, 2 medio, 3 grave).
    #[serde(default)]
    pub weight: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryScore {
    pub id: String,
    pub label: String,
    /// 0–100 (None si no se pudo comprobar nada).
    pub score: Option<u32>,
    pub grade: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditReport {
    pub id: String,
    pub server_id: String,
    /// RFC 3339.
    pub created_at: String,
    #[serde(default)]
    pub duration_ms: u64,
    /// Se hizo con root/sudo.
    pub elevated: bool,
    #[serde(default)]
    pub os: String,
    pub score: Option<u32>,
    pub grade: Option<String>,
    pub summary: String,
    pub categories: Vec<CategoryScore>,
    pub checks: Vec<Check>,
    #[serde(default)]
    pub ai: Option<AiExplanation>,
}

/// Fila del historial.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditMeta {
    pub id: String,
    pub created_at: String,
    pub elevated: bool,
    pub score: Option<u32>,
    pub grade: Option<String>,
    pub bad: usize,
    pub warn: usize,
    pub has_ai: bool,
}

const MAX_CHECKS: usize = 200;
const MAX_ITEMS: usize = 200;
const MAX_TEXT: usize = 4000;

fn clip(s: &mut String, max: usize) {
    if s.chars().count() > max {
        *s = s.chars().take(max.saturating_sub(1)).collect::<String>() + "…";
    }
}

impl AuditReport {
    pub fn meta(&self) -> AuditMeta {
        AuditMeta {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            elevated: self.elevated,
            score: self.score,
            grade: self.grade.clone(),
            bad: self.count(CheckStatus::Bad),
            warn: self.count(CheckStatus::Warn),
            has_ai: self.ai.is_some(),
        }
    }

    pub fn count(&self, s: CheckStatus) -> usize {
        self.checks.iter().filter(|c| c.status == s).count()
    }

    /// Valida lo que llega de la interfaz y recorta tamaños (el historial no crece sin límite).
    pub fn sanitized(mut self) -> AppResult<AuditReport> {
        if self.id.trim().is_empty() || self.id.len() > 64 {
            return Err(AppError::Invalid("Identificador de auditoría no válido".into()));
        }
        if self.score.is_some_and(|s| s > 100) || self.categories.iter().any(|c| c.score.is_some_and(|s| s > 100)) {
            return Err(AppError::Invalid("Nota de auditoría fuera de rango".into()));
        }
        self.checks.truncate(MAX_CHECKS);
        for c in &mut self.checks {
            clip(&mut c.detail, MAX_TEXT);
            c.items.truncate(MAX_ITEMS);
            for i in &mut c.items {
                clip(i, 500);
            }
            if let Some(f) = &mut c.fix {
                clip(&mut f.command, MAX_TEXT);
            }
        }
        clip(&mut self.summary, MAX_TEXT);
        Ok(self)
    }
}
