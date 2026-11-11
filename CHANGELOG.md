# Historial de cambios

Todos los cambios importantes de TerView se anotan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones
siguen [Versionado Semántico](https://semver.org/lang/es/).

## [0.3.0] - 2026-11-11

### Añadido
- **Soporte para Windows 10 / 11**: instaladores `-setup.exe` (NSIS, en español, instalación por
  usuario sin permisos de administrador) y `.msi` (WiX, para empresas o instalación silenciosa).
  Si falta Microsoft Edge WebView2, el instalador lo descarga solo.
- **Instaladores automáticos con GitHub Actions**: al publicar una versión se generan los
  instaladores de Linux (`.rpm`, `.deb`, `.AppImage`), Windows (`.msi`, `-setup.exe`) y macOS
  (`.dmg` universal) y se adjuntan al Release.
- **Integración continua**: en cada cambio se comprueba que la app compila y pasa las pruebas en
  Linux y en Windows.

- **Agente SSH en Windows**: usa el agente de OpenSSH de Windows o Pageant.
- Ajuste **"Aceleración por GPU en la terminal"** (WebGL), activado por defecto, con vuelta automática
  al dibujado normal si la GPU falla.

### Mejorado
- **Arranque más rápido**: el código inicial pasa de 914 KB a 362 KB; el resto (sesiones, comandos,
  ajustes, editor) se carga cuando hace falta o en segundo plano.
- **Ventana más fluida en Linux con NVIDIA**: se detecta el driver y se aplica el arreglo de dibujado
  de WebKitGTK automáticamente (`TERVIEW_WEBKIT_DEFAULTS=1` lo desactiva).
- Menos redibujados de la interfaz durante transferencias y reconexiones; estilos más ligeros.
- Descargas en Windows: los nombres no válidos (`: * ? " < > |`, `CON`, `NUL`…) se adaptan solos
  y los nombres repetidos se guardan como `nombre (2).ext`.
- Guardado de ajustes y huellas más robusto en Windows (reintenta si otro programa tiene el archivo abierto).
- Rutas de Windows (`C:\...`) en arrastrar y soltar, `~/.ssh/config` y llaves.

### Notas
- Los instaladores de Windows y macOS aún no están firmados: Windows SmartScreen puede mostrar
  "Windows protegió su PC" (*Más información → Ejecutar de todas formas*).

## [0.2.1] - 2026-11-11

### Documentación
- README completo: funciones, instalación paso a paso por sistema (Fedora/RHEL/openSUSE,
  Debian/Ubuntu, AppImage, Windows y macOS), primeros pasos, atajos de teclado, solución de
  problemas y desarrollo.

## [0.2.0] - 2026-11-11

Primera versión pública de TerView, cliente SSH/SFTP de escritorio.

### Añadido
- **Conexiones SSH** con contraseña, llave o agente SSH; verificación de la huella del servidor y
  **doble factor (2FA / códigos OTP)**.
- **Reconexión rápida y automática** cuando se corta la red.
- **Terminal integrada** (xterm.js) con búsqueda (`Ctrl+Shift+F`) y atajos documentados.
- **Explorador de archivos remoto** con **editor** integrado (Monaco).
- **Transferencias masivas** de archivos y carpetas: cola con límite de transferencias simultáneas
  por servidor, enlaces simbólicos y política ante conflictos (sobrescribir / omitir / solo si es
  más nuevo).
- **Biblioteca de comandos** (Podman, Docker, análisis del sistema, discos, red, servicios, logs…),
  paleta rápida `Ctrl+Shift+P`, comandos con variables, "Analizar servidor" y "Mis comandos".
- **Servidores y proyectos guardados**, duplicar servidor; contraseñas en el **llavero del
  sistema**.
- **Exportar e importar `~/.ssh/config`**.
- Logo e ícono de la aplicación.
- Instalador `.rpm` para Linux.
- Documentación con diagramas en `docs/`.

[Sin publicar]: https://github.com/LeoMael/TerView/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/LeoMael/TerView/releases/tag/v0.2.1
[0.2.0]: https://github.com/LeoMael/TerView/commit/6dfd50a
