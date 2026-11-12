//! Aprobaciones: el asistente quiere cambiar algo y TerView te lo pregunta.
//!
//! El motor emite `mcp://approval` con la petición; la interfaz muestra el diálogo y responde con
//! `mcp_approval_reply`. Si nadie responde en el tiempo límite, se deniega (y se emite
//! `mcp://approval-done` para cerrar el diálogo).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// Lo que ve la interfaz en el diálogo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub server_id: String,
    pub server_name: String,
    /// Herramienta MCP (`run_command`, `write_file`…).
    pub tool: String,
    /// Frase corta: «quiere ejecutar un comando».
    pub title: String,
    /// Comando exacto, ruta o lista de archivos.
    pub command: String,
    /// Diferencias (solo `write_file`).
    pub diff: Option<String>,
    /// Motivos de peligro (vacío = no es peligroso).
    pub danger: Vec<String>,
    /// Se ofrece «Permitir siempre este comando en este servidor».
    pub can_remember: bool,
    pub timeout_secs: u32,
    /// Unix ms en que se deniega solo.
    pub expires_at: u64,
    pub client: Option<String>,
}

/// Respuesta del usuario.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    /// Permitir una vez.
    Once,
    /// Permitir siempre esta acción en este servidor.
    Always,
    Deny,
}

/// Peticiones esperando respuesta.
#[derive(Default)]
pub struct PendingApprovals {
    map: Mutex<HashMap<String, (ApprovalRequest, oneshot::Sender<Decision>)>>,
}

impl PendingApprovals {
    pub fn add(&self, req: ApprovalRequest) -> oneshot::Receiver<Decision> {
        let (tx, rx) = oneshot::channel();
        self.map.lock().unwrap_or_else(|p| p.into_inner()).insert(req.id.clone(), (req, tx));
        rx
    }

    /// Responde. false si ya no estaba pendiente (respondida o vencida).
    pub fn reply(&self, id: &str, decision: Decision) -> bool {
        let entry = self.map.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        match entry {
            Some((_, tx)) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    pub fn remove(&self, id: &str) {
        self.map.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
    }

    /// Pendientes, de la más antigua a la más nueva.
    pub fn list(&self) -> Vec<ApprovalRequest> {
        let mut v: Vec<ApprovalRequest> =
            self.map.lock().unwrap_or_else(|p| p.into_inner()).values().map(|(r, _)| r.clone()).collect();
        v.sort_by_key(|r| r.expires_at);
        v
    }

    /// Deniega todo lo pendiente (al bloquear TerView o apagar el MCP).
    pub fn deny_all(&self) -> Vec<String> {
        let all: Vec<(String, (ApprovalRequest, oneshot::Sender<Decision>))> =
            self.map.lock().unwrap_or_else(|p| p.into_inner()).drain().collect();
        all.into_iter()
            .map(|(id, (_, tx))| {
                let _ = tx.send(Decision::Deny);
                id
            })
            .collect()
    }
}
