fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "msvc" {
        // Windows (MSVC): el manifiesto de la app (Common Controls v6, que piden los diálogos de
        // tauri-plugin-dialog / rfd) se enlaza en TODOS los ejecutables, también en los de pruebas.
        // tauri-build solo lo pone en los binarios (`sshorus`, `sshorus-mcp`), y sin él el ejecutable
        // de `cargo test --lib` no arranca: STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) al no encontrar
        // `TaskDialogIndirect` en el comctl32 antiguo. Es el mismo arreglo que usa Tauri en sus
        // ejemplos (examples/api/src-tauri/build.rs). Por eso aquí se le quita a tauri-build, para no
        // tener dos manifiestos en los binarios.
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("falló tauri-build");

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    } else {
        // Linux, macOS y Windows con MinGW (solo para comprobar el código en cruzado): lo de siempre.
        tauri_build::build()
    }
}
