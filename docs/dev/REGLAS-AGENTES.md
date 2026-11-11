# Reglas para construir TerView en paralelo

Proyecto: `/home/mael/LEO/Projects/TERVIEW` — cliente SSH/SFTP de escritorio (estilo Termius/MobaXterm).
Tauri 2 + Rust (motor, `src-tauri/`) · React 19 + TypeScript + Vite (interfaz, `src/`).
Visión y diagramas: `docs/ARQUITECTURA.md` y `docs/arquitectura/*.png` (mira `04-ventana.png`).
El usuario habla español: **todo texto visible en la app va en español**. Calidad profesional.

## 1. Varios agentes trabajan A LA VEZ en la misma carpeta

- **Solo edita los archivos que tu tarea dice que son tuyos.** Puedes crear archivos nuevos dentro de tus carpetas.
- **Archivos BASE (no editar):**
  `src-tauri/src/{lib.rs,error.rs,types.rs,ssh/mod.rs}`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
  `src-tauri/capabilities/*`, `package.json`, `src/main.tsx`, `src/api/*`, `src/lib/*`, `src/styles/theme.css`,
  `src/components/ui/*`, `src/stores/{tabs,settings,toasts,ui}.ts`.
  Si de verdad necesitas un cambio en BASE o una dependencia nueva: no lo hagas; arréglatelas y pídelo en tu informe final.
- Los **comandos Tauri ya están registrados** en `lib.rs` con su firma. Implementa el cuerpo; puedes quitar el `_` de
  los parámetros, pero **no cambies nombres de comandos, nombres/tipos de parámetros ni tipos de retorno**
  (la interfaz ya los llama así desde `src/api/*.ts`).
- Algunos archivos de otros agentes existen como STUB con su firma final (p. ej. `FileExplorer`, `TerminalArea`,
  `connectToServer`, `useProfiles`). Puedes importarlos; **respeta esas firmas en tus propios stubs**.
- Mientras compilas verás errores en archivos de otros agentes que están a medio trabajo: **ignóralos**, filtra la
  salida a tus archivos y nunca los "arregles". Si te bloquean por mucho rato, espera un poco y reintenta.

## 2. Compilar y probar

```bash
source ~/.cargo/env
cd src-tauri && cargo check --message-format short 2>&1 | grep -E 'src/(TU_MODULO)'   # motor
cd src-tauri && cargo test --lib TU_MODULO -- --ignored --test-threads=1           # tests con servidor real
npx tsc --noEmit 2>&1 | grep 'src/components/TU_CARPETA'                            # interfaz (desde la raíz)
```
- Esperar el candado de cargo ("Blocking waiting for file lock") es normal.
- **No** ejecutes `npm run tauri dev`, `tauri build`, `cargo build --release` ni abras ventanas.
- **Servidor SSH de pruebas**: `127.0.0.1:2222`, usuario `test`, contraseña `test123` (contenedor podman
  `terview-sshd`, OpenSSH 10.3, home `/config`). Usa SOLO este servidor. Trabaja dentro de `/config/tmp-<algo>`
  y bórralo al final.
- En tests: `crate::ssh::connect::testutil::connect_test_server().await` devuelve un `Arc<SshSession>` listo
  (lo implementa el agente SSH primero; si aún da `unimplemented!`, sigue con otra cosa y reintenta luego).
- Tests que necesitan red: márcalos `#[ignore]` y `#[tokio::test]`.
- **Nunca** escribas en el `~/.ssh/known_hosts` real ni en el llavero real desde tests (usa rutas temporales y el
  servicio `terview-test`).

## 3. Motor (Rust)

- Versiones: `russh 0.65.1`, `russh-sftp 3.0.1`, `tauri 2.12`, `tokio` (full), `tokio-util`, `futures`, `walkdir`,
  `uuid` (v4), `keyring 4.2`, `dirs 7`, `thiserror 2`, `serde/serde_json`, `log`.
  Código fuente y ejemplos: `~/.cargo/registry/src/index.crates.io-*/<crate>-<versión>/` (mira `examples/`).
  El trait `russh::client::Handler` usa `async fn` nativo (sin `async_trait`).
- Errores: devuelve `AppResult<T>` y usa las variantes de `AppError` (`src-tauri/src/error.rs`) con mensajes en español.
  Ya existen `From` para `io::Error`, `russh::Error`, `russh_sftp::client::error::Error`, `serde_json::Error`.
- Tipos compartidos en `src-tauri/src/types.rs` (espejo de `src/api/types.ts`). Eventos: constantes `EV_*`.
- Sin `unwrap()`/`expect()` en rutas de ejecución normales. Nada de bloquear el runtime async
  (usa `tokio::task::spawn_blocking` para E/S de disco pesada si hace falta).

## 4. Interfaz (React)

- Llama al motor SOLO por `src/api/*` (`ssh`, `terminal`, `sftp`, `transfers`, `profiles`, `settingsApi`).
  Los errores llegan como `ApiError` con `.kind` (ver `isApiError`).
- Estado: `zustand`. Compartidos: `useTabs` (pestañas), `useSettings` (ajustes), `toast` (avisos), `useUi` (diálogos globales).
- Diálogos: `confirmDialog()` / `promptDialog()` (`src/components/ui/dialogs.tsx`), `Modal`.
- Utilidades: `src/lib/format.ts` (bytes, fechas, velocidad), `src/lib/paths.ts` (rutas remotas).
- Íconos: `lucide-react`. Paneles redimensionables: `react-resizable-panels` v4 (lee sus tipos en node_modules; la API cambió respecto a v2).
  Diálogos de archivos locales: `@tauri-apps/plugin-dialog`. Arrastrar desde el sistema: `getCurrentWebview().onDragDropEvent`.
- Estilos: **usa las variables y clases de `src/styles/theme.css`** (`--bg`, `--surface`, `--accent`, `.btn`, `.btn-primary`,
  `.input`, `.field`, `.icon-btn`, `.context-menu`, `.progress`, `.status-dot`, `.section-label`, `.empty-state`, `.spinner`…).
  Tu CSS va en un archivo junto a tu componente, importado desde él, con clases prefijadas por el componente
  (p. ej. `.fx-row` para FileExplorer) para no chocar con otros. Debe verse bien en tema oscuro y claro.
- Densidad tipo herramienta profesional (VS Code / Termius): filas de ~28 px, fuente 13 px, sin espacios enormes.
- Accesible por teclado donde tenga sentido. Nada de `any` salvo que sea inevitable.

## 5. Informe final (máx. ~300 palabras)

Qué hiciste, archivos, cómo lo probaste (y resultado), límites conocidos, y peticiones de cambios a BASE o dependencias.
