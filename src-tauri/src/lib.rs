//! Punto de entrada del motor: registra estado global, plugins y todos los comandos.
//! Archivo de BASE: los agentes no lo editan; los comandos ya están todos registrados.

mod ai;
mod audit;
mod diagnostics;
mod dragout;
mod error;
mod github;
mod localfs;
mod localkeys;
mod localterm;
mod mcp;
mod platform;
mod sftp;
mod snippets;
mod ssh;
mod storage;
mod terminal;
mod transfer;
mod tunnels;
mod types;
mod vulnscan;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    platform::prepare_environment();
    tauri::Builder::default()
        // Solo la ventana principal recuerda tamaño y posición (las de editor aparte son de usar y tirar).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label == "main")
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ssh::SessionStore::default())
        .manage(terminal::TerminalStore::default())
        .manage(localterm::LocalTermStore::default())
        .manage(sftp::SftpStore::default())
        .manage(transfer::TransferManager::default())
        .manage(snippets::ExecRegistry::default())
        .manage(storage::lock::LockState::default())
        // Al cerrar la principal se cierra la app entera (si no, seguirían vivas las ventanas de editor aparte).
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                // Las terminales locales terminan con sus procesos (no quedan programas sueltos).
                window.app_handle().state::<localterm::LocalTermStore>().close_all();
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            app.manage(storage::ProfileStore::load());
            app.manage(storage::SettingsStore::load());
            // Bloqueo por inactividad (solo actúa si hay bóveda y está desbloqueada).
            storage::lock::start_idle_watcher(app.handle().clone());
            app.manage(snippets::SnippetStore::load());
            // Túneles: definiciones guardadas + vigilante (arranque automático, reconexión, cierre).
            app.manage(tunnels::TunnelManager::load());
            app.state::<tunnels::TunnelManager>().start_watcher(app.handle().clone());
            // Arrastrar al sistema: borra lo preparado hace más de un día.
            dragout::clean_on_start(app.handle());
            // Servidor MCP para asistentes de IA (apagado por defecto).
            app.manage(mcp::McpState::new(app.handle()));
            mcp::start_if_enabled(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ssh
            ssh::ssh_connect,
            ssh::ssh_trust_host,
            ssh::ssh_test_connection,
            ssh::ssh_cancel_test,
            ssh::ssh_disconnect,
            ssh::ssh_list_sessions,
            // terminal
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            terminal::term_tmux_list,
            terminal::term_tmux_kill,
            // terminal local y asistentes de IA (Claude Code, Codex)
            localterm::local_term_info,
            localterm::local_term_open,
            localterm::local_term_write,
            localterm::local_term_resize,
            localterm::local_term_close,
            localterm::local_ai_detect,
            localterm::local_ai_ssh_aliases,
            // sftp
            sftp::sftp_home,
            sftp::sftp_list_dir,
            sftp::sftp_stat,
            sftp::sftp_mkdir,
            sftp::sftp_create_file,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_chmod,
            sftp::sftp_read_text,
            sftp::sftp_write_text,
            // transfer
            transfer::transfer_upload,
            transfer::transfer_download,
            transfer::transfer_list,
            transfer::transfer_pause,
            transfer::transfer_resume,
            transfer::transfer_cancel,
            transfer::transfer_retry,
            transfer::transfer_clear_finished,
            transfer::transfer_conflicts,
            transfer::transfer_resolve_conflict,
            transfer::transfer_batch_finished,
            // arrastrar al escritorio / gestor de archivos
            dragout::drag_out_dir,
            dragout::drag_out_start,
            // storage
            storage::profiles_load,
            storage::profiles_save_server,
            storage::profiles_delete_server,
            storage::profiles_save_project,
            storage::profiles_delete_project,
            storage::profiles_has_secret,
            storage::profiles_reveal_secret,
            storage::profiles_sudo_password,
            storage::profiles_set_secret,
            storage::settings_load,
            storage::settings_save,
            storage::profiles_duplicate_server,
            storage::profiles_export_ssh_config,
            storage::profiles_import_ssh_config,
            storage::ssh_config::ssh_config_conflicts,
            storage::ssh_config::ssh_config_alias_info,
            storage::ssh_config::ssh_config_aliases,
            storage::ssh_config::ssh_config_set_aliases,
            storage::ssh_config::ssh_config_import_preview,
            // bóveda de contraseñas y bloqueo con PIN
            storage::lock::vault_status,
            storage::lock::vault_activity,
            storage::lock::vault_unlock,
            storage::lock::vault_lock,
            storage::lock::vault_enable,
            storage::lock::vault_disable,
            storage::lock::vault_change_pin,
            storage::lock::vault_reset,
            // archivos locales (exportar/importar)
            localfs::local_write_text,
            localfs::local_read_text,
            // llaves SSH locales (asistente «Nuevo usuario con clave»)
            localkeys::local_ssh_public_keys,
            localkeys::local_ssh_generate_key,
            // biblioteca de comandos
            snippets::snippets_load,
            snippets::snippets_save,
            snippets::snippets_delete,
            snippets::exec_capture,
            snippets::exec_capture_stdin,
            snippets::exec_capture_sudo,
            snippets::exec_cancel,
            // cuenta de GitHub
            github::gh_status,
            github::gh_connect,
            github::gh_disconnect,
            github::gh_account,
            github::gh_device_start,
            github::gh_device_poll,
            github::gh_my_keys,
            github::gh_user_keys,
            github::gh_add_key,
            github::gh_local_pubkeys,
            github::gh_read_pubkey,
            github::gh_repos,
            github::gh_branches,
            github::gh_add_deploy_key,
            github::gh_workflows,
            github::gh_runs,
            github::gh_dispatch,
            github::gh_config_load,
            github::gh_recipe_save,
            github::gh_recipe_delete,
            github::gh_recipe_mark,
            github::gh_sync_find,
            github::gh_sync_push,
            github::gh_sync_pull,
            github::gh_fetch_snippets,
            github::gh_share_snippets,
            // túneles (port forwarding)
            tunnels::tunnels_list,
            tunnels::tunnels_save,
            tunnels::tunnels_delete,
            tunnels::tunnel_start,
            tunnels::tunnel_stop,
            tunnels::tunnels_status,
            // diagnóstico (Ajustes → Avanzado)
            diagnostics::app_diagnostics,
            // asistentes de IA (MCP)
            mcp::mcp_status,
            mcp::mcp_set_enabled,
            mcp::mcp_set_port,
            mcp::mcp_set_approval_timeout,
            mcp::mcp_config,
            mcp::mcp_set_access,
            mcp::mcp_forget_rule,
            mcp::mcp_auto_list,
            mcp::mcp_set_auto,
            mcp::mcp_auto_off_all,
            mcp::mcp_get_token,
            mcp::mcp_regenerate_token,
            mcp::mcp_client_config,
            mcp::mcp_pending_approvals,
            mcp::mcp_approval_reply,
            mcp::mcp_ui_reply,
            mcp::mcp_activity,
            mcp::mcp_activity_clear,
            // escáner de vulnerabilidades (Administración → Vulnerabilidades)
            vulnscan::vulnscan_script,
            vulnscan::vulnscan_plan,
            vulnscan::vulnscan_parse_users,
            vulnscan::vulnscan_parse_images,
            vulnscan::vulnscan_analyze,
            vulnscan::vulnscan_cancel,
            vulnscan::vulnscan_history_list,
            vulnscan::vulnscan_history_get,
            vulnscan::vulnscan_latest,
            vulnscan::vulnscan_history_delete,
            vulnscan::vulnscan_set_ai,
            vulnscan::vulnscan_export,
            vulnscan::vulnscan_vuln_detail,
            vulnscan::vulnscan_rescan_image,
            // auditoría del servidor (Administración → Auditoría)
            audit::audit_save,
            audit::audit_history_list,
            audit::audit_history_get,
            audit::audit_latest,
            audit::audit_history_delete,
            audit::audit_set_ai,
            // asistente de IA opcional (solo explica informes)
            ai::ai_status,
            ai::ai_set_token,
            ai::ai_test,
            ai::ai_chat,
            ai::ai_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar TerView");
}
