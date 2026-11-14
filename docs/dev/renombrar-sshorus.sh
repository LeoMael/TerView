#!/usr/bin/env bash
# Renombrado mecánico TerView -> SSHorus (crate, binarios, MCP, rutas, textos y docs).
#
# Uso (desde cualquier carpeta del repo):   bash docs/dev/renombrar-sshorus.sh [archivos o carpetas…]
#   Sin argumentos recorre todos los archivos de texto que sigue git (más los nuevos sin seguir que no
#   estén ignorados). Con argumentos, solo esos (sirve para aplicarlo a una rama que añadió archivos).
#
# Es idempotente: una segunda pasada no cambia nada. Cambia:
#   TerView -> SSHorus, Terview -> Sshorus, terview -> sshorus, TERVIEW -> SSHORUS
#   (com.terview.app, terview-mcp, TERVIEW_MCP_TOKEN, LeoMael/TerView, ~/.config/terview, etc.)
# y renombra los archivos con «terview» en el nombre (git mv).
#
# NO toca (a propósito):
#   - CHANGELOG.md: solo la cabecera y «Sin publicar» (lo que va antes de la primera «## [0.…», menos su
#     apartado «### Importante», que explica el cambio de nombre), y las URLs del repo de todo el
#     archivo. Las versiones publicadas se quedan como TerView.
#   - Las líneas que llevan «sin-renombrar» (p. ej. `<!-- sin-renombrar -->` en Markdown): hablan de
#     TerView a propósito.
#   - docs/PENDIENTES.md y docs/marca/ (historial; se editan a mano).
#   - Binarios e imágenes (salvo los diagramas docs/arquitectura/*.svg, que son texto; si cambia alguno
#     se regenera su PNG con Inkscape si está instalado).
#   - Este script.
#   - Estos nombres, que siguen igual:
#       terview-sshd               contenedor podman de pruebas que ya existe en el equipo (y sus fixtures)
#       terview-updater.key/.password  archivos de la llave de firma en ~/.tauri/
#       Projects/TERVIEW, TERVIEW-v050  rutas de las carpetas del proyecto en el disco
set -euo pipefail

raiz=$(git rev-parse --show-toplevel)
cd "$raiz"
yo="docs/dev/renombrar-sshorus.sh"

excluido() {
  case "$1" in
    "$yo" | docs/PENDIENTES.md | docs/marca/* | CHANGELOG.md) return 0 ;;
    *node_modules/* | */target/* | target/* | */target-*/* | dist/* | .git/*) return 0 ;;
    docs/arquitectura/*.svg) return 1 ;;
    *.png | *.jpg | *.jpeg | *.gif | *.ico | *.icns | *.webp | *.svg | *.woff | *.woff2 | *.ttf | *.pdf) return 0 ;;
  esac
  return 1
}

# Lista de archivos a revisar.
if [ $# -gt 0 ]; then
  archivos=$(for a in "$@"; do
    if [ -d "$a" ]; then git ls-files --cached --others --exclude-standard -- "$a"; else echo "$a"; fi
  done)
else
  archivos=$(git ls-files --cached --others --exclude-standard)
fi

# 1) Renombrar archivos con «terview» en el nombre (salvo los protegidos).
renombrados=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -e "$f" ] || continue
  case "$f" in *terview-sshd*|docs/marca/*|"$yo") continue ;; esac
  base=$(basename "$f")
  case "$base" in *[Tt]er[Vv]iew*|*TERVIEW*) ;; *) continue ;; esac
  nuevo="$(dirname "$f")/$(printf '%s' "$base" | sed -e 's/TerView/SSHorus/g; s/Terview/Sshorus/g; s/terview/sshorus/g; s/TERVIEW/SSHORUS/g')"
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then git mv "$f" "$nuevo"; else mv "$f" "$nuevo"; fi
  echo "renombrado: $f -> $nuevo"
  renombrados=$((renombrados + 1))
done <<<"$archivos"

if [ "$renombrados" -gt 0 ]; then
  if [ $# -gt 0 ]; then
    archivos=$(printf '%s\n' "$archivos" | sed -e 's/TerView/SSHorus/g; s/Terview/Sshorus/g; s/terview/sshorus/g; s/TERVIEW/SSHORUS/g')
  else
    archivos=$(git ls-files --cached --others --exclude-standard)
  fi
fi

# 2) Contenido. Los nombres protegidos se apartan antes y se devuelven después.
reemplazar='
  s{Projects/TERVIEW}{\x{1}A\x{1}}g;
  s{TERVIEW-v050}{\x{1}B\x{1}}g;
  s{terview-sshd}{\x{1}C\x{1}}g;
  s{terview-updater\.}{\x{1}D\x{1}}g;
  unless (/sin-renombrar/) { s/TerView/SSHorus/g; s/Terview/Sshorus/g; s/terview/sshorus/g; s/TERVIEW/SSHORUS/g; }
  s{\x{1}A\x{1}}{Projects/TERVIEW}g;
  s{\x{1}B\x{1}}{TERVIEW-v050}g;
  s{\x{1}C\x{1}}{terview-sshd}g;
  s{\x{1}D\x{1}}{terview-updater.}g;
'
svg_cambiados=()
cambiados=0
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  excluido "$f" && continue
  grep -Iq . "$f" 2>/dev/null || continue            # binario o vacío
  grep -qiE 'terview' "$f" || continue
  antes=$(cksum <"$f")
  perl -CSD -pi -e "$reemplazar" "$f"
  if [ "$(cksum <"$f")" != "$antes" ]; then
    echo "cambiado: $f"
    cambiados=$((cambiados + 1))
    case "$f" in docs/arquitectura/*.svg) svg_cambiados+=("$f") ;; esac
  fi
done <<<"$archivos"

# 3) CHANGELOG.md: cabecera + «Sin publicar», y URLs del repo en todo el archivo.
if [ -f CHANGELOG.md ] && { [ $# -eq 0 ] || printf '%s\n' "$@" | grep -qx 'CHANGELOG.md'; }; then
  antes=$(cksum <CHANGELOG.md)
  perl -CSD -i -pe '
    $hist = 1 if /^## \[\d/;
    if (/^### /) { $aviso = /^### Importante/ ? 1 : 0; }
    s{LeoMael/TerView}{LeoMael/SSHorus}g;
    unless ($hist || $aviso) { s/TerView/SSHorus/g; s/terview/sshorus/g; s/TERVIEW/SSHORUS/g; }
  ' CHANGELOG.md
  [ "$(cksum <CHANGELOG.md)" != "$antes" ] && { echo "cambiado: CHANGELOG.md"; cambiados=$((cambiados + 1)); }
fi

# 4) PNG de los diagramas cuyo SVG cambió.
for s in "${svg_cambiados[@]+"${svg_cambiados[@]}"}"; do
  if command -v inkscape >/dev/null 2>&1; then
    inkscape "$s" --export-type=png --export-filename="${s%.svg}.png" >/dev/null 2>&1 &&
      echo "regenerado: ${s%.svg}.png"
  else
    echo "AVISO: instala Inkscape y regenera ${s%.svg}.png"
  fi
done

echo "Listo: $renombrados archivos renombrados, $cambiados con contenido cambiado."
echo "Restos (deberían ser solo los protegidos):"
git grep -nI -i terview -- . ':!CHANGELOG.md' ':!docs/PENDIENTES.md' ':!docs/marca' ":!$yo" |
  grep -v -e 'sin-renombrar' -e 'terview-sshd' -e 'terview-updater\.' -e 'Projects/TERVIEW' -e 'TERVIEW-v050' || echo "  (ninguno)"
