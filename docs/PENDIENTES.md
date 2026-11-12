# TerView — Pendientes y próximas funciones

Estado al 12/11/2026: versión publicada **0.3.0**; lo hecho después y aún sin publicar se marca como
**v0.4.0** (así lo llama el CHANGELOG, en «Sin publicar»). Todo el plan de la sección 8 está construido:
administración (usuarios, grupos, **puertos y sitios web**), monitor, túneles, contenedores, ejecutar en
varios servidores, GitHub, versiones y actualizaciones. Los comandos que se ejecutan aparte ya se pueden
**cancelar de verdad** (se detienen también en el servidor).

**Lo que sigue pendiente:**
- **Servidor MCP** (sección 3): opcional, diseñado y en pausa.
- **Firmar el instalador** de Windows (SmartScreen avisa al instalar).
- **Pruebas reales**: en un Windows real, contra un servidor con 2FA y con un agente SSH real.
- **Medir el rendimiento** en la app real (el panel de diagnóstico ya existe).
- **Probar con el ratón el arrastre al sistema** (ya implementado en Linux, Windows y macOS; macOS sin compilar).
- **Pruebas automáticas de la interfaz** dentro de la app real.

Este documento guarda lo que falta, **con suficiente detalle para retomarlo más tarde**.

| # | Función | Prioridad | Estado |
|---|---------|-----------|--------|
| 1 | [Biblioteca de comandos](#1-biblioteca-de-comandos) (Podman, análisis del sistema, etc.) | Alta | ✅ Hecho (v0.2.0) |
| 2 | [Reconexión rápida y automática](#2-reconexión-rápida-y-automática) | Alta | ✅ Hecho (v0.2.0) |
| 3 | [Servidor MCP (conectar asistentes de IA)](#3-servidor-mcp-conectar-asistentes-de-ia) | **Opcional** (última fase) | Diseñado, en pausa |
| 5 | [Exportar servidores a `~/.ssh/config`](#5-exportar-servidores-a-sshconfig) | Alta (corta) | ✅ Hecho (v0.2.0) |
| 4 | [Otros pendientes detectados](#4-otros-pendientes-detectados) | Media/Baja | Mayoría hecha; ver tabla |

**Orden sugerido:** 2 (reconexión) → 5 (exportar a `~/.ssh/config`) → 1 (biblioteca de comandos)
→ 3 (MCP, solo si hace falta; reutiliza `exec_capture` y el catálogo de la biblioteca).

---

## 1. Biblioteca de comandos

![Panel de comandos](arquitectura/07-biblioteca-comandos.png)

### Qué es
Un lugar dentro de la app donde están **todos los comandos útiles listos para aplicar** en el
servidor conectado, sin tener que recordarlos ni escribirlos: levantar contenedores con Podman,
ver logs, analizar el sistema, revisar discos, puertos, servicios, etc.

El catálogo inicial (todos los comandos, por categoría) está en
[`comandos/CATALOGO.md`](comandos/CATALOGO.md).

### Cómo se usa
1. **Panel "Comandos"** en cada pestaña de conexión (junto a "Archivos"), con buscador y categorías:
   Podman · Docker · Análisis del sistema · Procesos · Discos · Red · Servicios (systemd) · Logs ·
   Usuarios · Paquetes · Seguridad · Web (nginx/apache) · Git · **Mis comandos**.
2. **Paleta rápida** con `Ctrl+Shift+P`: escribes "podman logs" y lo ejecutas sin tocar el ratón.
3. Cada comando muestra **exactamente lo que se va a ejecutar** antes de correrlo.
4. Tres formas de aplicarlo:
   - **Insertar en terminal**: lo escribe en la terminal activa sin pulsar Enter (para revisarlo).
   - **Ejecutar**: lo escribe y lo ejecuta en la terminal activa.
   - **Ejecutar y ver resultado**: lo corre aparte (canal `exec`) y muestra la salida en el panel
     (tabla o texto), sin ensuciar la terminal. Ideal para análisis.

### Comandos con variables
Ejemplo: `podman logs -f --tail {{lineas:200}} {{contenedor}}`
- `{{contenedor}}` abre un formulario; las opciones **se sugieren desde el servidor**
  (p. ej. lista de contenedores con `podman ps -a --format '{{.Names}}'`).
- `{{lineas:200}}` = variable con valor por defecto.

### Análisis del sistema (un clic)
Botón **"Analizar servidor"** que corre comandos de solo lectura y arma un informe visual:
sistema operativo y kernel, tiempo encendido, CPU y carga, memoria y swap, discos (con alerta
si > 85 %), procesos que más consumen, servicios fallidos, puertos abiertos, contenedores
(Podman/Docker), últimos errores del sistema, actualizaciones pendientes.
Detecta la distribución (Fedora/RHEL → `dnf`, Debian/Ubuntu → `apt`, Alpine → `apk`) para usar
el comando correcto.

### Mis comandos (personalizados)
- Crear, editar, duplicar y borrar comandos propios.
- Alcance: **global**, **por proyecto** o **por servidor**.
- Importar/exportar en JSON para compartir con el equipo.
- Se guardan en `~/.config/terview/commands.json`.

### Seguridad
- Comandos marcados como **peligrosos** (borrar, `prune`, reiniciar, `rm`…) piden confirmación
  y se muestran en rojo.
- Comandos con `sudo` se marcan; la contraseña de sudo **nunca** se guarda ni se envía sola:
  se escribe en la terminal.
- "Ejecutar y ver resultado" tiene límite de tiempo (p. ej. 30 s) y botón para cancelar.

### Cómo se construiría
| Parte | Dónde | Qué hace |
|-------|-------|----------|
| Catálogo base | `src/features/commands/catalog.ts` | Comandos incluidos (desde `CATALOGO.md`) |
| Mis comandos (motor) | `src-tauri/src/snippets/` | Guardar/leer `commands.json` (mismo patrón que `storage/`) |
| Ejecutar y capturar | `src-tauri/src/snippets/exec.rs` | Canal `exec` con tiempo límite; devuelve salida, errores y código |
| Panel | `src/components/Commands/` | Lista, buscador, categorías, formulario de variables, resultados |
| Paleta | `src/components/Commands/Palette.tsx` | `Ctrl+Shift+P` |
| Análisis | `src/components/Commands/Analysis.tsx` | Informe visual del servidor |
| Insertar en terminal | `TerminalArea` | Exponer "escribir en la terminal activa" (hoy no existe) |

Comandos Tauri nuevos: `snippets_load`, `snippets_save`, `snippets_delete`, `exec_capture(sessionId, command, timeoutSecs)`.

---

## 2. Reconexión rápida y automática

### Cómo funciona hoy
- Un vigilante revisa cada **1,5 s** si la conexión sigue viva (`ssh/commands.rs`, `WATCH_INTERVAL`).
- **Si el servidor cierra** la conexión (reinicio, expulsión): se detecta en **1–2 s**.
- **Si se cae la red** (wifi, cable, VPN): se detecta en **90–120 s**, porque la señal de vida
  (`keepalive`) se envía cada 30 s y se da por perdida tras 3 sin respuesta
  (`ssh/connect.rs`: `keepalive_interval: 30s`, `keepalive_max: 3`).
- Al detectarse: punto rojo en la pestaña, aviso **"Conexión perdida"** con **Reconectar** / **Cerrar**,
  terminales muestran "Conexión cerrada", transferencias pasan a error (se pueden reintentar y
  continúan desde donde quedaron).

### Mejora 1 — Detección más rápida
- Bajar `keepalive_interval` a **10 s** (detección en ~30 s).
- Hacerlo configurable en **Ajustes → Conexión** ("Detectar desconexión en: 15 s / 30 s / 60 s / 2 min").
- Archivos: `src-tauri/src/ssh/connect.rs`, `src-tauri/src/types.rs` (`Settings`),
  `src/api/types.ts`, `src/components/Settings/SettingsDialog.tsx`.

### Mejora 2 — Reconexión automática
1. Al caerse, la pestaña muestra **"Reconectando… (intento 2 de 5)"** en vez del error.
2. Reintentos con espera creciente: 1 s, 2 s, 5 s, 10 s, 30 s (configurable, se puede desactivar).
3. Usa la contraseña/frase guardada en el llavero; si no hay, muestra el aviso con **Reconectar**.
4. Al volver:
   - **Mismo `sessionId`** (se reemplaza la conexión dentro de `SessionStore`), así la interfaz
     no tiene que rehacer pestañas.
   - Explorador recarga **la misma carpeta** (requiere que `FileExplorer` informe su ruta actual:
     prop `onPathChange`).
   - Terminales: sin tmux abren una shell nueva (la anterior se pierde). ✅ Con **terminales
     persistentes (tmux)** vuelven a engancharse a la misma sesión y lo que corría sigue vivo (v0.4.0,
     ver sección 7, idea 6).
   - Transferencias con error se **reanudan solas** (el motor ya sabe continuar desde el último byte).
5. Nuevo evento `session://reconnected` y estado `"reconnecting"` en `SessionTab`.

Archivos: `ssh/commands.rs` (vigilante + bucle de reintentos), `ssh/mod.rs` (`SessionStore::replace`),
`types.rs` + `src/api/types.ts` (evento), `stores/tabs.ts` (estado), `components/Session/SessionView.tsx`
(aviso), `components/Terminal/*` (reabrir shell), `stores/transfers.ts` (reanudar).

---

## 3. Servidor MCP (conectar asistentes de IA)

> **Decisión (11/11/2026): en pausa, opcional.** No es necesario para empezar a usar IA con los
> servidores. Alternativas que ya funcionan hoy:
> 1. **Claude Code + `ssh`**: con los servidores en `~/.ssh/config` (ver [punto 5](#5-exportar-servidores-a-sshconfig))
>    y autenticación por llave, Claude Code ejecuta `ssh web-prod '…'` / `scp` directamente y pide permiso
>    antes de cada comando. Cero código.
> 2. **Servidores MCP de terceros** para SSH (p. ej. `tufantunc/ssh-mcp`, `thebusted/SSH-MCP`) o Podman
>    (`manusa/podman-mcp-server`, local). Revisar el código antes y usar usuarios con pocos permisos.
> 3. **Terminales con IA integrada**: Wave Terminal (código abierto), Termius (pago), Warp.
>
> Construir el MCP propio solo si se quiere que la IA use **las conexiones y contraseñas guardadas en
> TerView**, con permisos por servidor, aprobación visual y registro dentro de la app.

![Servidor MCP](arquitectura/08-servidor-mcp.png)

### Qué es
**MCP** (Model Context Protocol) es el estándar para que asistentes de IA (Claude Code,
Claude Desktop, otros clientes MCP) usen herramientas externas. TerView expondría un servidor
MCP para que el asistente pueda **trabajar con tus servidores usando las conexiones que ya
tienes guardadas**, por ejemplo:

> "Revisa por qué se cayó el contenedor web en web-prod y reinícialo"
> → el asistente lista contenedores, lee los logs, te muestra el diagnóstico y pide permiso para `podman restart web`.

### Herramientas que ofrecería (tools)
| Herramienta | Qué hace | Permiso |
|-------------|----------|---------|
| `list_servers` / `list_projects` | Servidores y proyectos guardados (sin contraseñas) | Lectura |
| `list_sessions` | Conexiones abiertas en la app | Lectura |
| `connect` | Abre una conexión a un servidor guardado (aparece como pestaña) | Pide permiso |
| `run_command` | Ejecuta un comando y devuelve salida, errores y código | Pide permiso |
| `run_catalog_command` | Ejecuta un comando de la Biblioteca con sus variables | Pide permiso (salvo 📊 de solo lectura) |
| `analyze_server` | Corre el "Analizar servidor" y devuelve el informe | Lectura |
| `list_dir` / `stat` / `read_file` | Navegar y leer archivos remotos | Lectura |
| `write_file` | Crear/editar archivos (guardado atómico) | Pide permiso, muestra diferencias |
| `upload` / `download` | Transferencias con la cola de la app | Pide permiso |
| `transfer_status` | Progreso de transferencias | Lectura |

Recursos MCP (resources): lista de servidores, catálogo de comandos, informe del último análisis.

### Seguridad (lo más importante)
- **Apagado por defecto.** Se activa en **Ajustes → Asistentes de IA (MCP)**.
- **Permiso por servidor**: *Sin acceso* / *Solo lectura* / *Completo*. Por defecto, *Sin acceso*.
- **Aprobación en TerView** para todo lo que cambie algo: diálogo con el comando exacto
  ("El asistente quiere ejecutar `podman restart web` en web-prod") →
  **Permitir una vez** / **Permitir siempre este comando en este servidor** / **Denegar**.
- Comandos peligrosos (⚠️ del catálogo, `rm -rf`, `prune`, `sudo`…) **siempre** piden permiso.
- **Las contraseñas y llaves nunca salen** por MCP: el asistente solo usa conexiones, no credenciales.
- **Registro de auditoría**: todo lo que hace el asistente queda en
  `~/.config/terview/mcp-audit.log` y visible en un panel de la app ("Actividad del asistente").
- Solo escucha en la propia máquina (`127.0.0.1` / socket local) con **token** que se puede regenerar.

### Cómo se construiría
| Parte | Dónde | Qué hace |
|-------|-------|----------|
| Servidor MCP | `src-tauri/src/mcp/` | SDK oficial de MCP para Rust (crate `rmcp`); reutiliza `SessionStore`, `sftp`, `transfer`, `snippets::exec_capture` |
| Transporte | HTTP local (`127.0.0.1:<puerto>` + token) | Para clientes que hablan HTTP |
| Puente stdio | binario `terview-mcp` | Para clientes que lanzan el servidor por stdio; reenvía a la app abierta por socket local |
| Aprobaciones | `src/features/mcp/ApprovalDialog.tsx` | Diálogo de permiso + recordar decisión |
| Ajustes | `SettingsDialog` → sección "Asistentes de IA" | Activar, permisos por servidor, token, ver configuración |
| Actividad | `src/components/McpActivity/` | Lista de acciones del asistente con resultado |

Configuración en el cliente (ejemplo con Claude Code), que la app mostraría para copiar:
```bash
claude mcp add terview -- terview-mcp
```

Requisito: la app debe estar abierta (las conexiones viven en ella). Si está cerrada, el puente
responde "Abre TerView para usar tus servidores".

---

## 5. Exportar servidores a `~/.ssh/config`

### Para qué
Que los servidores guardados en TerView funcionen también con `ssh web-prod` en cualquier terminal,
con `scp`/`rsync`, con VS Code Remote-SSH y con asistentes como Claude Code — sin configurarlos dos veces.

### Cómo
- Botón **"Exportar a ~/.ssh/config"** (menú de la barra lateral y en Ajustes) y opción
  **"Mantener sincronizado"** (se actualiza al guardar/borrar servidores).
- TerView escribe **solo dentro de un bloque marcado**, sin tocar el resto del archivo:
  ```
  # >>> TerView (no editar a mano) >>>
  Host web-prod
      HostName 192.168.1.10
      Port 22
      User deploy
      IdentityFile ~/.ssh/id_ed25519
  # <<< TerView <<<
  ```
- Alias = nombre del servidor convertido a formato seguro (`Cliente X / web` → `cliente-x-web`), sin duplicados.
- Servidores con contraseña: se exportan igual (ssh la pedirá); se sugiere pasar a llave.
- **Importar** desde `~/.ssh/config`: leer los `Host` existentes y ofrecer agregarlos a TerView.
- Copia de seguridad `~/.ssh/config.bak-terview` antes de la primera escritura; permisos 0600.

Archivos: `src-tauri/src/storage/ssh_config.rs` (leer/escribir bloque), comandos
`profiles_export_ssh_config` / `profiles_import_ssh_config`, botón en `Sidebar` y opción en `SettingsDialog`.

---

## 4. Otros pendientes detectados

| Tema | Estado |
|------|--------|
| 2FA / códigos OTP | ✅ Hecho: diálogo "Código de verificación", varias rondas, llave + código. ⚠️ Sin probar contra un servidor 2FA real. Las sesiones con 2FA no se reconectan solas (el código es de un solo uso). |
| Agente SSH | Implementado, ⚠️ sin probar con un agente real. |
| Conflictos al subir | ✅ Sobrescribir / Omitir / Solo si es más nuevo / **Preguntar** archivo por archivo (v0.4.0). |
| Simultáneas por servidor | ✅ Hecho (el límite cuenta por servidor). |
| Symlinks en carpetas | ✅ Se copian como enlaces en ambos sentidos. |
| Buscar en la terminal | ✅ Ctrl+Shift+F. |
| Atajos en la terminal | ✅ Documentados en la bienvenida. |
| Fuente del editor | ✅ Ajuste propio. |
| Duplicar servidor | ✅ Copia también la contraseña guardada. |
| Logo e ícono | ✅ `docs/marca/`, ícono de la app generado. |
| Instaladores | ✅ `.rpm`, `.deb`, `.AppImage`, `.msi`, `-setup.exe` con GitHub Actions (v0.3.0). ⏳ Falta firmar (SmartScreen avisa). |
| Arrastrar al sistema | ✅ Implementado (v0.4.0), ⚠️ **sin probar con un arrastre real** en ningún sistema. Arrastrar filas del explorador remoto al escritorio o a una carpeta: primero se descargan a `<caché>/arrastre/<id>/` con el motor de transferencias (se ven en el panel) y luego se arrastran los archivos locales. Si ya estaban descargados y no cambiaron, el arrastre es inmediato; si no, se muestra «Preparando para arrastrar…» abajo y, si el botón sigue apretado al terminar, arrastra en ese momento (si no, avisa «Listo para arrastrar»). Más de 1 GB pide confirmación. La caché se limpia al abrir la app (lo de más de un día). Módulo `dragout`. **Linux** (X11 y Wayland): GTK3 propio con `text/uri-list` (URIs codificadas por GLib: espacios y acentos ok). `tauri-plugin-drag`/`drag` 2.1.1 sigue con los fallos en GTK (URIs sin codificar, botón mal pasado, entrega de datos desconectada antes de que el destino la pida), por eso no se usa en Linux. Sin XDS (solo X11 y pocos gestores). **Windows**: objeto de datos del Shell + `SHDoDragDrop` (compila con `cargo-zigbuild clippy`; ⚠️ sin probar). **macOS**: crate `drag` ⚠️ sin compilar ni probar (lo compila la CI de publicación). Pendiente si hiciera falta: archivos virtuales (`CFSTR_FILECONTENTS` en Windows, `NSFilePromiseProvider` en macOS) para no copiar dos veces los archivos grandes; quedarían fuera del motor de transferencias. Alternativas que siguen: «Descargar en…» y «Descargar y abrir carpeta». |
| Exportar "Mis comandos" a archivo | ✅ Exportar/importar a archivo con vista previa (v0.4.0). |
| Alias de `~/.ssh/config` | ✅ Detecta choques (Host, patrones, Include, Match) y propone alias (v0.4.0). |
| Cancelar "ver resultado" | ✅ «Cancelar» y el tiempo límite detienen también el proceso en el servidor: señal TERM por el canal y, si no basta, `kill` al grupo del comando desde otro canal (TERM y luego KILL). Comando Tauri `exec_cancel(execId)` (v0.4.0). Lo usan el panel de Comandos y «Ejecutar en varios servidores»: al cancelar (un servidor, «Cancelar todo» o al cerrar el panel) se detiene el comando tanto en sesiones de pestaña como en las propias; las propias se desconectan **después**, cuando el comando ya paró (como mucho 15 s). ⚠️ Sin probar contra servidores reales variados (la señal por el canal necesita OpenSSH 7.9 o más nuevo; si no, se usa `kill`). |
| Pruebas de la interfaz | ⏳ La interfaz se revisó con capturas en navegador; faltan pruebas automáticas dentro de la app real. |

---

## 6. Windows (y macOS)

El código ya es multiplataforma (Tauri + Rust): todo lo específico de Linux (permisos 0600, enlaces
simbólicos, agente por socket) tiene su alternativa en Windows. Llavero: Administrador de credenciales
de Windows. Ventana: WebView2 (ya viene en Windows 10/11). `~/.ssh` = `C:\Users\<usuario>\.ssh`.

Falta:
| Tema | Detalle |
|------|---------|
| Compilar para Windows | ✅ Hecho en v0.3.0 con GitHub Actions (`.github/workflows/release.yml`); la CI compila y prueba también en Windows. Chequeo local posible con `cargo-zigbuild check --target x86_64-pc-windows-gnu`. Antes: no se podía desde Fedora (una librería de cifrado necesita compilar C para Windows). Opciones: compilar en una PC con Windows (`npm run tauri build` → `.msi` / `.exe`) o **GitHub Actions** con `tauri-action` (Linux + Windows + macOS automáticamente en cada versión). |
| Agente SSH en Windows | ✅ Implementado en v0.3.0 (pipe de OpenSSH y Pageant), ⚠️ sin probar en un Windows real. Antes daba "no soportado". russh ya trae soporte: OpenSSH de Windows (`\\.\pipe\openssh-ssh-agent`) y Pageant (PuTTY). |
| Probar en Windows | Rutas con `\`, arrastrar desde el Explorador de Windows, tema del sistema. |
| Firmar el instalador | Sin firma, Windows SmartScreen muestra un aviso al instalar. |

---

## 7. Ideas recomendadas (siguientes funciones)

Ordenadas por utilidad para el día a día:

| # | Función | Para qué |
|---|---------|----------|
| 1 | **Túneles (port forwarding)** `-L` / `-R` / SOCKS | Abrir en tu PC una base de datos o panel web del servidor (`localhost:5432` → servidor) sin exponer puertos. Panel con túneles guardados por servidor y un clic para activarlos. |
| 2 | **Servidor intermedio (jump host / bastión)** | Llegar a servidores internos pasando por otro (`ProxyJump`). Muy común en empresas. |
| 3 | **Ejecutar en varios servidores a la vez** | Un comando de la biblioteca en todo un proyecto (p. ej. `podman ps` en 5 servidores) con resultados lado a lado. |
| 4 | **Monitoreo en vivo** | Gráficas de CPU, memoria, disco y red en tiempo real (amplía "Analizar servidor"), con alertas. |
| 5 | **Sincronizar carpeta** | Carpeta local ↔ remota: al guardar en tu PC se sube sola (desarrollo web). |
| 6 | **Sesiones persistentes con tmux** | La terminal sobrevive a cortes de red y a cerrar la app. ✅ Hecho (v0.4.0), detalle abajo. |
| 7 | **Comparar archivos** | Diferencias entre un archivo local y uno remoto, o entre dos servidores. |
| 8 | **Actualizaciones automáticas** | La app se actualiza sola (`tauri-plugin-updater`) + instaladores para Windows/macOS con GitHub Actions. |
| 9 | **Respaldo/sincronización de servidores** | Exportar todo cifrado con contraseña o sincronizar entre tus equipos. |
| 10 | **Historial por servidor** | Comandos usados y grabación opcional de sesiones (auditoría). |

### 7.6 Terminales persistentes con tmux — ✅ Hecho (v0.4.0)

- **Ajuste**: Ajustes → Terminal → «Terminales persistentes (tmux)»: Automático (por defecto), Siempre o
  Nunca. Cada servidor puede cambiarlo en su ficha («Como en Ajustes» hereda el general).
  - Por qué Automático: es lo que hace útil la reconexión automática, y en servidores sin tmux no cambia
    nada ni avisa. Cambia el comportamiento para quien ya usaba TerView: si el servidor tiene tmux, lo
    que corre en la terminal **sigue vivo al cerrar la app** (antes moría). Por eso las sesiones sueltas
    se ven con un contador en la barra de terminales y se pueden cerrar desde la lista.
- **Cómo funciona**: cada terminal tiene una sesión tmux con nombre propio (`terview-<8 hex>`), guardada en
  el estado de la sub-pestaña. El motor (`src-tauri/src/terminal/tmux.rs`) busca tmux una vez por
  conexión y abre la terminal con `exec` + PTY: `tmux -L terview new-session -A -s <nombre>`. Al
  reconectar (automático o botón «Reconectar», que abre pestaña nueva) se engancha a la misma sesión.
  - Servidor tmux propio (`-L terview`, `-f /dev/null`): no lee ni toca `~/.tmux.conf` ni las sesiones
    tmux del usuario. A mano: `tmux -L terview attach -t terview-…` (lo copia el menú de la pestaña).
  - Configuración por línea de comandos al arrancar ese servidor: sin barra de estado, **sin tecla
    prefijo** (Ctrl+B llega a los programas), `escape-time 10`, historial de 50 000 líneas,
    `default-terminal` tmux-256color (o screen-256color si el servidor no lo conoce), `-u -2`, color real,
    `aggressive-resize` y `window-size latest` (3.1+), hipervínculos (3.4+). Opciones según la versión.
  - **Historial y búsqueda**: tmux no usa la pantalla alternativa hacia xterm.js
    (`terminal-overrides …smcup@:rmcup@`). Así la rueda, el historial, Ctrl+Shift+F, la selección,
    copiar/pegar y los enlaces siguen funcionando con xterm.js, como sin tmux. Contras: en `less`/`man`
    la rueda mueve el historial de xterm.js en vez de la página (usa las flechas o RePág), y lo que salió
    mientras no había conexión y ya no cabe en pantalla queda solo en el historial de tmux. Al reabrir una
    sesión en una terminal nueva (lista o «Reconectar») se vuelcan antes sus últimas 10 000 líneas.
- **Cerrar**: la ✕ de la sub-pestaña o cerrar la pestaña de la conexión **terminan** la sesión tmux (como
  una shell normal). Menú de la sub-pestaña → «Desacoplar» la deja corriendo. Si la conexión se corta,
  se cierra la app o se cierra sin conexión, la sesión **se conserva**.
- **Sesiones sueltas**: botón de capas junto al «+» de las terminales (con contador si hay sueltas que
  nadie mira): lista con programa, carpeta y actividad, para **Abrir** en una terminal nueva o
  **Cerrar** (una o todas las sueltas).
- **Sin tmux**: en Automático, terminal normal sin avisos (se recuerda 20 s por conexión para no
  comprobarlo en cada terminal). En Siempre, avisa una vez por servidor con el comando de instalación
  según la distro (detección de privilegios) y ofrece escribirlo en la terminal.
- Indicador ∞ en la sub-pestaña cuando la terminal es persistente.
- Pruebas: `cargo test --lib terminal::tmux` (scripts, versiones, `tmux ls`) y, con el contenedor
  (`podman exec terview-sshd apk add tmux`), `cargo test --lib terminal::tmux -- --ignored`: crea la
  sesión, corta la conexión con un `sleep` en marcha, se engancha desde otra conexión y comprueba que el
  proceso y la shell siguen, el historial volcado y la configuración propia; y dos terminales por conexión.
- ⚠️ **Sin probar**: en la app real con un corte de red de verdad (wifi/VPN), servidores con tmux viejo
  (1.8–2.x), macOS (tmux de Homebrew) y FreeBSD, otros shells de login (fish, tcsh), programas con ratón
  (vim/htop) dentro de tmux, y el dibujado al cambiar el tamaño con mucho historial.

### 7.7 PIN, bóveda cifrada y bloqueo — ✅ Hecho (v0.4.0)

- **Bóveda** (`src-tauri/src/storage/vault.rs`): `vault.json` en la carpeta de configuración (atómico,
  0600) con un mapa id → secreto (servidores + `github-token`) cifrado con AES-256-GCM. Sobre JSON con
  cabecera autenticada (AAD) compartido con la copia en Gist: la parte común salió de `github/crypto.rs`
  a `storage/cipher.rs` (mismo formato de antes, los Gist viejos se siguen abriendo).
  - Llave = Argon2id(PIN, sal) con la **llave del equipo** como «secreto» K de Argon2 (32 bytes al azar
    en el llavero, usuario `vault-device-key`). Sin ella no se abre ni con el PIN correcto.
  - Argon2id calibrado al crear o cambiar el PIN para unos 0,75 s: 64 MiB (128 MiB si el equipo es
    rápido) y 3–20 pasadas; los parámetros van en el archivo. En este PC: 128 MiB × 9 pasadas ≈ 0,63 s.
    `argon2` y `blake2` se compilan optimizados también en desarrollo (`Cargo.toml`).
  - Llave y secretos descifrados solo en memoria mientras está desbloqueada (`Zeroizing`).
  - Fallos: 5 libres; luego 30 s, el doble cada vez, máx. 15 min, en `vault-attempts.json`. Nunca se
    borra nada por fallar. Borrar ese archivo a mano quita la espera (quien puede hacerlo ya tiene acceso
    a tu usuario).
- **API sin cambios** (`storage/secrets.rs`): `get/set/delete_secret` y las del token van a la bóveda si
  existe (error `Locked` si está bloqueada) o al llavero si no.
- **Mover**: activar lee todo del llavero → escribe y comprueba la bóveda → borra del llavero. Desactivar
  (pide PIN) escribe en el llavero, comprueba, y solo entonces borra `vault.json` y la llave del equipo.
  Cambiar el PIN vuelve a cifrar con sal nueva (misma llave del equipo). «Olvidé mi PIN» (escribir
  BORRAR) borra bóveda y llave del equipo.
- **Bloqueo** (`storage/lock.rs`): estado en Rust, evento `vault://state` a todas las ventanas. Las
  ventanas avisan de la actividad (como mucho cada 15 s) y un vigilante bloquea tras `lockMinutes` (hora
  del sistema: cuenta el tiempo suspendido). Al bloquear: se olvidan el token de GitHub en caché y las
  contraseñas de sudo; la interfaz queda montada pero inerte y tapada. Atajo `Ctrl+Shift+L` (⌘⇧L).
- **Reconexión**: con la bóveda activa, la sesión no guarda en memoria la contraseña o frase guardada;
  se lee en cada intento. Si está bloqueado, el intento espera (aviso `waitingUnlock`, la pestaña dice
  «Esperando el desbloqueo…») sin gastar intentos. Las de llave sin frase reconectan normal.
- Interfaz: `src/features/lock/` (pantalla de bloqueo, «Olvidé mi PIN», primera vez con «Ahora no»,
  medidor de fortaleza) y Ajustes → Seguridad (`components/Settings/SecuritySection.tsx`).
- Pruebas: `cargo test --lib storage::vault` (ida y vuelta, PIN incorrecto, cambiar PIN, archivo dañado o
  cabecera alterada, bloqueada → `Locked`, 0600, esperas guardadas en disco, llave del equipo ausente u
  otra, «Olvidé mi PIN», mover con un llavero simulado) y `cargo test --lib ssh::reconnect` (espera al
  desbloqueo). Con el llavero real (servicio `terview-test`):
  `cargo test --lib storage -- --ignored --test-threads=1`.
- ⚠️ **Sin probar en la app real**: la pantalla de bloqueo y la de primera vez a mano; ventanas de editor
  aparte bloqueadas; el bloqueo por inactividad y tras suspender el equipo; una reconexión real esperando
  al desbloqueo; Windows (Credential Manager) y macOS (Keychain, puede pedir permiso para la llave del
  equipo); Linux sin llavero (el PIN no se puede activar: necesita el llavero para la llave del equipo);
  el atajo `Ctrl+Shift+L` dentro del editor (tapa «seleccionar todas las coincidencias» de Monaco).
- Límites conocidos: los secretos que se devuelven a otros módulos son `String` normales (no se pisan
  al soltarlos); serde puede dejar copias temporales al descifrar. Mientras está desbloqueado, un
  programa malicioso con tu usuario puede leer la memoria o ver el PIN al escribirlo.

---

## 8. Plan elegido para la siguiente ronda (11/11/2026)

| Orden | Función | Origen |
|-------|---------|--------|
| 1 | [Optimización / rendimiento](#81-optimización--rendimiento) | Se siente lenta |
| 2 | [Gestión del servidor: usuarios y grupos](#82-gestión-del-servidor-usuarios-y-grupos) | ✅ Hecho (v0.4.0) |
| 3 | [Monitoreo en vivo](#83-monitoreo-en-vivo) | ✅ Hecho (v0.4.0) |
| 4 | [Túneles (port forwarding)](#84-túneles-port-forwarding) | ✅ Hecho (v0.4.0) |
| 5 | [Versiones y actualizaciones](#85-versiones-y-actualizaciones) | ✅ Hecho (v0.4.0) |
| 6 | [Ejecutar en varios servidores a la vez](#86-ejecutar-en-varios-servidores-a-la-vez) | ✅ Hecho (v0.4.0) |
| 7 | [GitHub: Actions + conectar cuenta](#9-github) | ✅ Hecho (v0.3.0 Actions, v0.4.0 cuenta) |
| 8 | [Contenedores (Podman / Docker)](#87-administrador-de-contenedores-podman--docker--pedido-11112026) | ✅ Hecho (v0.4.0) |
| 9 | [Puertos y servicios web](#88-puertos-y-servicios-web--pedido-11112026) | ✅ Hecho (v0.4.0) |
| — | [Corrección: doble clic en un servidor](#corrección--doble-clic-en-un-servidor-de-la-barra-lateral) | ✅ Hecho (v0.4.0) |

### 8.1 Optimización / rendimiento

**Hecho en v0.3.0:** carga bajo demanda (paquete inicial 914 → 362 KB), terminal WebGL, arreglo automático
de WebKitGTK con NVIDIA, menos redibujados, `color-mix` precalculados. Panel de diagnóstico ✅ (v0.4.0). **Falta:** medir en la app real.

**Primero medir, luego cambiar.** Hay que saber *dónde* se siente lenta:
al abrir la app, al conectar, al navegar carpetas, al escribir en la terminal, al cambiar de pestaña,
al mover divisores o durante transferencias.

Causas probables (por revisar en este orden):
| # | Causa posible | Cómo verificar | Arreglo |
|---|---------------|----------------|---------|
| 1 | **Modo desarrollo** (`npm run tauri dev`): Rust sin optimizar + Vite en vivo | Comparar con el instalador `.rpm` (compilado optimizado) | Usar la versión instalada para el día a día |
| 2 | **WebKitGTK en Linux/Wayland** (motor de la ventana): problemas conocidos de dibujado con ciertas tarjetas gráficas | Probar con `WEBKIT_DISABLE_DMABUF_RENDERER=1` y con `WEBKIT_DISABLE_COMPOSITING_MODE=1` | Detectarlo y aplicar la variable automáticamente al iniciar si mejora |
| 3 | **Carga inicial pesada**: el paquete principal pesa ~780 KB y Monaco ~4 MB | Medir tiempo hasta la primera pantalla | Cargar Sidebar/Comandos/Transferencias bajo demanda; precargar Monaco en segundo plano |
| 4 | **Re-dibujados de React** innecesarios (estado global que redibuja toda la ventana: transferencias cada 200 ms, pestañas, ajustes) | React Profiler / contar renders | Selectores más finos en zustand, `memo`, separar el estado de progreso |
| 5 | **Listas largas** (explorador con miles de archivos, cola con miles de trabajos, catálogo de comandos) | Probar carpeta con 5.000 archivos | Virtualización en todas las listas |
| 6 | **Efectos visuales caros**: sombras, `backdrop-filter`, animaciones, `color-mix` | Desactivarlos y comparar | Simplificar en Linux |
| 7 | **xterm.js** sin aceleración | Probar `@xterm/addon-webgl` | Usar el renderizador WebGL si está disponible |
| 8 | **Llamadas al motor en serie** (p. ej. abrir una carpeta hace varias peticiones seguidas) | Registro de tiempos por comando | Unir peticiones, caché de carpetas visitadas |

Entregable: un pequeño **panel de diagnóstico** (Ajustes → Avanzado) con tiempos de arranque, de
cada comando y FPS al mover paneles, para comparar antes/después.

### 8.2 Gestión del servidor: usuarios y grupos

Nueva pestaña **"Administración"** en cada conexión (para quien entra como root o con sudo):

**Usuarios**
- Lista de usuarios (`getent passwd`), separando personas (UID ≥ 1000) de cuentas del sistema:
  nombre, UID, grupos, shell, carpeta personal, último acceso (`lastlog`/`last`), bloqueado sí/no, con sudo sí/no.
- **Crear usuario**: nombre, nombre completo, contraseña (o generar una segura), shell, crear carpeta
  personal, grupos, dar acceso sudo (`wheel` en Fedora/RHEL, `sudo` en Debian/Ubuntu), añadir llave SSH.
- **Editar**: cambiar contraseña, shell, nombre completo, grupos (añadir/quitar), forzar cambio de
  contraseña en el próximo inicio (`chage -d 0`), fecha de caducidad.
- **Bloquear / desbloquear** (`usermod -L/-U`), **eliminar** (con opción de borrar su carpeta; confirmación fuerte).
- **Llaves SSH del usuario**: ver, añadir y quitar líneas de su `~/.ssh/authorized_keys` (con permisos correctos).
- Ver **quién está conectado ahora** (`who`) y cerrar su sesión.

**Grupos**
- Lista (`getent group`), miembros, crear, renombrar, eliminar, añadir/quitar miembros (`gpasswd -a/-d`).

**Cómo se ejecuta**
- Comandos según la distribución (Fedora/RHEL, Debian/Ubuntu, Alpine: `useradd` vs `adduser`).
- **sudo**: si no eres root, la app pide tu contraseña de sudo **una vez por sesión** (solo en memoria,
  se puede olvidar con un botón) y usa `sudo -S`. Nunca se guarda en disco.
- Antes de cada cambio se muestra el **comando exacto** que se ejecutará.
- Todo cambio queda en un **registro** visible ("Historial de administración").

Siguientes ampliaciones naturales del mismo panel: **servicios** (systemd: iniciar/parar/activar, ver
logs), **firewall** (puertos abiertos), **paquetes** (actualizar, instalar), **tareas programadas** (cron/timers).

### 8.3 Monitoreo en vivo
- Gráficas en tiempo real (cada 2–5 s) de CPU, memoria, disco, red y carga, por servidor.
- Lectura ligera desde `/proc` por un canal `exec` dedicado (sin instalar nada en el servidor).
- Procesos que más consumen (con botón para terminar), contenedores con su consumo.
- **Alertas** configurables (disco > 85 %, memoria > 90 %, servicio caído) con aviso en la app.
- Vista "Proyecto": tarjetas de todos los servidores del proyecto a la vez.

### 8.4 Túneles (port forwarding)
- **Local** (`-L`): `localhost:5432` en tu PC → `db:5432` desde el servidor.
- **Remoto** (`-R`): exponer un puerto de tu PC en el servidor.
- **SOCKS** (`-D`): navegar como si estuvieras en la red del servidor.
- Túneles **guardados por servidor**, activar/desactivar con un clic, arranque automático al conectar,
  estado (activo, conexiones, bytes), aviso si el puerto local está ocupado.
- russh ya soporta `direct-tcpip` y `tcpip-forward`.

### 8.5 Versiones y actualizaciones
- **Acerca de**: versión, novedades de cada versión (changelog) y enlaces.
- **Buscar actualizaciones** y actualizar desde la app (`tauri-plugin-updater` + versiones publicadas en GitHub Releases, firmadas).
- **GitHub Actions** para generar instaladores de Linux (`.rpm`, `.deb`, `.AppImage`), Windows (`.msi`/`.exe`) y macOS en cada versión.
- Ver también la **versión de lo instalado en el servidor** (Podman, Docker, nginx, kernel…) y si hay
  actualizaciones pendientes del sistema (ya se detecta en "Analizar servidor").

### 8.7 Administrador de contenedores (Podman / Docker) — pedido 11/11/2026
Pestaña **Contenedores** en cada conexión, todo visual (sin escribir comandos):
- Detecta Podman y/o Docker (y si hace falta sudo o es modo *rootless*).
- **Contenedores**: lista con estado, imagen, puertos, uso de CPU/memoria; iniciar, parar, reiniciar,
  pausar, eliminar; ver logs en vivo; abrir una terminal dentro (`exec -it`); inspeccionar.
- **Crear / levantar**: formulario (imagen, nombre, puertos, volúmenes, variables, reinicio) y
  **Compose** (`compose up -d` / `down` / `pull` en una carpeta con `compose.yml`).
- **Imágenes**: listar, descargar (`pull`), eliminar, **limpiar** las que no se usan (`image prune`)
  mostrando antes cuánto espacio se libera.
- **Volúmenes y redes**: listar, crear, eliminar, limpiar.
- **Limpieza general** (`system prune`) con resumen de lo que se borrará y confirmación.
- Siempre muestra el comando exacto antes de las acciones que borran.

### 8.8 Puertos y servicios web — pedido 11/11/2026
✅ **Hecho (v0.4.0).** Archivos: `src/components/Admin/PortsTab.tsx`, `WebTab.tsx`,
`src/features/admin/ports.ts`, `web.ts` y `src/features/tunnels/openLocal.ts`.
Diferencias con lo pedido: en lugar de «ver el proceso en el Monitor» hay «Copiar PID». «Abrir túnel» a un
puerto menor de 1024 escucha en tu PC en un puerto libre que elige el motor (también en Contenedores).

En **Administración**, dos sub-pestañas nuevas:
- **Puertos**: todos los puertos en escucha (TCP/UDP, IPv4/IPv6) con proceso, PID, usuario y servicio
  systemd/contenedor. Con root/sudo se ven los de **todos los usuarios**; sin privilegios, solo los propios
  (y se avisa). Filtros: por usuario, por proceso, solo públicos (0.0.0.0/::) vs solo locales.
  Acciones: abrir un túnel a tu PC, copiar dirección, ver el proceso en el Monitor.
- **Sitios web**: detecta **nginx** y **Caddy**; lista cada sitio (dominios, puertos, HTTPS/certificado,
  raíz o `proxy_pass`/`reverse_proxy` hacia qué puerto), enlaza el puerto de destino con la lista de
  Puertos, abre el archivo de configuración en el editor, comprueba la configuración (`nginx -t`,
  `caddy validate`) y recarga el servicio con confirmación.

### Corrección — doble clic en un servidor de la barra lateral
✅ **Hecho (v0.4.0).** El doble clic (y Enter) **va a la pestaña ya abierta** de ese servidor y la
reconecta si estaba cerrada; si no hay pestaña, conecta (`openOrFocusServer` en `src/features/connect.ts`,
usado por `openOrFocus` en `Sidebar.tsx`). Para abrir una conexión adicional al mismo servidor:
Ctrl+doble clic, clic central o «Abrir otra conexión» en el menú.

### 8.6 Ejecutar en varios servidores a la vez
- Elegir servidores (o un proyecto completo) y ejecutar un comando de la biblioteca en todos.
- Resultados lado a lado o en tabla, con estado por servidor (correcto / error / tiempo agotado).
- Confirmación reforzada para comandos peligrosos.

---

## 9. GitHub

Dos partes independientes: **(A)** usar GitHub para construir y publicar TerView, y
**(B)** conectar una cuenta de GitHub dentro de la app para trabajar con los servidores.

### 9A. El proyecto en GitHub (GitHub Actions)
1. **Subir el proyecto**: `git init`, primer commit, repositorio en GitHub (privado o público),
   `.gitignore` ya existe (excluye `node_modules`, `dist`, `src-tauri/target`).
2. **Integración continua** (en cada cambio): compilar, `cargo clippy`, `cargo test` (los tests sin
   servidor), `tsc` y `vite build`. Opcional: levantar el contenedor SSH de pruebas en el propio
   Actions (`services:` con `linuxserver/openssh-server`) para correr también los tests con servidor.
3. **Publicar versiones** (al crear una etiqueta `v0.3.0`): `tauri-apps/tauri-action` genera
   instaladores de **Linux** (`.rpm`, `.deb`, `.AppImage`), **Windows** (`.msi`, `.exe`) y **macOS**
   (`.dmg`), y los adjunta a un **GitHub Release** con las notas de la versión.
4. **Actualizaciones automáticas**: el `tauri-plugin-updater` de la app consulta ese Release
   (archivo `latest.json` firmado) → "Hay una versión nueva, ¿actualizar?" (ver 8.5).
5. **Firmas**: llave de firma del actualizador (secreto en GitHub), y opcional certificado de
   firma de código para Windows/macOS (evita avisos de seguridad al instalar).

Archivos: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `CHANGELOG.md`.

### 9B. Conectar tu cuenta de GitHub en la app
Inicio de sesión con **GitHub (OAuth "device flow")**: la app muestra un código, lo pegas en
github.com y listo; el token se guarda en el **llavero del sistema**, nunca en archivos.
Se puede desconectar cuando quieras. Permisos mínimos según lo que se use.

Qué permitiría:
| Función | Para qué |
|---------|----------|
| **Llaves SSH ↔ GitHub** | Ver tus llaves públicas de GitHub y **añadirlas a un servidor** (`authorized_keys`) con un clic; o subir a GitHub una llave de tu PC. Útil junto a "Administración → llaves SSH de usuarios". |
| **Clonar repositorios en el servidor** | Elegir un repo de tu cuenta y clonarlo en una carpeta del servidor (con *deploy key* de solo lectura creada automáticamente). |
| **Desplegar** | Botón "Actualizar desde GitHub" en un proyecto: `git pull` + comandos posteriores (p. ej. `podman compose up -d --build`) en uno o varios servidores. |
| **Ver GitHub Actions** | Estado de los workflows de tus repos (último despliegue correcto/fallido) y lanzar uno manualmente. |
| **Sincronizar configuración** | Guardar servidores, proyectos y "Mis comandos" en un **Gist privado cifrado** para tenerlos en otra PC (las contraseñas **no** se sincronizan). |
| **Compartir comandos** | Publicar/importar colecciones de comandos desde un repo o gist (útil para equipos). |

Orden sugerido: 9A primero (da los instaladores de Windows/macOS y las actualizaciones), luego 9B
empezando por **llaves SSH** y **sincronizar configuración**.
