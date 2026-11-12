# Historial de cambios

Todos los cambios importantes de TerView se anotan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones
siguen [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido
- **Contenedores (Podman / Docker)**: pestaña visual para iniciar, parar, reiniciar y eliminar
  contenedores, ver logs, abrir una terminal dentro, crear contenedores con plantillas (Nginx,
  PostgreSQL, MySQL, MariaDB, Redis, Adminer, Portainer), levantar y bajar proyectos **Compose**, y
  limpiar imágenes, volúmenes y redes que no se usan mostrando antes cuánto espacio se libera.
- **Administración**: pestaña para gestionar usuarios (crear, editar, bloquear, eliminar, llaves SSH),
  grupos, sesiones conectadas e historial de cambios. La contraseña de sudo se pide una vez por
  sesión, se guarda solo en memoria y viaja siempre por la entrada estándar. Antes de cada cambio se
  muestra el comando exacto.
- **Detección de privilegios**: insignia **root** / **sudo** en la pestaña de la conexión, sin pedir
  contraseña ni dejar rastro en el servidor.
- **Monitor**: gráficas en vivo de CPU, memoria, red y carga, discos, procesos (con botón Terminar),
  consumo de contenedores, alertas configurables y resumen de todas las conexiones.
- **Túneles (port forwarding)**: local, remoto y SOCKS, guardados por servidor, con arranque automático
  al conectar y continuidad tras reconexiones.
- **Ejecutar en varios servidores a la vez**: un comando (o uno de la biblioteca) en varios servidores o
  un proyecto entero, con resultados en tabla, lado a lado y "Comparar salidas".
- **GitHub**: conectar la cuenta con un token (guardado en el llavero), pasar tus llaves SSH a un
  servidor, clonar repositorios (con deploy key), desplegar con un botón, ver y lanzar GitHub Actions,
  y sincronizar tu configuración en un Gist cifrado.
- **Editor en pestañas, como un navegador**: arrastra una pestaña fuera para abrirla en otra ventana;
  reordénalas arrastrando; divide con el explorador solo si quieres (`Ctrl+Shift+M`).
- **Acerca de** con novedades y **actualizaciones automáticas** firmadas.
- **Diagnóstico** (Ajustes → Avanzado): tiempos de arranque y de cada operación, FPS, GPU y "Copiar informe".
- Transferencias: opción **"Preguntar"** cuando el archivo ya existe (sobrescribir, omitir, mantener
  ambos o solo si es más nuevo, con "aplicar a todos").
- Explorador: **"Descargar en…"** y **"Descargar y abrir carpeta"**.
- Explorador: **arrastrar archivos y carpetas al escritorio o a una carpeta** del gestor de archivos
  (Nautilus, Dolphin, Explorador de Windows, Finder). TerView primero los descarga a una carpeta
  temporal (se ve en Transferencias) y luego los suelta donde quieras; si ya estaban descargados, el
  arrastre es inmediato. Funciona con nombres con espacios y acentos, en X11 y en Wayland.
  ⚠️ Sin probar todavía con un arrastre real; en macOS, además, sin compilar.
- "Mis comandos": **exportar e importar a archivo**, con vista previa.
- `~/.ssh/config`: aviso cuando un servidor choca con un `Host` escrito a mano y alias alternativo.
- **Puertos** (en Administración): todos los puertos en escucha, TCP y UDP, con su proceso, usuario y
  servicio systemd o contenedor. Filtros (públicos o solo locales, usuario, proceso), abrir un túnel a
  tu PC con un clic y copiar la dirección.
- **Sitios web** (en Administración): sitios de **nginx** y **Caddy** con sus dominios, HTTPS y fecha
  de caducidad del certificado, a qué sirve cada ruta y si hay algo escuchando en el puerto de destino.
  Abre la configuración en el editor, comprueba la configuración y recarga el servicio con confirmación.

### Mejorado
- **Cancelar ahora detiene el comando en el servidor**: en el panel de Comandos y en "Ejecutar en
  varios servidores" (también en las pestañas ya abiertas). Antes solo se dejaba de esperar y el
  comando seguía corriendo. Al vencer el tiempo límite también se detiene.
- **Túneles a puertos bajos** (menores de 1024, como 80 o 443): "Abrir túnel" elige solo un puerto
  libre en tu PC, porque esos puertos piden permisos de administrador. Sirve en Puertos y en Contenedores.
- **Doble clic en un servidor** de la barra lateral: va a su pestaña abierta (y la reconecta si hace
  falta) en lugar de abrir otra conexión. Para otra conexión: Ctrl+doble clic.

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

[Sin publicar]: https://github.com/LeoMael/TerView/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/LeoMael/TerView/releases/tag/v0.3.0
[0.2.1]: https://github.com/LeoMael/TerView/releases/tag/v0.2.1
[0.2.0]: https://github.com/LeoMael/TerView/commit/6dfd50a
