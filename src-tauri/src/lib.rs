//! Punto de entrada del motor: registra estado global, plugins y todos los comandos.
//! Archivo de BASE: los agentes no lo editan; los comandos ya están todos registrados.

mod diagnostics;
mod error;
mod github;
mod localfs;
mod platform;
mod sftp;
mod snippets;
mod ssh;
mod storage;
mod terminal;
mod transfer;
mod tunnels;
mod types;

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
        .manage(sftp::SftpStore::default())
        .manage(transfer::TransferManager::default())
        // Al cerrar la principal se cierra la app entera (si no, seguirían vivas las ventanas de editor aparte).
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            app.manage(storage::ProfileStore::load());
            app.manage(storage::SettingsStore::load());
            app.manage(snippets::SnippetStore::load());
            // Túneles: definiciones guardadas + vigilante (arranque automático, reconexión, cierre).
            app.manage(tunnels::TunnelManager::load());
            app.state::<tunnels::TunnelManager>().start_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ssh
            ssh::ssh_connect,
            ssh::ssh_trust_host,
            ssh::ssh_disconnect,
            ssh::ssh_list_sessions,
            // terminal
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
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
            // storage
            storage::profiles_load,
            storage::profiles_save_server,
            storage::profiles_delete_server,
            storage::profiles_save_project,
            storage::profiles_delete_project,
            storage::profiles_has_secret,
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
            // archivos locales (exportar/importar)
            localfs::local_write_text,
            localfs::local_read_text,
            // biblioteca de comandos
            snippets::snippets_load,
            snippets::snippets_save,
            snippets::snippets_delete,
            snippets::exec_capture,
            snippets::exec_capture_stdin,
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
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar TerView");
}
