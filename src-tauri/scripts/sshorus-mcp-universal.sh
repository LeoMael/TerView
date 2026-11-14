#!/bin/sh
# Une con lipo el puente `sshorus-mcp` en un binario universal (Intel + Apple Silicon).
#
# Lo ejecuta Tauri en macOS (build.beforeBundleCommand, en tauri.macos.conf.json): después de compilar
# y antes de empaquetar. Con `--target universal-apple-darwin`, tauri-cli compila todos los binarios
# para aarch64 y x86_64, pero solo une con lipo el principal (`sshorus`); el empaquetador copia también
# `sshorus-mcp` desde target/universal-apple-darwin/<perfil>/ y fallaría al no encontrarlo.
# Con cualquier otro target no hace nada (cada binario ya está en su carpeta).
set -eu

[ "${TAURI_ENV_TARGET_TRIPLE:-}" = "universal-apple-darwin" ] || exit 0

cd "$(dirname "$0")/.."
perfil=release
[ "${TAURI_ENV_DEBUG:-false}" = "true" ] && perfil=debug
target="${CARGO_TARGET_DIR:-target}"
salida="$target/universal-apple-darwin/$perfil"

mkdir -p "$salida"
lipo -create -output "$salida/sshorus-mcp" \
  "$target/aarch64-apple-darwin/$perfil/sshorus-mcp" \
  "$target/x86_64-apple-darwin/$perfil/sshorus-mcp"
lipo -info "$salida/sshorus-mcp"
