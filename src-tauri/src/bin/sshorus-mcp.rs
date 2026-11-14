//! `sshorus-mcp`: puente stdio para asistentes de IA (Claude Desktop, Claude Code…).
//!
//! Reenvía los mensajes MCP a SSHorus abierto (`http://127.0.0.1:<puerto>/mcp`). No guarda nada ni
//! ve contraseñas: solo necesita el token (variable `SSHORUS_MCP_TOKEN`), que SSHorus incluye en la
//! configuración para copiar (Ajustes → Asistentes de IA). Toda la lógica vive en la app.
//!
//! Uso: `claude mcp add --env SSHORUS_MCP_TOKEN=<token> --transport stdio sshorus -- sshorus-mcp`

#[path = "../mcp/bridge.rs"]
mod bridge;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("sshorus-mcp {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "sshorus-mcp {}: puente MCP por stdio hacia SSHorus.\n\n\
             Variables:\n  SSHORUS_MCP_TOKEN  token de SSHorus (Ajustes → Asistentes de IA)\n  \
             SSHORUS_MCP_PORT   puerto (por defecto, el de SSHorus o 47821)\n\n\
             SSHorus tiene que estar abierto. Si no, el asistente verá: «{}»",
            env!("CARGO_PKG_VERSION"),
            bridge::CLOSED_MSG
        );
        return;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("sshorus-mcp: no se pudo iniciar: {e}");
            std::process::exit(1);
        }
    };
    let cfg = bridge::BridgeConfig::from_env(env!("CARGO_PKG_VERSION"));
    if cfg.token.is_none() {
        eprintln!("sshorus-mcp: falta SSHORUS_MCP_TOKEN (cópialo de SSHorus → Ajustes → Asistentes de IA)");
    }
    runtime.block_on(async move {
        let input = tokio::io::BufReader::new(tokio::io::stdin());
        bridge::run(cfg, input, tokio::io::stdout()).await;
    });
}
