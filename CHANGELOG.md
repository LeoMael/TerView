# Historial de cambios

Todos los cambios importantes de SSHorus se anotan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones
siguen [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Importante
- **La app se llama ahora SSHorus** (antes TerView), con logo nuevo: el ojo de Horus dentro de un anillo,
  con la terminal `>_`. Para el sistema es otra app, así que **no se traen los datos de TerView** y esta vez
  hay que instalarla a mano (la TerView instalada no la ve como actualización):
  - **Servidores, proyectos, ajustes, comandos propios, túneles y PIN empiezan vacíos.** Vuelve a añadir los
    servidores o impórtalos con **Importar `~/.ssh/config`** (los que exportaste desde TerView están en su
    bloque `# >>> TerView … >>>`; después de importarlos puedes borrar ese bloque).
  - **Las contraseñas guardadas no se pasan**: vuelve a escribirlas. Las de TerView siguen en el llavero del
    sistema (servicio `terview`) y se pueden borrar desde su gestor de contraseñas.
  - Carpetas nuevas: `~/.config/sshorus/` y `com.sshorus.app` (antes `~/.config/terview/` y
    `com.terview.app`). Las de TerView se pueden borrar a mano.
  - **Asistentes de IA (MCP)**: el servidor se llama `sshorus`, el puente `sshorus-mcp` y las variables
    `SSHORUS_MCP_TOKEN` / `SSHORUS_MCP_PORT`. Vuelve a añadirlo desde Ajustes → Asistentes de IA y quita el
    `terview` viejo de Claude Code, Claude Desktop o Codex.
  - Las terminales tmux que dejó TerView en los servidores (`terview-…`) ya no se recuperan solas, la copia
    sincronizada de GitHub empieza de cero (`sshorus-sync.json`) y los comandos exportados con TerView no se
    importan.
  - En Linux, desinstala el paquete viejo con `sudo dnf remove ter-view` o `sudo apt remove ter-view` (el
    nuevo se llama `ss-horus`); en Windows, desde Configuración → Aplicaciones.
  - El repositorio pasa a [github.com/LeoMael/SSHorus](https://github.com/LeoMael/SSHorus) y de ahí salen las
    actualizaciones automáticas. Las versiones de TerView no publicaban `latest.json` (faltaba la llave de
    firma en GitHub), por eso la app nunca encontraba versiones nuevas.

### Añadido
- **Escáner → «Actualizar imagen»**: en las vulnerabilidades de una imagen de Podman o Docker, un botón
  que la actualiza de verdad y dice qué contenedores se recrean. Lee en el momento cómo se creó cada
  contenedor: si es de **Compose**, hace `compose pull` y `compose up -d` en su carpeta; si lo arranca
  **systemd/Quadlet**, descarga la imagen y reinicia la unidad; si se creó **a mano**, descarga la imagen
  y abre el formulario «Nuevo contenedor» ya relleno para reemplazarlo (si el nuevo no arranca, vuelve el
  viejo). Antes muestra los comandos exactos y pide confirmación; se ejecuta como el dueño de la imagen,
  con su salida y «Cancelar». Al terminar vuelve a analizar esa imagen y avisa si todavía tiene
  vulnerabilidades.
- **Terminal local** («Este equipo»): pestañas con una terminal **de tu propio PC**, junto a las de los
  servidores. Misma terminal que las de SSH (tema, búsqueda, copiar/pegar, tamaño). Se abren con el botón
  del portátil en la barra de pestañas, desde «+» o desde «Nuevo» en la barra lateral, en la carpeta que
  elijas (SSHorus recuerda la última). Usa la shell del sistema (`$SHELL`; PowerShell en Windows). Al
  cerrar la pestaña se termina lo que corre en ella **y sus procesos hijos**. El PIN también las tapa.
- **Claude Code y Codex con el contexto de SSHorus**: botones rápidos que los abren en una pestaña local.
  - Si no están instalados, SSHorus lo dice y ofrece instalarlos **mostrando antes el comando exacto**
    (el instalador oficial de Claude Code; `npm install -g @openai/codex` para Codex, avisando si falta
    Node.js). La instalación corre en la pestaña, a la vista.
  - Cada programa inicia sesión a su manera (suscripción o clave de API). SSHorus **no lee ni copia**
    `~/.claude` ni `~/.codex`.
  - El asistente recibe un **contexto**: tus servidores con su alias de `~/.ssh/config`, usuario, host,
    puerto, proyecto, si están conectados, qué servidor estabas mirando y la fecha. Sabe que puede usar
    `ssh <alias> '<comando>'` y qué servidores van con contraseña (para esos, el MCP). Nunca lleva
    contraseñas, llaves, tokens ni el PIN.
  - Y, si está activo, el **MCP de SSHorus** ya configurado (con tus permisos y aprobaciones). Si está
    apagado, SSHorus pregunta si activarlo o abrir solo con el contexto.
  - Nada se escribe en la carpeta del proyecto: a Claude Code se le pasa con `--append-system-prompt` y
    `--mcp-config`; a Codex con `-c developer_instructions=…` y `-c mcp_servers.sshorus.…`. El token del
    MCP va por una variable de entorno del proceso, no en archivos ni en los argumentos.
  - Ajustes → **Terminal local e IA**: vía (ssh directo, MCP o las dos), qué contexto se incluye, la
    carpeta de trabajo, ver el contexto exacto y si cada asistente está instalado.
- **Enviar a la IA**: en una terminal de servidor, selecciona texto y, con clic derecho, «Enviar a la IA».
  Se pega en la pestaña del asistente abierto (sin pulsar Enter, para que añadas tu pregunta) o abre uno.
- **Servidor nuevo: hosts guardados y prueba de conexión.** El campo Host sugiere tus servidores guardados
  (nombre y `usuario@host:puerto`) y avisa si ya tienes uno con el mismo host, puerto y usuario («Abrir»
  o, desde un proyecto, «Añadirlo»). Botón **«Probar conexión»**, y al guardar un servidor nuevo (o al
  cambiar sus datos de conexión) se prueba antes: conecta, comprueba la huella con el diálogo de siempre y
  desconecta, sin abrir pestaña, con 10 s de límite y «Cancelar prueba». Si falla dice por qué (host no
  encontrado, puerto cerrado, contraseña o llave rechazada…) y deja «Guardar de todos modos». La
  contraseña escrita solo se usa en memoria durante la prueba.

- **Asistentes de IA (MCP): «Aceptar automáticamente».** Por servidor (solo con acceso Completo), para no
  aprobar cada rato: **cambios normales** o **todo** (también lo peligroso y sudo, con advertencia en rojo y
  confirmación), durante 15 min, 1 h, hasta cerrar SSHorus o siempre. Se activa en Ajustes → Asistentes de
  IA o desde el propio diálogo de permiso. Con sudo usa la contraseña en memoria o guardada sin preguntar
  (la IA nunca la ve). Nunca con SSHorus bloqueado ni en solo lectura. Indicador «Automático» en la barra de
  pestañas (un clic lo apaga), etiqueta «automático» en la actividad y aviso en lo peligroso.

- **Ajustes con diseño nuevo y apariencias.** Menú lateral con iconos por grupos, buscador de ajustes,
  cabecera por sección y ajustes en tarjetas; se adapta a ventanas estrechas. Nueva sección **Apariencia**
  con 7 temas (Sistema, Oscuro, Claro, Medianoche, Arena, Fiordo y Alto contraste) que cambian también la
  terminal y el editor, al momento; color de acento elegible y tamaño de letra de la interfaz.
  Textos más cortos: una línea de ayuda como máximo y los detalles en tooltips.
- **Atajos de teclado configurables** (Ajustes → Atajos de teclado): 24 atajos (generales, terminal,
  explorador y guardar en el editor). Clic en un atajo y pulsa la combinación nueva; avisa si choca con
  otra acción o con teclas de la terminal (Ctrl+C, Ctrl+D…); restablecer uno o todos. Los menús y
  tooltips muestran el atajo actual.
- **Crear usuario con acceso solo por clave SSH** (Administración → Usuarios → «Nuevo usuario con
  clave…»): la clave se pega, se elige de `~/.ssh` o se genera (ed25519, en tu equipo; la privada nunca
  sale de él). Detecta AllowGroups/AllowUsers de sshd, ofrece sudo y linger, muestra los comandos antes,
  prueba el acceso con la clave y ofrece guardar el servidor. No toca PasswordAuthentication. También como
  comando de la Biblioteca (`usuarios.crear-usuario-clave`), usable por el asistente.
- **Auditar servidor** (Administración → Auditoría): un botón que revisa SSH, usuarios con sudo, puertos y
  cortafuegos, actualizaciones y reinicio pendiente, certificados, contenedores, servicios caídos, intentos
  de entrada, disco y memoria, y endurecimiento (`hidepid`, permisos de archivos sensibles…), sin instalar
  nada. Nota por categoría y general (A–F), comparación con la auditoría anterior, historial, exportar a
  Markdown o HTML y «Explicar con IA». Cada problema trae su comando para arreglarlo, que se muestra antes y
  se confirma (lo peligroso, escribiendo «ARREGLAR»). Para el asistente: `get_audit_report` y `run_audit`.
- **Mapa de infraestructura** (Administración → Mapa, o clic derecho en un proyecto → Mapa): diagrama de
  arquitectura que se arma solo: Internet → cortafuegos → puertos → proxy web → sitios (con su certificado)
  → contenedores y servicios → bases de datos, con una caja por usuario (con sudo, los de todos los
  usuarios). En un proyecto une los servidores y dibuja las conexiones entre ellos (p. ej. la app de un
  servidor → la base de datos de otro). Zoom, filtros, detalles al hacer clic y exportar a PNG, SVG o
  Mermaid. Para el asistente: `get_infra_map`.

### Corregido
- **sudo con contraseña en más sitios.** «Ejecutar en varios servidores» usa la contraseña de sudo de cada
  servidor (un diálogo a la vez, con «Saltar este servidor»). El escáner avisa si la contraseña guardada no
  funciona y deja escribir otra (un solo intento fallido por análisis). En el modo «La de la conexión» se usa
  también la contraseña escrita al conectar sin guardarla (solo en memoria; se borra al cerrar o bloquear).
- **Editor: la barra de estado se veía cortada** (el selector de lenguaje, p. ej. «Markdown», salía por
  la mitad en Linux por el aspecto nativo de GTK). Ahora tiene su propio estilo y la barra un poco más alta.
- **Asistentes de IA (MCP): los comandos con sudo funcionan.** `run_command` (p. ej. `sudo whoami`) y
  `run_catalog_command` (p. ej. «Crear usuario») fallaban con «sudo: a terminal is required to read the
  password». Ahora, tras aprobarlo en SSHorus, se usa la contraseña de sudo de esa conexión igual que en
  Administración: la que ya está en memoria, la guardada (o la de la conexión) o la de otra pestaña del
  mismo servidor; si no hay ninguna, se pide con el diálogo de siempre. Es la misma memoria que la de la
  interfaz: se pide como mucho una vez por conexión, también con varios `sudo` en un comando.
  - El asistente nunca la ve: va por la entrada estándar a un envoltorio que se la da a cada `sudo` (también
    en tuberías como `echo x | sudo tee /etc/y` o `sudo bash -c '…'`), sin dejarla en archivos, en la línea
    de comandos ni en el registro; si un comando la mostrara, se tapa en la respuesta.
  - Contraseña incorrecta: error claro en unos segundos («Contraseña de sudo incorrecta»), con un solo
    intento fallido; se olvida y la guardada queda marcada como rechazada, igual que en la interfaz.
  - Los comandos con sudo siguen pidiendo permiso siempre; con SSHorus bloqueado no se hace nada.
- **Añadir un servidor desde un proyecto**: cada proyecto de la barra lateral tiene ahora un botón **+**
  (y, con clic derecho, **Añadir servidor nuevo…** y **Añadir servidor existente**). El editor se abre
  indicando «Se añadirá al proyecto X», con un selector para cambiarlo o dejarlo sin proyecto. Al guardar,
  el servidor queda dentro del proyecto y aparece seleccionado en él. Antes se abría el editor normal y el
  servidor no quedaba en el proyecto.
- Los menús de la barra lateral con muchas entradas (p. ej. la lista de servidores) se desplazan en vez de
  salirse de la ventana.
- **sudo ya no pide otra vez una contraseña que está guardada.** Administración, Contenedores y el escáner
  buscan la contraseña siempre en el mismo orden antes de preguntar: la de esta conexión en memoria → la
  guardada del servidor (o la de la conexión) → la de otra pestaña abierta al mismo servidor → preguntar.
  - Si el diálogo se abría mientras la guardada aún se estaba comprobando (al entrar en el panel o al
    pulsar una acción enseguida), salía pidiéndola; ahora espera a esa comprobación y, si sirve, se cierra
    solo («Se usó la contraseña guardada de este servidor»).
  - Si la guardada no funciona, se pide **una vez** con el aviso «La contraseña guardada no funcionó» y
    «Guardar para este servidor» marcado, y al confirmarla se actualiza. Antes el diálogo volvía a
    aparecer cada vez que se entraba en la pestaña.
  - Tras desbloquear el PIN se vuelve a leer la guardada si la lectura había fallado por estar bloqueado.
  - «Guardar para este servidor» viene marcado si el servidor ya usa una contraseña guardada o la de la
    conexión.
  - Una segunda pestaña al mismo servidor reutiliza la contraseña ya escrita en la primera (comprobada con
    sudo antes de usarla). «Olvidar contraseña de sudo» lo sigue respetando hasta reconectar.

- **Contenedores con sudo ya ven los de todos los usuarios.** Con root o sudo aparece el selector
  **Usuario**: tú, **root** y cada usuario con contenedores propios (Podman rootless; también Docker
  rootless si su demonio está en marcha), o **Todos**. La lista de usuarios es la misma que usa el escáner.
  - Con **Todos**, las listas (contenedores, imágenes, volúmenes, redes y proyectos Compose) llevan la
    columna **Usuario**. Se leen todos a la vez en un solo script; si un usuario falla, se ve su error y
    los demás aparecen igual.
  - **Cada acción se ejecuta como el dueño** (iniciar, parar, logs, terminal dentro, inspeccionar,
    borrar, descargar imagen, volúmenes, redes, Compose, nuevo contenedor y limpieza): se entra como él
    con `runuser` (o `sudo -u`, o `su`) con su HOME y su `XDG_RUNTIME_DIR`, nunca como root. El comando
    que se muestra y el que va a la terminal lo dicen («sudo runuser -u ana -- …»).
  - Con **Todos**, crear y limpiar piden elegir antes un usuario arriba.
  - Sin sudo todo sigue como antes: solo lo de tu usuario.

## [0.5.0] - 2026-11-12

### Añadido
- **Asistentes de IA (MCP)**: servidor MCP propio para que Claude Code, Claude Desktop
  u otro cliente MCP trabajen con tus servidores **usando las conexiones de TerView, sin ver nunca
  contraseñas ni llaves**. Apagado por defecto; se activa en Ajustes → Asistentes de IA (MCP).
  - Permiso por servidor: **Sin acceso** (por defecto), **Solo lectura** o **Completo**. Las lecturas
    pasan solas; todo lo que cambia algo abre un diálogo en TerView con el comando exacto (o las
    diferencias del archivo): Permitir una vez / Permitir siempre este comando en este servidor /
    Denegar. Si nadie responde en 2 minutos (ajustable), se deniega. Lo peligroso (`rm -rf`, `prune`,
    `sudo`, `reboot`… o un comando ⚠️ de la Biblioteca) se pregunta siempre.
  - Con TerView bloqueado por PIN, el asistente no puede hacer nada.
  - Herramientas: servidores, proyectos y conexiones, abrir una conexión (como pestaña), ejecutar
    comandos (cancelables, con tiempo y salida limitados), comandos de la Biblioteca, explorar, leer y
    escribir archivos, subir y descargar con la cola de transferencias, ver puertos, sitios web y
    contenedores, y consultar vulnerabilidades (el último informe, o un análisis nuevo sin sudo que se
    aprueba la primera vez).
  - Escucha solo en `127.0.0.1` con un token que se puede regenerar (guardado como tus contraseñas). Para
    clientes por stdio se instala el puente `terview-mcp`. Cada acción queda en el panel **Actividad del
    asistente** (con botón para detener un comando) y en `mcp-audit.jsonl`. Ajustes muestra la
    configuración lista para copiar en Claude Code y Claude Desktop.
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
- **Terminales persistentes (tmux)**: si el servidor tiene tmux, cada terminal vive en su propia sesión
  y sigue corriendo aunque se corte la red o cierres la app; al reconectar, TerView vuelve a ella.
  Ajuste Automático / Siempre / Nunca (general y por servidor), indicador ∞ en la pestaña, lista de
  sesiones que quedaron en el servidor para reabrirlas o cerrarlas, y «Desacoplar» para dejar una
  corriendo. El historial, la búsqueda y el copiar/pegar funcionan igual que sin tmux, y no se toca tu
  `~/.tmux.conf`.
- **PIN y bloqueo**: las contraseñas guardadas (de conexión y de sudo) y los tokens (GitHub, IA y MCP)
  pueden ir en una bóveda cifrada (`vault.json`, AES-256-GCM + Argon2id) protegida con un **PIN de 6
  números** y una llave de este equipo guardada en el llavero, así que copiar solo el archivo no sirve.
  - Al crearla, lo que había en el llavero se mueve a ella sin riesgo de perderlo; al quitarla, vuelve
    al llavero.
  - TerView se bloquea al abrirlo, tras 5–60 min sin uso (15 por defecto) o con `Ctrl+Shift+L`, en
    todas las ventanas: se tapa la interfaz y se borran de la memoria las contraseñas descifradas y las
    de sudo hasta que escribes el PIN. Las conexiones siguen vivas; una reconexión que necesita
    contraseña espera al desbloqueo.
  - Tras 5 fallos hay que esperar 30 s, el doble cada vez hasta 15 min (se recuerda aunque cierres la
    app).
  - El PIN se escribe en 6 casillas y se envía solo al completarlo. Las bóvedas creadas antes con una
    contraseña libre se siguen abriendo con un campo de texto hasta que cambias el PIN.
  - **«Olvidé mi PIN»** borra la bóveda (escribiendo BORRAR): se pierden las contraseñas y los tokens, y
    se conservan servidores, llaves, comandos, túneles y ajustes.
  - Pantalla para crearlo la primera vez, con «Ahora no», y **candado en la barra de pestañas** para
    bloquear, cambiar el PIN o ir a Ajustes → Seguridad. Los detalles están en «¿Qué protege?».
- **Contraseña de sudo por servidor** (editor de servidor): «Pedir cada vez» (por defecto, solo en
  memoria), «La de la conexión» o «Guardar» (útil si entras con llave SSH), cifrada con el PIN o en el
  llavero. Botón de ojo para ver la contraseña guardada (con PIN, lo pide antes). En Administración,
  «Cambiar contraseña de sudo…»; si la guardada falla, se pide otra y se ofrece guardarla. Borrar,
  duplicar y activar o quitar el PIN la tienen en cuenta; la copia en Gist solo lleva el modo.
- **Detección de privilegios**: insignia **root** / **sudo** en la pestaña de la conexión, sin pedir
  contraseña ni dejar rastro en el servidor.
- **IA opcional para explicar informes** (Ajustes → IA para explicar informes): cualquier servicio
  compatible con OpenAI (también uno local como Ollama). Es otra cosa que el MCP: aquí TerView le
  pregunta a la IA, y solo para que **explique** un informe. Antes de enviar ves el texto exacto, sin
  nombre del servidor, IP, usuarios ni rutas. El token va en la bóveda o el llavero.
- **Manual de uso dentro de la app** (Ajustes → Manual de uso, el botón ? de la barra o la bienvenida):
  pasos cortos con capturas de cada función, atajos de teclado y solución de problemas.
- **Novedades y actualizaciones automáticas**: tras actualizar, TerView muestra una vez lo nuevo de la
  versión; el historial completo está en Acerca de. Las actualizaciones van firmadas.
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

[Sin publicar]: https://github.com/LeoMael/SSHorus/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/LeoMael/SSHorus/releases/tag/v0.5.0
[0.3.0]: https://github.com/LeoMael/SSHorus/releases/tag/v0.3.0
[0.2.1]: https://github.com/LeoMael/SSHorus/releases/tag/v0.2.1
[0.2.0]: https://github.com/LeoMael/SSHorus/commit/6dfd50a
