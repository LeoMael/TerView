//! Resumen de una auditoría del servidor para el asistente (`get_audit_report` y `run_audit`): nota
//! general y por categoría, y los problemas con su comando para arreglarlos. Lo afectado (usuarios,
//! puertos, archivos) va recortado; el informe entero se ve en TerView.

use serde_json::{json, Value};

use crate::audit::model::{AuditReport, CheckStatus};

/// Elementos afectados que se muestran por problema.
const MAX_ITEMS: usize = 10;

pub fn summarize(server: &str, r: &AuditReport) -> Value {
    let categories: Vec<Value> = r
        .categories
        .iter()
        .map(|c| json!({ "category": c.label, "score": c.score, "grade": c.grade, "summary": c.summary }))
        .collect();
    let mut problems: Vec<&crate::audit::model::Check> =
        r.checks.iter().filter(|c| matches!(c.status, CheckStatus::Bad | CheckStatus::Warn)).collect();
    // Primero lo grave y lo que más pesa.
    problems.sort_by(|a, b| {
        (b.status == CheckStatus::Bad)
            .cmp(&(a.status == CheckStatus::Bad))
            .then(b.weight.cmp(&a.weight))
            .then(a.id.cmp(&b.id))
    });
    let problems: Vec<Value> = problems
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "status": c.status.code(),
                "category": c.category,
                "title": c.title,
                "detail": c.detail,
                "affected": c.items.iter().take(MAX_ITEMS).collect::<Vec<_>>(),
                "moreAffected": c.items.len().saturating_sub(MAX_ITEMS),
                "fix": c.fix.as_ref().map(|f| json!({ "command": f.command, "dangerous": f.danger, "reviewByHand": f.manual })),
            })
        })
        .collect();
    let unchecked: Vec<Value> = r
        .checks
        .iter()
        .filter(|c| c.status == CheckStatus::Skip)
        .map(|c| json!({ "title": c.title, "reason": c.detail }))
        .collect();
    json!({
        "server": server,
        "auditedAt": r.created_at,
        "withSudo": r.elevated,
        "os": r.os,
        "score": r.score,
        "grade": r.grade,
        "summary": r.summary,
        "categories": categories,
        "problems": problems,
        "ok": r.count(CheckStatus::Ok),
        "unchecked": unchecked,
        "note": "Los arreglos se aplican desde TerView (Administración → Auditoría → Arreglar), con confirmación.",
    })
}
