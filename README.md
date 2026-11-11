<p align="center">
  <img src="docs/marca/isotipo-1024.png" width="104" alt="Logo de TerView" />
</p>

<h1 align="center">TerView</h1>

<p align="center">
  <strong>Cliente SSH/SFTP de escritorio.</strong><br/>
  Conéctate a tus servidores, navega carpetas como en un explorador, sube y baja miles de archivos,<br/>
  usa la terminal y aplica comandos listos (Podman, sistema, red…) — todo en una sola ventana.
</p>

<p align="center">
  <img alt="Versión" src="https://img.shields.io/badge/versión-0.2.1-38bdf8" />
  <img alt="Linux" src="https://img.shields.io/badge/Linux-rpm%20·%20deb%20·%20AppImage-22c55e" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-próximamente-94a3b8" />
  <img alt="macOS" src="https://img.shields.io/badge/macOS-próximamente-94a3b8" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-f97316" />
</p>

<p align="center">
  <a href="#-instalación">Instalación</a> ·
  <a href="#-primeros-pasos">Primeros pasos</a> ·
  <a href="#️-atajos-de-teclado">Atajos</a> ·
  <a href="#-solución-de-problemas">Problemas</a> ·
  <a href="#-desarrollo">Desarrollo</a> ·
  <a href="docs/ARQUITECTURA.md">Arquitectura</a>
</p>

![Ventana de TerView](docs/arquitectura/04-ventana.png)

---

## ✨ Funciones

| | |
|---|---|
| 🔐 **Conexiones SSH seguras** | Contraseña, llave SSH o agente · verificación de huella del servidor (`known_hosts`) · códigos 2FA · contraseñas en el llavero del sistema |
| 🔄 **Reconexión automática** | Detecta caídas (~30 s) y reintenta en la misma pestaña; terminales, explorador y transferencias continúan solos |
| 🖥️ **Terminal integrada** | Varias terminales por conexión, colores, buscar (`Ctrl+Shift+F`), copiar/pegar, enlaces clicables |
| 📁 **Explorador de archivos** | Navegar, crear, renombrar, permisos, borrar · **arrastrar y soltar** desde tu PC · miles de archivos sin trabarse |
| ⚡ **Transferencias masivas** | Carpetas completas, varios archivos a la vez, pausar/reanudar/cancelar, continúa desde el último byte si se corta |
| ✏️ **Editor remoto** | Edita archivos del servidor con Monaco (el editor de VS Code); guardado seguro |
| 🧰 **Biblioteca de comandos** | Podman, Docker, sistema, red, servicios, logs, paquetes… con variables sugeridas desde el servidor · **Analizar servidor** · **Mis comandos** · paleta `Ctrl+Shift+P` |
| 🗂️ **Servidores y proyectos** | Guarda servidores, agrúpalos en proyectos, carpetas favoritas · exportar/importar `~/.ssh/config` |
| 🎨 **A tu gusto** | Tema oscuro/claro, paneles ajustables, la ventana recuerda su tamaño |

<details>
<summary><strong>Ver más diagramas</strong></summary>

| Biblioteca de comandos | Una conexión, muchos canales |
|---|---|
| ![Comandos](docs/arquitectura/07-biblioteca-comandos.png) | ![Canales](docs/arquitectura/02-conexion-y-canales.png) |

</details>

---

## 📦 Instalación

Descarga el instalador de tu sistema desde la página de
**[Releases](https://github.com/LeoMael/TerView/releases)** (versión más reciente).

| Sistema | Archivo | Estado |
|---------|---------|--------|
| Fedora · RHEL · Rocky · Alma · openSUSE | `TerView-0.2.1-1.x86_64.rpm` | ✅ Disponible |
| Debian · Ubuntu · Linux Mint · Pop!_OS | `TerView_0.2.1_amd64.deb` | ✅ Disponible |
| Cualquier Linux (sin instalar) | `TerView_0.2.1_amd64.AppImage` | ✅ Disponible |
| Windows 10 / 11 | `TerView_0.2.1_x64_en-US.msi` · `TerView_0.2.1_x64-setup.exe` | 🔜 Próximamente |
| macOS (Intel y Apple Silicon) | `TerView_0.2.1_universal.dmg` | 🔜 Próximamente |

> Los instaladores de Windows y macOS se generarán automáticamente con GitHub Actions
> (ver [PENDIENTES.md](docs/PENDIENTES.md#9-github)). Mientras tanto se pueden
> [compilar desde el código](#-desarrollo).

### 🐧 Fedora / RHEL / openSUSE (`.rpm`)

```bash
sudo dnf install ./TerView-0.2.1-1.x86_64.rpm        # Fedora, RHEL, Rocky, Alma
sudo zypper install ./TerView-0.2.1-1.x86_64.rpm     # openSUSE
```
`dnf` instala también lo que haga falta (WebKitGTK). Ábrela desde el menú de aplicaciones
buscando **TerView**, o desde la terminal con `terview`.

Desinstalar: `sudo dnf remove ter-view`

### 🐧 Debian / Ubuntu / Mint (`.deb`)

```bash
sudo apt install ./TerView_0.2.1_amd64.deb
```
(Usa `./` delante del nombre para que `apt` instale el archivo local y sus dependencias.)

Desinstalar: `sudo apt remove ter-view`

### 🐧 Cualquier Linux (`.AppImage`)

No necesita instalación: un solo archivo (~120 MB, incluye sus librerías) que se ejecuta directamente.

```bash
chmod +x TerView_0.2.1_amd64.AppImage
./TerView_0.2.1_amd64.AppImage
```
Si da un error de **FUSE**: `sudo dnf install fuse-libs` (Fedora) o `sudo apt install libfuse2` (Ubuntu ≤ 22.04) / `libfuse2t64` (Ubuntu ≥ 24.04).

### 🪟 Windows 10 / 11 *(próximamente)*

1. Descarga `TerView_x.y.z_x64-setup.exe` (instalador normal) o `.msi` (para empresas / instalación silenciosa).
2. Ejecútalo y sigue los pasos. Necesita **Microsoft Edge WebView2**, que ya viene en Windows 10/11;
   si falta, el instalador lo descarga solo.
3. Si aparece **"Windows protegió su PC"** (SmartScreen): *Más información → Ejecutar de todas formas*
   (pasa con instaladores aún no firmados).

Las contraseñas se guardan en el **Administrador de credenciales de Windows** y las llaves se leen de
`C:\Users\<tú>\.ssh\`.

### 🍎 macOS *(próximamente)*

1. Abre el `.dmg` y arrastra **TerView** a *Aplicaciones*.
2. Si macOS dice que no puede abrirla (app sin notarizar): clic derecho sobre la app → **Abrir** → **Abrir**,
   o en la terminal: `xattr -dr com.apple.quarantine /Applications/TerView.app`.

---

## 🚀 Primeros pasos

1. Pulsa **+ Nuevo → Servidor** en la barra lateral (o escribe `usuario@host:puerto` en *conexión rápida*).
2. Elige cómo entrar: **contraseña**, **llave SSH** (`~/.ssh/id_ed25519`…) o **agente SSH**.
3. **Doble clic** en el servidor para conectar. La primera vez TerView te mostrará la **huella** del
   servidor para que confirmes que es el correcto.
4. Ya tienes **Archivos** (explorador), **Comandos** y la **terminal** abajo. Arrastra archivos o carpetas
   desde tu PC al explorador para subirlos.

¿Ya tienes servidores en `~/.ssh/config`? Usa **+ Nuevo → Importar de ~/.ssh/config**.

---

## ⌨️ Atajos de teclado

| Atajo | Acción |
|-------|--------|
| `Ctrl+Shift+P` | Paleta de comandos |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Siguiente / anterior conexión |
| `Ctrl+W` | Cerrar pestaña de conexión |
| `Ctrl+B` | Mostrar/ocultar barra lateral |
| ``Ctrl+` `` | Mostrar/ocultar terminal |
| `Ctrl+,` | Ajustes |
| **Terminal** | |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copiar / pegar |
| `Ctrl+Shift+F` | Buscar en la terminal |
| **Explorador** | |
| `Enter` · `Backspace` | Abrir · subir de carpeta |
| `Alt+←` / `Alt+→` | Atrás / adelante |
| `Ctrl+L` | Escribir la ruta |
| `Ctrl+F` | Filtrar por nombre |
| `F2` · `Supr` · `F5` | Renombrar · eliminar · actualizar |
| **Editor** | |
| `Ctrl+S` | Guardar en el servidor |

> Con el foco en la terminal, `Ctrl+W` y `Ctrl+B` van a la shell (borrar palabra, prefijo de tmux).

---

## 🔒 Seguridad y privacidad

- Las **contraseñas y frases de llaves** se guardan solo en el llavero del sistema
  (GNOME Keyring / KWallet, Administrador de credenciales de Windows, Llavero de macOS). Nunca en archivos.
- **Verificación de huella** igual que `ssh`: si la huella de un servidor cambia, TerView bloquea la conexión y avisa.
- La interfaz no tiene acceso libre a internet ni al disco: todo pasa por el motor en Rust, con permisos acotados.
- El editor guarda de forma **atómica** (archivo temporal + renombrar): un corte no deja el archivo a medias.

**Dónde se guarda cada cosa**

| Qué | Linux | Windows | macOS |
|-----|-------|---------|-------|
| Servidores, proyectos, ajustes, mis comandos | `~/.config/terview/` | `%APPDATA%\terview\` | `~/Library/Application Support/terview/` |
| Contraseñas | Llavero del sistema | Administrador de credenciales | Llavero |
| Huellas de servidores | `~/.ssh/known_hosts` | `%USERPROFILE%\.ssh\known_hosts` | `~/.ssh/known_hosts` |

---

## 🩺 Solución de problemas

| Problema | Solución |
|----------|----------|
| Ventana en blanco, parpadeos o lentitud en Linux (Wayland / NVIDIA) | Abre con `WEBKIT_DISABLE_DMABUF_RENDERER=1 terview`. Si mejora, añádelo a tu entorno. |
| "Llavero del sistema no disponible" | Instala/activa GNOME Keyring o KWallet (`sudo dnf install gnome-keyring`). Sin llavero, TerView pedirá la contraseña en cada conexión. |
| "¡La huella del servidor cambió!" | Si reinstalaste el servidor es normal: confirma la nueva huella. Si no, **no te conectes**: podría ser un ataque. |
| No conecta con llave | Comprueba que elegiste la llave **privada** (sin `.pub`) y que la pública está en `~/.ssh/authorized_keys` del servidor. |
| AppImage no abre | Falta FUSE (ver arriba) o el permiso de ejecución (`chmod +x`). |

---

## 🛠️ Desarrollo

**Tecnología:** [Tauri 2](https://tauri.app) + Rust (`russh`, `russh-sftp`, `tokio`) · React 19 + TypeScript + Vite ·
xterm.js · Monaco. Arquitectura con diagramas en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

### Requisitos

<details open>
<summary><strong>Fedora</strong></summary>

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel \
  librsvg2-devel libxdo-devel dbus-devel
sudo dnf group install c-development
```
</details>

<details>
<summary><strong>Debian / Ubuntu</strong></summary>

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
```
</details>

<details>
<summary><strong>Windows</strong></summary>

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (carga de trabajo *Desarrollo para el escritorio con C++*)
- WebView2 (ya incluido en Windows 10/11)
</details>

<details>
<summary><strong>macOS</strong></summary>

```bash
xcode-select --install
```
</details>

En todos: **Rust** (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, o [rustup.rs](https://rustup.rs) en Windows)
y **Node.js 20+**.

### Compilar y ejecutar

```bash
git clone git@github.com:LeoMael/TerView.git
cd TerView
npm install
npm run tauri dev          # modo desarrollo (se recarga solo)
npm run tauri build        # instaladores en src-tauri/target/release/bundle/
```

Solo algunos formatos: `npm run tauri build -- --bundles rpm,deb,appimage` (Linux) · `--bundles msi,nsis` (Windows) · `--bundles dmg` (macOS).

### Pruebas

Las pruebas del motor se ejecutan contra un servidor SSH local en un contenedor:

```bash
podman run -d --name terview-sshd -p 127.0.0.1:2222:2222 \
  -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true \
  -e USER_NAME=test -e USER_PASSWORD=test123 \
  lscr.io/linuxserver/openssh-server:latest     # o "docker run ..."

cd src-tauri
cargo test --lib -- --include-ignored --test-threads=1
cargo clippy --all-targets
cd .. && npx tsc --noEmit
```

### Estructura

```
src/              Interfaz (React + TypeScript)
  api/            Única puerta hacia el motor
  components/     Sidebar, Tabs, FileExplorer, Terminal, Editor, Commands, TransferPanel…
  stores/         Estado (zustand)
src-tauri/src/    Motor (Rust)
  ssh/            Conexión, autenticación, huellas, reconexión
  terminal/       Shells con PTY
  sftp/           Explorador y edición remota
  transfer/       Cola de transferencias en paralelo
  storage/        Servidores, ajustes, llavero, ~/.ssh/config
  snippets/       Mis comandos y ejecución con captura
docs/             Arquitectura, diagramas, pendientes, catálogo de comandos
```

---

## 🗺️ Hoja de ruta

Lo siguiente (detalle en [`docs/PENDIENTES.md`](docs/PENDIENTES.md)): optimización · administración de
usuarios y grupos · monitoreo en vivo · túneles (port forwarding) · actualizaciones automáticas ·
instaladores de Windows/macOS con GitHub Actions · integración con cuenta de GitHub.

---

<p align="center"><sub>Hecho con Tauri, Rust y React · © LeoMael</sub></p>
