//! Peticiones del motor a la interfaz.
//!
//! Algunas herramientas reutilizan lógica que vive en la interfaz (TypeScript) en lugar de copiarla
//! a Rust: abrir una pestaña con el flujo normal de conexión (`connect`), el catálogo de la
//! Biblioteca (`catalog`) y los escaneos de Administración y Contenedores (`ports`, `sites`,
//! `containers`, con sus scripts y analizadores ya probados).
//!
//! El motor emite `mcp://ui-request` (`UiRequest`) y la interfaz responde con `mcp_ui_reply`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

pub const EV_UI_REQUEST: &str = "mcp://ui-request";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRequest {
    pub id: String,
    pub kind: String,
    pub payload: Value,
}

type Reply = Result<Value, String>;

#[derive(Default)]
pub struct UiBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}

impl UiBridge {
    pub async fn request(&self, app: &AppHandle, kind: &str, payload: Value, timeout: Duration) -> AppResult<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), tx);
        let req = UiRequest { id: id.clone(), kind: kind.to_string(), payload };
        if let Err(e) = app.emit(EV_UI_REQUEST, &req) {
            self.forget(&id);
            return Err(AppError::Invalid(format!("no se pudo hablar con la ventana de TerView: {e}")));
        }
        let out = tokio::time::timeout(timeout, rx).await;
        self.forget(&id);
        match out {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(msg))) => Err(AppError::Invalid(msg)),
            Ok(Err(_)) => Err(AppError::Invalid("la ventana de TerView no respondió".into())),
            Err(_) => Err(AppError::Invalid(format!(
                "la ventana de TerView no respondió en {} s",
                timeout.as_secs()
            ))),
        }
    }

    /// Respuesta de la interfaz. false si ya no se esperaba.
    pub fn reply(&self, id: &str, result: Reply) -> bool {
        let tx = self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        tx.is_some_and(|tx| tx.send(result).is_ok())
    }

    fn forget(&self, id: &str) {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
    }
}
