<p align="center">
  <img src="docs/marca/isotipo-1024.png" width="96" alt="TerView" />
</p>

<h1 align="center">TerView</h1>

<p align="center">Cliente SSH/SFTP de escritorio: conéctate a tus servidores, navega carpetas, sube y baja archivos en masa, usa la terminal y comandos listos — todo en una sola ventana.</p>

![Ventana de TerView](docs/arquitectura/04-ventana.png)

## Funciones

- **Conexiones SSH** con contraseña, llave o agente; verificación de huella del servidor (`known_hosts`); códigos 2FA.
- **Reconexión automática**: detecta caídas y reintenta en la misma pestaña; terminales, explorador y transferencias continúan.
- **Terminal integrada** (xterm.js) con varias pestañas por conexión, búsqueda (`Ctrl+Shift+F`), copiar/pegar.
- **Explorador de archivos** remoto: navegar, crear, renombrar, permisos, borrar, arrastrar y soltar desde tu PC.
- **Transferencias masivas** en paralelo: carpetas completas, pausar/reanudar/cancelar, reanudación desde el último byte, política de conflictos.
- **Editor** de archivos remotos (Monaco, el de VS Code) con guardado atómico.
- **Biblioteca de comandos**: Podman, Docker, sistema, red, servicios, logs…; "Analizar servidor"; "Mis comandos"; paleta `Ctrl+Shift+P`.
- **Servidores y proyectos** guardados; contraseñas en el llavero del sistema; exportar/importar `~/.ssh/config`.
- Tema oscuro y claro, paneles ajustables, ventana que recuerda su tamaño.

## Tecnología

Tauri 2 + Rust (`russh`, `russh-sftp`, `tokio`) · React 19 + TypeScript + Vite.
La arquitectura, con diagramas, está en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md);
lo pendiente y el plan en [`docs/PENDIENTES.md`](docs/PENDIENTES.md).

## Desarrollo

Requisitos (Fedora):

```bash
sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel dbus-devel
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
npm install
```

```bash
npm run tauri dev                    # abrir en modo desarrollo
npm run tauri build -- --bundles rpm # instalador .rpm en src-tauri/target/release/bundle/rpm/
```

### Pruebas

Las pruebas del motor usan un servidor SSH local en un contenedor:

```bash
podman run -d --name terview-sshd -p 127.0.0.1:2222:2222 \
  -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true \
  -e USER_NAME=test -e USER_PASSWORD=test123 \
  lscr.io/linuxserver/openssh-server:latest

cd src-tauri && cargo test --lib -- --include-ignored --test-threads=1
```
