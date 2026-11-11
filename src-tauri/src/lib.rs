//! Punto de entrada del motor: registra estado global, plugins y todos los comandos.
//! Archivo de BASE: los agentes no lo editan; los comandos ya están todos registrados.

mod error;
mod platform;
mod sftp;
mod snippets;
mod ssh;
mod storage;
mod terminal;
mod transfer;
mod types;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    platform::prepare_environment();
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(ssh::SessionStore::default())
        .manage(terminal::TerminalStore::default())
        .manage(sftp::SftpStore::default())
        .manage(transfer::TransferManager::default())
        .setup(|app| {
            app.manage(storage::ProfileStore::load());
            app.manage(storage::SettingsStore::load());
            app.manage(snippets::SnippetStore::load());
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
            // biblioteca de comandos
            snippets::snippets_load,
            snippets::snippets_save,
            snippets::snippets_delete,
            snippets::exec_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar TerView");
}
