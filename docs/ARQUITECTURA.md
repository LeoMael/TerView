# TerView — Arquitectura general

Cliente SSH/SFTP de escritorio: conectarse a servidores, navegar carpetas como en un
explorador, subir/descargar archivos de forma masiva, terminal integrada, editor y
múltiples pestañas.

**Tecnología:** Tauri 2 + Rust (motor) · React + TypeScript (interfaz)

---

## Diagramas (versión visual)

Las imágenes están en `docs/arquitectura/` (PNG para ver, SVG editable):

| # | Diagrama | Qué explica |
|---|----------|-------------|
| 1 | ![](arquitectura/01-vista-general.png) | Las dos mitades de la app y el servidor |
| 2 | ![](arquitectura/02-conexion-y-canales.png) | Una conexión SSH con varios canales en paralelo |
| 3 | ![](arquitectura/03-subida-masiva.png) | Cómo se sube una carpeta con miles de archivos |
| 4 | ![](arquitectura/04-ventana.png) | Cómo se ve la ventana y qué se puede ajustar |
| 5 | ![](arquitectura/05-estructura-codigo.png) | Carpetas del código y cómo se conectan |
| 6 | ![](arquitectura/06-flujo-conexion.png) | Qué pasa, paso a paso, al conectarte |
| 7 | ![](arquitectura/07-biblioteca-comandos.png) | Biblioteca de comandos (Podman, análisis…) |
| 8 | ![](arquitectura/08-servidor-mcp.png) | **Opcional (en pausa):** servidor MCP para asistentes de IA |

Lo que falta y el plan detallado: **[PENDIENTES.md](PENDIENTES.md)**.
Todos los comandos que traerá la biblioteca: **[comandos/CATALOGO.md](comandos/CATALOGO.md)**.

---

## 1. La idea en una imagen

La app tiene **dos mitades** que viven en el mismo programa:

```
┌──────────────────────────────────────────────────────────────────────┐
│                         APP TERVIEW (una ventana)                    │
│                                                                      │
│  ┌──────────────────────────────┐      ┌──────────────────────────┐  │
│  │   INTERFAZ (lo que ves)      │      │   MOTOR (lo que trabaja) │  │
│  │   React + TypeScript         │      │   Rust                   │  │
│  │                              │ IPC  │                          │  │
│  │  • Lista de servidores       │◄────►│  • Conexiones SSH        │  │
│  │  • Pestañas                  │      │  • SFTP (archivos)       │  │
│  │  • Explorador de archivos    │      │  • Terminal (PTY)        │  │
│  │  • Terminal (xterm.js)       │      │  • Cola de transferencias│  │
│  │  • Editor (Monaco)           │      │  • Contraseñas seguras   │  │
│  │  • Cola de transferencias    │      │  • Guardar configuración │  │
│  └──────────────────────────────┘      └────────────┬─────────────┘  │
│                                                     │                │
└─────────────────────────────────────────────────────┼────────────────┘
                                                      │ SSH (puerto 22)
                                                      │ cifrado
                                          ┌───────────▼───────────┐
                                          │  Tu servidor           │
                                          │  user@x.x.x.x          │
                                          └───────────────────────┘
```

- **La interfaz nunca habla con el servidor.** Solo pinta pantallas y le pide cosas al motor.
- **El motor (Rust) hace todo el trabajo real:** conectar, leer carpetas, transferir, etc.
- Se comunican por **IPC** (mensajes internos de Tauri), muy rápido porque todo está en tu PC.

¿Por qué así? Porque Rust es rápido y seguro para red y archivos, y React es ideal para
interfaces bonitas. La ventana usa el motor web del sistema (WebKit en Linux), por eso la
app pesa ~10 MB y no ~150 MB como Electron.

---

## 2. Cómo se comunican las dos mitades

Hay dos tipos de mensajes:

### a) Comandos (pregunta → respuesta)
La interfaz pide algo y espera la respuesta. Ejemplo: listar una carpeta.

```
Interfaz:  invoke("sftp_list_dir", { sessionId, path: "/var/www" })
                │
                ▼
Motor:     fn sftp_list_dir(...)  ──► pregunta al servidor por SFTP
                │
                ▼
Interfaz:  recibe [ {name:"index.html", size:1200, isDir:false}, ... ]
           y pinta los íconos de archivos y carpetas
```

### b) Flujos (datos continuos)
Para cosas que no paran: lo que escribe la terminal o el progreso de una subida.

```
Motor ──(canal)──► "bytes de la terminal"  ──► xterm.js los dibuja
Motor ──(canal)──► "progreso: 45% de foto.jpg" ──► barra de progreso
```

---

## 3. Una conexión, muchos canales

Cuando te conectas a un servidor se abre **una sola conexión SSH**, y dentro de ella se
abren varios **canales** independientes (SSH lo permite de forma nativa):

```
              Conexión SSH a 192.168.1.10  (una sola autenticación)
  ┌────────────────────────────────────────────────────────────────┐
  │  Canal 1: Terminal (shell con PTY)      ◄─► pestaña terminal    │
  │  Canal 2: Terminal extra                ◄─► otra terminal       │
  │  Canal 3: SFTP explorador               ◄─► navegar carpetas    │
  │  Canal 4..7: SFTP transferencias        ◄─► 4 subidas a la vez  │
  └────────────────────────────────────────────────────────────────┘
```

Ventajas: te autenticas una vez, puedes tener varias terminales y transferencias en
paralelo sin abrir conexiones nuevas, y si navegas mientras subes archivos no se bloquea.

---

## 4. Las piezas del motor (Rust)

```
src-tauri/src/
├── main.rs              Punto de entrada (arranca la app)
├── lib.rs               Registra todos los comandos y el estado global
├── error.rs             Errores comunes, traducidos a mensajes claros
│
├── ssh/
│   ├── session.rs       Abre/cierra la conexión SSH, guarda las sesiones activas
│   ├── auth.rs          Contraseña, llave privada (id_ed25519, id_rsa), ssh-agent
│   └── known_hosts.rs   Verifica la huella del servidor (evita suplantaciones)
│
├── terminal/
│   └── pty.rs           Abre una shell, envía teclas, recibe salida, redimensiona
│
├── sftp/
│   ├── browse.rs        Listar, crear carpeta, renombrar, borrar, permisos
│   └── files.rs         Leer/guardar archivos (para el editor)
│
├── transfer/
│   ├── queue.rs         Cola de trabajos (subir/bajar), prioridades, cancelar
│   ├── worker.rs        Trabajadores en paralelo (por defecto 4)
│   └── walker.rs        Recorre carpetas completas (subidas/bajadas recursivas)
│
└── storage/
    ├── profiles.rs      Servidores y proyectos guardados (JSON en ~/.config/terview)
    └── secrets.rs       Contraseñas en el llavero del sistema (nunca en texto plano)
```

### Librerías clave del motor
| Librería       | Para qué                                               |
|----------------|--------------------------------------------------------|
| `tauri`        | La ventana y la comunicación con la interfaz           |
| `tokio`        | Hacer muchas cosas a la vez sin bloquear (asíncrono)   |
| `russh`        | Cliente SSH escrito 100% en Rust                       |
| `russh-sftp`   | Protocolo SFTP (archivos) sobre russh                  |
| `keyring`      | Llavero del sistema (GNOME Keyring / KWallet, macOS, Windows) |
| `serde`        | Convertir datos Rust ⇄ JSON para la interfaz           |

---

## 5. Las piezas de la interfaz (React)

```
src/
├── main.tsx                 Arranca React
├── App.tsx                  Diseño general de la ventana
│
├── api/                     Única puerta hacia el motor (envuelve invoke/canales)
│   ├── ssh.ts
│   ├── sftp.ts
│   ├── terminal.ts
│   └── transfers.ts
│
├── stores/                  Estado de la app (zustand)
│   ├── profiles.ts          Servidores y proyectos
│   ├── tabs.ts              Pestañas abiertas
│   └── transfers.ts         Cola y progreso
│
└── components/
    ├── Sidebar/             Servidores y proyectos, botón "nueva conexión"
    ├── Tabs/                Barra de pestañas
    ├── FileExplorer/        Lista de archivos, ruta, arrastrar y soltar, menú clic derecho
    ├── Terminal/            xterm.js conectado al canal de la terminal
    ├── Editor/              Monaco (el editor de VS Code)
    ├── TransferPanel/       Cola con barras de progreso, pausar/cancelar
    └── dialogs/             Nueva conexión, confirmar huella del servidor, etc.
```

### Librerías clave de la interfaz
| Librería              | Para qué                                        |
|-----------------------|-------------------------------------------------|
| `react`               | Construir la interfaz por componentes           |
| `@xterm/xterm`        | La terminal (la misma que usa VS Code)          |
| `@monaco-editor/react`| Editor de código (el mismo de VS Code)          |
| `zustand`             | Estado global simple (pestañas, servidores…)    |
| `@tauri-apps/api`     | Hablar con el motor Rust                        |

---

## 6. Cómo se ve la ventana

```
┌────────────────────────────────────────────────────────────────────────┐
│ TerView                                                        _ □ ✕   │
├──────────────┬─────────────────────────────────────────────────────────┤
│ PROYECTOS    │ [ web-prod ✕ ] [ db-server ✕ ] [ + ]                    │
│ ▾ Cliente X  ├─────────────────────────────────────────────────────────┤
│   ● web-prod │ /var/www/app                          [⬆ Subir] [⬇ Bajar]│
│   ○ db-server│ ┌─────────────────────────────────────────────────────┐ │
│ ▸ Personal   │ │ 📁 public          —        10/11/2026              │ │
│              │ │ 📁 src             —        09/11/2026              │ │
│ SERVIDORES   │ │ 📄 index.html     1.2 KB    10/11/2026              │ │
│   ○ vps-1    │ │ 📄 .env           300 B     08/11/2026              │ │
│   ○ raspberry│ └─────────────────────────────────────────────────────┘ │
│              ├─────────────────────────────────────────────────────────┤
│ [+ Nuevo]    │ user@web-prod:/var/www/app$ ls -la                      │
│              │ total 24                                                │
│              │ drwxr-xr-x 4 user user 4096 nov 10 public               │
│              │ $ █                                                     │
├──────────────┴─────────────────────────────────────────────────────────┤
│ Transferencias: ⬆ fotos/ (128/400)  ████████░░░░ 32%  12 MB/s   [⏸][✕] │
└────────────────────────────────────────────────────────────────────────┘
```

- **Izquierda:** servidores y proyectos guardados. Doble clic = conectar en nueva pestaña.
- **Arriba:** pestañas; cada una es una conexión independiente.
- **Centro:** explorador de archivos (arrastra archivos/carpetas desde tu PC para subirlos).
- **Abajo del centro:** terminal de esa misma conexión (se puede dividir o tener varias).
- **Barra inferior:** cola de transferencias con progreso y velocidad.
- Doble clic en un archivo de texto → se abre en el **editor** en una pestaña interna.

### Tamaño de la ventana
- Se abre en 1280×800, centrada. Mínimo 900×600 para que nada se rompa.
- Se puede redimensionar arrastrando los bordes o maximizar.
- **Recuerda** tamaño, posición y si estaba maximizada al volver a abrir
  (plugin `tauri-plugin-window-state`).
- Los paneles internos (barra lateral, explorador, terminal) también se ajustan
  arrastrando los divisores, y su tamaño se guarda.
- Configuración base en `src-tauri/tauri.conf.json` → `app.windows`.

---

## 7. Recorridos paso a paso

### Conectarse
```
1. Clic en "web-prod"
2. Interfaz → invoke("ssh_connect", { profileId })
3. Motor lee el perfil (JSON) y la contraseña (llavero del sistema)
4. Motor abre TCP al puerto 22 y negocia cifrado
5. Motor compara la huella del servidor con ~/.ssh/known_hosts
      ├─ coincide → sigue
      ├─ es nueva → pregunta a la interfaz "¿confías en esta huella?"
      └─ cambió  → BLOQUEA y avisa (posible ataque)
6. Autenticación (llave / contraseña / agente)
7. Abre canal de terminal + canal SFTP
8. Devuelve sessionId → la interfaz abre la pestaña
```

### Subir una carpeta completa (masivo)
```
1. Arrastras la carpeta "fotos/" (2.000 archivos) al explorador
2. Interfaz → invoke("transfer_upload", { sessionId, localPaths, remoteDir })
3. walker.rs recorre la carpeta: crea la lista de 2.000 trabajos + carpetas a crear
4. Crea primero las carpetas en el servidor
5. 4 trabajadores toman archivos de la cola en paralelo
     cada uno: abre archivo local → escribe en bloques de 256 KB por SFTP
6. Cada ~200 ms el motor manda progreso por un canal
7. Si un archivo falla, se reintenta; si se corta la conexión, se reanuda
   desde el último byte enviado (compara tamaños)
8. Al terminar, el explorador se refresca solo
```

### Escribir en la terminal
```
Tecla "l" → xterm.js → invoke("term_write", "l") → canal SSH → servidor
Servidor responde "l" → canal SSH → motor → canal Tauri → xterm.js lo dibuja
```

### Editar un archivo remoto
```
1. Doble clic en config.php
2. Motor lo lee por SFTP → interfaz lo abre en Monaco
3. Ctrl+S → motor escribe a "config.php.terview-tmp" y luego renombra
   (si se corta a mitad, el archivo original no se daña)
```

---

## 8. Dónde se guarda cada cosa

| Qué                         | Dónde                                         |
|-----------------------------|-----------------------------------------------|
| Servidores y proyectos      | `~/.config/terview/profiles.json`             |
| Contraseñas / passphrases   | Llavero del sistema (GNOME Keyring/KWallet)   |
| Llaves SSH                  | Las tuyas de siempre: `~/.ssh/`               |
| Huellas de servidores       | `~/.ssh/known_hosts` (el mismo que usa `ssh`) |
| Preferencias (tema, etc.)   | `~/.config/terview/settings.json`             |

Ejemplo de `profiles.json` (sin contraseñas):
```json
{
  "projects": [
    { "id": "p1", "name": "Cliente X",
      "servers": ["s1", "s2"],
      "bookmarks": [{ "server": "s1", "path": "/var/www/app" }] }
  ],
  "servers": [
    { "id": "s1", "name": "web-prod", "host": "192.168.1.10", "port": 22,
      "user": "deploy", "auth": "key", "keyPath": "~/.ssh/id_ed25519" }
  ]
}
```

---

## 9. Seguridad

- **Contraseñas** solo en el llavero del sistema; nunca en archivos ni en la interfaz.
- **Verificación de huella** del servidor (igual que el comando `ssh`), evita ataques
  de intermediario.
- **Permisos de Tauri (capabilities):** la interfaz solo puede llamar a los comandos que
  definimos; no tiene acceso libre al disco ni a internet.
- **CSP** activa: la ventana no puede cargar scripts externos.
- El editor guarda de forma **atómica** (archivo temporal + renombrar).

---

## 10. Plan por fases

| Fase | Qué se construye                                                         |
|------|--------------------------------------------------------------------------|
| 0    | ✅ Preparativos: proyecto, librerías, ventana ajustable, diagramas        |
| 1    | ✅ Conectar por SSH (contraseña, llave, agente) + verificación de huella  |
| 2    | ✅ Terminal integrada en pestañas                                         |
| 3    | ✅ Explorador de archivos: navegar, crear, renombrar, permisos, borrar    |
| 4    | ✅ Transferencias masivas: cola, paralelo, arrastrar y soltar, reanudar   |
| 5    | ✅ Servidores y proyectos guardados + llavero del sistema                 |
| 6    | ✅ Editor de archivos remotos                                             |
| 7    | ✅ Temas claro/oscuro, atajos, ajustes, logo, instalador .rpm · ⏳ .deb / .AppImage |
| 8    | ✅ Reconexión rápida y automática ([detalle](PENDIENTES.md#2-reconexión-rápida-y-automática)) |
| 9    | ✅ Biblioteca de comandos: Podman, análisis del sistema, mis comandos ([detalle](PENDIENTES.md#1-biblioteca-de-comandos)) |
| 9b   | ✅ Exportar/importar servidores con `~/.ssh/config` ([detalle](PENDIENTES.md#5-exportar-servidores-a-sshconfig)) |
| 10   | ⏸️ Opcional: servidor MCP para asistentes de IA ([detalle](PENDIENTES.md#3-servidor-mcp-conectar-asistentes-de-ia)) |
| 11   | ⏳ Optimización y rendimiento ([detalle](PENDIENTES.md#81-optimización--rendimiento)) |
| 12   | ⏳ Administración: usuarios y grupos (luego servicios, firewall, paquetes) ([detalle](PENDIENTES.md#82-gestión-del-servidor-usuarios-y-grupos)) |
| 13   | ⏳ Monitoreo en vivo con alertas ([detalle](PENDIENTES.md#83-monitoreo-en-vivo)) |
| 14   | ⏳ Túneles: local, remoto y SOCKS ([detalle](PENDIENTES.md#84-túneles-port-forwarding)) |
| 15   | ⏳ Versiones, actualizaciones automáticas e instaladores para Windows/macOS ([detalle](PENDIENTES.md#85-versiones-y-actualizaciones)) |
| 16   | ⏳ Opcional: ejecutar en varios servidores a la vez ([detalle](PENDIENTES.md#86-ejecutar-en-varios-servidores-a-la-vez)) |
| 17   | ⏳ GitHub: Actions (instaladores y versiones) + conectar cuenta (llaves SSH, despliegues, sincronizar) ([detalle](PENDIENTES.md#9-github)) |

✅ hecho · ⏳ pendiente · ⏸️ en pausa (opcional)

---

## 11. Comandos útiles

```bash
npm run tauri dev      # Abrir la app en modo desarrollo (se recarga sola)
npm run tauri build    # Generar instaladores en src-tauri/target/release/bundle/
```
