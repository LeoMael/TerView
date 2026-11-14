//! El servidor MCP (SDK oficial `rmcp`): anuncia las herramientas y pasa cada llamada a `McpCore`.

use std::sync::Arc;

use rmcp::handler::server::common::schema_for_type;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::Value;

use super::backend::Backend;
use super::core::{
    CatalogListParams, CatalogRunParams, ConnectParams, DownloadParams, ListDirParams, McpCore, NoParams,
    PathParams, ReadFileParams, RunCommandParams, ServerParams, TransferStatusParams, UploadParams,
    AuditReportParams, VulnReportParams, VulnScanParams, WriteFileParams,
};

const INSTRUCTIONS: &str = "SSHorus da acceso a los servidores SSH que el usuario guardó en la app, sin \
mostrar contraseñas ni llaves. Empieza con list_servers. Para trabajar en un servidor hace falta una \
conexión abierta (connect abre una pestaña en SSHorus). Las lecturas pasan solas; todo lo que cambia algo \
(run_command, write_file, upload…) muestra un diálogo en SSHorus y espera a que el usuario lo permita. \
Prefiere run_catalog_command con comandos de solo lectura (ver list_catalog) para diagnosticar. \
Para revisar la seguridad en general, mira get_audit_report (o run_audit). \
Para vulnerabilidades, mira primero get_vuln_report (último informe guardado) y usa scan_vulnerabilities \
solo si no hay informe o es viejo: tarda minutos y pide permiso.";

/// Una herramienta: nombre, descripción, esquema de parámetros y si solo lee.
fn tool<T: rmcp::schemars::JsonSchema + 'static>(name: &'static str, description: &'static str, read_only: bool) -> Tool {
    let mut a = ToolAnnotations::new();
    a.read_only_hint = Some(read_only);
    if !read_only {
        a.destructive_hint = Some(true);
    }
    a.open_world_hint = Some(true);
    Tool::new(name, description, schema_for_type::<T>()).annotate(a)
}

/// Todas las herramientas que ofrece SSHorus.
pub fn tools() -> Vec<Tool> {
    vec![
        tool::<NoParams>("list_servers", "Servidores guardados en SSHorus a los que tienes acceso (sin contraseñas), con su nivel de acceso y conexiones abiertas.", true),
        tool::<NoParams>("list_projects", "Proyectos de SSHorus y sus servidores (solo los que puedes ver).", true),
        tool::<NoParams>("list_sessions", "Conexiones SSH abiertas ahora en SSHorus (sessionId).", true),
        tool::<ConnectParams>("connect", "Abre una conexión a un servidor guardado (aparece como pestaña en SSHorus). Pide permiso.", false),
        tool::<RunCommandParams>("run_command", "Ejecuta un comando de shell no interactivo y devuelve código, stdout y stderr (con tiempo y salida limitados). Siempre pide permiso en SSHorus salvo regla «permitir siempre». Para administrar usa `sudo …` normal (sin -S ni ruta absoluta y sin pedir la contraseña): tras el permiso, SSHorus le da a sudo la contraseña del usuario sin que la veas.", false),
        tool::<CatalogListParams>("list_catalog", "Comandos de la Biblioteca de SSHorus (Podman, Docker, análisis del sistema, Mis comandos…) con sus variables.", true),
        tool::<CatalogRunParams>("run_catalog_command", "Ejecuta un comando de la Biblioteca con sus variables. Los de solo lectura (📊) no piden permiso; el resto sí. Los que usan sudo funcionan igual que en run_command (SSHorus pone la contraseña).", false),
        tool::<ListDirParams>("list_dir", "Lista una carpeta del servidor (SFTP).", true),
        tool::<PathParams>("stat", "Datos de un archivo o carpeta del servidor (tamaño, fecha, permisos).", true),
        tool::<ReadFileParams>("read_file", "Lee un archivo de texto del servidor, por trozos (64 KB por defecto, máximo 1 MB por llamada).", true),
        tool::<WriteFileParams>("write_file", "Crea o reemplaza un archivo de texto en el servidor (guardado atómico). Muestra las diferencias y pide permiso.", false),
        tool::<UploadParams>("upload", "Sube archivos o carpetas de este PC al servidor con la cola de transferencias de SSHorus. Pide permiso.", false),
        tool::<DownloadParams>("download", "Descarga archivos o carpetas del servidor a este PC con la cola de transferencias de SSHorus. Pide permiso.", false),
        tool::<TransferStatusParams>("transfer_status", "Progreso de las transferencias (de un lote o todas).", true),
        tool::<ServerParams>("list_ports", "Puertos en escucha del servidor (TCP/UDP) con su proceso, servicio o contenedor.", true),
        tool::<ServerParams>("list_sites", "Sitios web de nginx o Caddy del servidor: dominios, puertos, destinos y certificados.", true),
        tool::<ServerParams>("list_containers", "Contenedores de Podman y/o Docker del servidor con su estado, imagen y puertos.", true),
        tool::<ServerParams>("get_infra_map", "Mapa de la infraestructura del servidor como grafo resumido: puertos expuestos, proxy web, sitios, contenedores, servicios y bases de datos, con quién atiende a quién.", true),
        tool::<VulnReportParams>("get_vuln_report", "Último análisis de vulnerabilidades guardado del servidor (hecho en SSHorus o con scan_vulnerabilities): recuento por gravedad, fuentes y las vulnerabilidades más graves (limit, por defecto 20). No necesita conexión.", true),
        tool::<VulnScanParams>("scan_vulnerabilities", "Analiza ahora las vulnerabilidades del servidor sin sudo (paquetes, programas e imágenes de contenedores; OSV.dev, la herramienta de la distro y Trivy). No cambia el servidor, pero tarda minutos: pide permiso la primera vez. Devuelve el mismo resumen que get_vuln_report y guarda el informe.", true),
        tool::<AuditReportParams>("get_audit_report", "Última auditoría guardada del servidor (hecha en SSHorus o con run_audit): nota general (0-100 y A-F), nota por categoría (SSH, usuarios, red, actualizaciones, certificados, contenedores, sistema, entradas, endurecimiento) y los problemas con el comando para arreglarlos. No necesita conexión.", true),
        tool::<ServerParams>("run_audit", "Audita ahora el servidor sin sudo y sin instalar nada (SSH, usuarios, puertos y cortafuegos, actualizaciones, certificados, contenedores, servicios caídos, intentos de entrada, disco, memoria, permisos). Solo lee; pide permiso la primera vez. Devuelve el mismo resumen que get_audit_report y lo guarda. Lo que necesita sudo sale como «sin comprobar».", true),
    ]
}

/// Manejador MCP. Se crea uno por petición (servidor sin sesiones); el estado vive en `McpCore`.
pub struct SshorusMcp<B: Backend> {
    core: Arc<McpCore<B>>,
}

impl<B: Backend> SshorusMcp<B> {
    pub fn new(core: Arc<McpCore<B>>) -> Self {
        SshorusMcp { core }
    }
}

/// Cliente que hace la petición (User-Agent de la petición HTTP, si lo hay).
fn client_of(ctx: &RequestContext<RoleServer>) -> Option<String> {
    let parts = ctx.extensions.get::<http::request::Parts>()?;
    let ua = parts.headers.get(http::header::USER_AGENT)?.to_str().ok()?;
    let ua = ua.trim();
    (!ua.is_empty()).then(|| super::audit::clip(ua, 80))
}

impl<B: Backend> ServerHandler for SshorusMcp<B> {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sshorus", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools()))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tools().into_iter().find(|t| t.name == name)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if !tools().iter().any(|t| t.name == request.name) {
            return Err(ErrorData::invalid_params(format!("Herramienta desconocida: {}", request.name), None));
        }
        let args = request.arguments.map(Value::Object).unwrap_or(Value::Null);
        let out = self.core.call(&request.name, args, client_of(&context), context.ct.clone()).await;
        let content = vec![ContentBlock::text(out.text)];
        let result = if out.is_error { CallToolResult::error(content) } else { CallToolResult::success(content) };
        Ok(result.into())
    }
}
