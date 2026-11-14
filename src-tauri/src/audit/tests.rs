//! Pruebas del historial de auditorías y del formato que manda la interfaz.

use super::model::*;
use super::store::{History, MAX_REPORTS};

/// Informe tal y como lo manda la interfaz (`src/api/audit.ts`).
const SAMPLE: &str = r#"{
  "id": "a1", "serverId": "s-web", "createdAt": "2026-11-13T10:00:00Z", "durationMs": 4200,
  "elevated": true, "os": "Rocky Linux 9.4", "score": 72, "grade": "C",
  "summary": "1 problema grave y 2 avisos",
  "categories": [
    { "id": "ssh", "label": "SSH", "score": 60, "grade": "D", "summary": "1 grave" },
    { "id": "web", "label": "Sitios web", "score": null, "grade": null, "summary": "Sin sitios" }
  ],
  "checks": [
    { "id": "ssh.root", "category": "ssh", "title": "Entrada de root por SSH", "status": "bad",
      "detail": "root puede entrar con contraseña", "items": [], "weight": 3,
      "fix": { "command": "echo 'PermitRootLogin no'", "danger": true } },
    { "id": "users.nopasswd", "category": "users", "title": "sudo sin contraseña", "status": "warn",
      "detail": "1 regla con NOPASSWD", "items": ["deploy ALL=(ALL) NOPASSWD: ALL"], "weight": 2, "fix": null },
    { "id": "hard.cron", "category": "hardening", "title": "cron de otros usuarios", "status": "skip",
      "detail": "Necesita sudo", "weight": 1 }
  ],
  "ai": null
}"#;

fn tmp() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("terview-audit-test-{}", uuid::Uuid::new_v4()))
}

fn sample() -> AuditReport {
    serde_json::from_str(SAMPLE).expect("formato de la interfaz")
}

#[test]
fn lee_el_formato_de_la_interfaz() {
    let r = sample();
    assert_eq!(r.checks[0].status, CheckStatus::Bad);
    assert!(r.checks[0].fix.as_ref().is_some_and(|f| f.danger && !f.manual));
    assert_eq!(r.checks[2].status, CheckStatus::Skip);
    assert!(r.checks[2].items.is_empty());
    let m = r.meta();
    assert_eq!((m.bad, m.warn, m.has_ai), (1, 1, false));
    // Y vuelve igual (camelCase).
    let back = serde_json::to_value(&r).unwrap();
    assert_eq!(back["serverId"], "s-web");
    assert_eq!(back["checks"][1]["status"], "warn");
}

#[test]
fn rechaza_notas_fuera_de_rango_y_recorta() {
    let mut r = sample();
    r.score = Some(101);
    assert!(r.clone().sanitized().is_err());
    r.score = Some(50);
    r.checks[1].items = (0..500).map(|i| format!("x{i}")).collect();
    r.checks[1].detail = "a".repeat(10_000);
    let s = r.sanitized().unwrap();
    assert_eq!(s.checks[1].items.len(), 200);
    assert!(s.checks[1].detail.chars().count() <= 4000);
}

#[test]
fn historial_guarda_lista_y_borra() {
    let dir = tmp();
    let h = History::at(&dir);
    assert!(h.latest("s-web").unwrap().is_none());
    let mut r = sample();
    for i in 0..(MAX_REPORTS + 3) {
        r.id = format!("a{i}");
        h.save(&r).unwrap();
    }
    let list = h.list("s-web").unwrap();
    assert_eq!(list.len(), MAX_REPORTS);
    assert_eq!(list[0].id, format!("a{}", MAX_REPORTS + 2));
    assert_eq!(h.latest("s-web").unwrap().unwrap().id, list[0].id);
    let ai = crate::vulnscan::model::AiExplanation { model: "m".into(), created_at: "t".into(), text: "hola".into() };
    let with = h.set_ai("s-web", &list[1].id, Some(ai)).unwrap();
    assert!(with.ai.is_some());
    assert!(h.list("s-web").unwrap()[1].has_ai);
    h.delete("s-web", Some(&list[0].id)).unwrap();
    assert!(h.get("s-web", &list[0].id).is_err());
    h.delete("s-web", None).unwrap();
    assert!(h.list("s-web").unwrap().is_empty());
    assert!(h.list("../etc").is_err());
    let _ = std::fs::remove_dir_all(dir);
}
