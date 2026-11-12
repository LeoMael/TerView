# Historial de cambios

Todos los cambios importantes de TerView se anotan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones
siguen [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido
- **Escáner de vulnerabilidades** (Administración → **Vulnerabilidades**): un botón **Analizar** que dice
  qué software tiene el servidor (paquetes, kernel, sudo, OpenSSH, nginx, Caddy, Podman, Docker, Node,
  Python, PHP, Java e imágenes de contenedores) y qué vulnerabilidades conocidas le afectan.
  - La lista sale de bases de datos reales: **OSV.dev** (consultado desde tu PC, solo con nombres y
    versiones de paquetes), la herramienta de seguridad de la distro (`dnf`, `debsecan`, `pro`,
    `zypper`) y **Trivy** si el servidor lo tiene. Nunca de una IA.
  - Resumen por gravedad, cambios desde el análisis anterior, tabla con filtros, detalle con enlaces y el
    **comando para actualizar** (se copia o se escribe en la terminal sin Enter; nunca se ejecuta solo).
  - Con sudo, también los contenedores de root y de los usuarios que elijas. Las imágenes se leen sin
    arrancarlas. **Cancelar** detiene el análisis también en el servidor.
  - Historial de los últimos 20 análisis por servidor; exportar a JSON y Markdown.
  - Atajo desde Contenedores → Imágenes: «Ver vulnerabilidades».
- **Asistente de IA opcional** (Ajustes → Asistente de IA): cualquier servicio compatible con OpenAI
  (también uno local como Ollama). Solo **explica** un informe: antes de enviar ves el texto exacto, sin
  nombre del servidor, IP, usuarios ni rutas. El token va en la bóveda o el llavero.

## [0.4.0] - 2026-11-12

### Añadido
- **Contenedores (Podman / Docker)**: pestaña visual para iniciar, parar, reiniciar y eliminar
  contenedores, ver logs, abrir una terminal dentro, crear contenedores con plantillas (Nginx,
  PostgreSQL, MySQL, MariaDB, Redis, Adminer, Portainer), levantar y bajar proyectos **Compose**, y
  limpiar imágenes, volúmenes y redes que no se usan mostrando antes cuánto espacio se libera.
- **Administración del servidor**: una pestaña con varias secciones. Antes de cada cambio se muestra
  el comando exacto, y la contraseña de sudo viaja siempre por la entrada estándar.
  - **Usuarios y grupos**: crear, editar, bloquear y eliminar usuarios, sus llaves SSH, grupos,
    sesiones conectadas e historial de cambios.
  - **Puertos**: todos los puertos en escucha, TCP y UDP, con su proceso, usuario y servicio systemd
    o contenedor. Filtros (públicos o solo locales, usuario, proceso), abrir un túnel a tu PC con un
    clic y copiar la dirección.
  - **Sitios web**: sitios de **nginx** y **Caddy** con sus dominios, HTTPS y fecha de caducidad del
    certificado, a qué sirve cada ruta y si hay algo escuchando en el puerto de destino. Abre la
    configuración en el editor, la comprueba y recarga el servicio con confirmación.
- **Monitor**: gráficas en vivo de CPU, memoria, red y carga, discos, procesos (con botón Terminar),
  consumo de contenedores, alertas configurables y resumen de todas las conexiones.
- **Túneles (port forwarding)**: local, remoto y SOCKS, guardados por servidor, con arranque
  automático al conectar y continuidad tras reconexiones.
- **Ejecutar en varios servidores a la vez**: un comando (o uno de la biblioteca) en varios servidores
  o en un proyecto entero, con resultados en tabla, lado a lado y «Comparar salidas».
- **GitHub**: conectar la cuenta con un token (guardado de forma segura), pasar tus llaves SSH a un
  servidor, clonar repositorios (con deploy key), desplegar con un botón, ver y lanzar GitHub Actions,
  y sincronizar tu configuración en un Gist cifrado.
- **Acerca de** con las novedades de cada versión y **actualizaciones automáticas** firmadas.
- **Terminales persistentes (tmux)**: si el servidor tiene tmux, cada terminal vive en su propia sesión
  y sigue corriendo aunque se corte la red o cierres la app; al reconectar, TerView vuelve a ella.
  Ajuste Automático / Siempre / Nunca (general y por servidor), indicador ∞ en la pestaña, lista de
  sesiones que quedaron en el servidor para reabrirlas o cerrarlas, y «Desacoplar» para dejar una
  corriendo. El historial, la búsqueda y el copiar/pegar funcionan igual que sin tmux, y no se toca tu
  `~/.tmux.conf`.
- **PIN y bloqueo**: las contraseñas guardadas (de conexión y de sudo) y el token de GitHub pueden ir
  en una bóveda cifrada (`vault.json`, AES-256-GCM + Argon2id) protegida con un **PIN de 6 números** y
  una llave de este equipo guardada en el llavero, así que copiar solo el archivo no sirve.
  - Al crearla, las contraseñas del llavero se mueven a ella sin riesgo de perderlas; al quitarla,
    vuelven al llavero.
  - TerView se bloquea al abrirlo, tras 5–60 min sin uso (15 por defecto) o con `Ctrl+Shift+L`, en
    todas las ventanas: se tapa la interfaz y se borran de la memoria las contraseñas descifradas y las
    de sudo hasta que escribes el PIN. Las conexiones siguen vivas; una reconexión que necesita
    contraseña espera al desbloqueo.
  - Tras 5 fallos hay que esperar 30 s, el doble cada vez hasta 15 min (se recuerda aunque cierres la
    app).
  - El PIN se escribe en 6 casillas y se envía solo al completarlo. Las bóvedas creadas antes con una
    contraseña libre se siguen abriendo con un campo de texto hasta que cambias el PIN.
  - **«Olvidé mi PIN»** borra la bóveda (escribiendo BORRAR) y conserva servidores, llaves, comandos,
    túneles y ajustes.
  - Pantalla para crearlo la primera vez, con «Ahora no», y **candado en la barra de pestañas** para
    bloquear, cambiar el PIN o ir a Ajustes → Seguridad. Los detalles están en «¿Qué protege?».
- **Contraseña de sudo por servidor** (editor de servidor): «Pedir cada vez» (por defecto, solo en
  memoria), «La de la conexión» o «Guardar» (útil si entras con llave SSH), cifrada con el PIN o en el
  llavero. Botón de ojo para ver la contraseña guardada (con PIN, lo pide antes). En Administración,
  «Cambiar contraseña de sudo…»; si la guardada falla, se pide otra y se ofrece guardarla. Borrar,
  duplicar y activar o quitar el PIN la tienen en cuenta; la copia en Gist solo lleva el modo.
- **Detección de privilegios**: insignia **root** / **sudo** en la pestaña de la conexión, sin pedir
  contraseña ni dejar rastro en el servidor.
- Explorador: **arrastrar archivos y carpetas al escritorio o a una carpeta** del gestor de archivos
  (Nautilus, Dolphin, Explorador de Windows, Finder). TerView primero los descarga a una carpeta
  temporal (se ve en Transferencias) y luego los suelta donde quieras; si ya estaban descargados, el
  arrastre es inmediato. Funciona con nombres con espacios y acentos, en X11 y en Wayland.
  ⚠️ Sin probar todavía con un arrastre real; en macOS, además, sin compilar.
- Explorador: **«Descargar en…»** y **«Descargar y abrir carpeta»**.
- Transferencias: opción **«Preguntar»** cuando el archivo ya existe (sobrescribir, omitir, mantener
  ambos o solo si es más nuevo, con «aplicar a todos»).
- **Editor en pestañas, como un navegador**: arrastra una pestaña fuera para abrirla en otra ventana,
  reordénalas arrastrando y divide con el explorador solo si quieres (`Ctrl+Shift+M`).
- «Mis comandos»: **exportar e importar a archivo**, con vista previa.
- `~/.ssh/config`: aviso cuando un servidor choca con un `Host` escrito a mano, con un alias
  alternativo.
- **Diagnóstico** (Ajustes → Avanzado): tiempos de arranque y de cada operación, FPS, GPU y «Copiar
  informe».

### Mejorado
- **Cancelar ahora detiene el comando en el servidor**: en el panel de Comandos y en «Ejecutar en
  varios servidores» (también en las pestañas ya abiertas). Antes solo se dejaba de esperar y el
  comando seguía corriendo. Al vencer el tiempo límite también se detiene.
- **Túneles a puertos bajos** (menores de 1024, como 80 o 443): «Abrir túnel» elige solo un puerto
  libre en tu PC, porque esos puertos piden permisos de administrador. Sirve en Puertos y en
  Contenedores.
- **Ajustes** en una ventana un poco más ancha (se adapta a pantallas pequeñas).

### Corregido
- **Doble clic en un servidor** de la barra lateral: ahora va a su pestaña abierta (y la reconecta si
  hace falta) en lugar de abrir otra conexión. Para abrir otra conexión: Ctrl+doble clic.

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

[Sin publicar]: https://github.com/LeoMael/TerView/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/LeoMael/TerView/releases/tag/v0.4.0
[0.3.0]: https://github.com/LeoMael/TerView/releases/tag/v0.3.0
[0.2.1]: https://github.com/LeoMael/TerView/releases/tag/v0.2.1
[0.2.0]: https://github.com/LeoMael/TerView/commit/6dfd50a
