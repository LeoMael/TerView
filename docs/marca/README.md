# Marca: SSHorus

A partir de la versión que sigue a la 0.5.0, TerView pasa a llamarse **SSHorus** (SSH + Horus, el dios
halcón egipcio cuyo ojo todo lo ve y protege). El logo elegido es el **ojo de Horus con la terminal `>_` en
el iris** (propuesta `sshorus/ojo/`). Todo lo listo para usar está en [`sshorus/final/`](sshorus/final/).

![Logo final a tamaño real](sshorus/final/hoja.png)

`isotipo.svg` e `isotipo-1024.png` en esta carpeta son el **logo viejo** de TerView. Se quitan cuando se
haga el cambio de nombre en la app.

## Qué archivo usar para cada cosa

Todos están en `docs/marca/sshorus/final/`.

| Para qué | Archivo | Notas |
|---|---|---|
| Iconos de la app (Windows, macOS, Linux) | `icono-app-1024.png` | Fuente de `npx tauri icon`. PNG 1024 con transparencia; el cuadrado ocupa 824 × 824 (80 %), como pide macOS |
| Icono de la app editable | `icono-app.svg` | El mismo dibujo en vectores |
| Icono de la app a 24 y 32 px | `icono-app-24.png`, `icono-app-32.png` (y sus `.svg`) | Ajustados a los píxeles. Después de `tauri icon`, conviene poner `icono-app-32.png` en lugar de `32x32.png` y meter el de 24 en el `.ico` |
| Logo suelto a 16, 24 y 32 px | `isotipo-pequeno-16/24/32.png` (fondo claro), `isotipo-pequeno-oscuro-16/24/32.png` (fondo oscuro) | Fuentes: `isotipo-pequeno.svg` (16), `isotipo-pequeno-24.svg`, `isotipo-pequeno-32.svg` y sus `-oscuro` |
| Logo suelto a 48 px o más | `isotipo.svg` / `isotipo-oscuro.svg` (`isotipo-1024.png`, `isotipo-oscuro-1024.png`) | El dibujo con todos los detalles |
| Icono de bandeja en macOS (plantilla) | `monocromo-16.png` y `monocromo-32.png` (@2x) | Negro con transparencia; macOS lo tiñe solo (`iconAsTemplate`) |
| Icono de bandeja en Linux | `monocromo-16.png`, o `isotipo-pequeno-oscuro-16.png` si la barra es oscura | |
| Icono de bandeja en Windows | `isotipo-pequeno-16.png` / `isotipo-pequeno-oscuro-16.png` | Windows no tiñe los iconos de la bandeja: usar el de colores |
| Favicon (web) | `favicon.svg` | Cambia solo a los colores oscuros si el navegador está en modo oscuro |
| Logo con el nombre | `imagotipo.svg` / `imagotipo-oscuro.svg` (PNG de 256 px de alto) | Letras ya pasadas a curvas |
| Revisión | `hoja.png` | Todo a 16, 24, 32, 48, 64, 128 y 256 px en claro y oscuro, y simulado en barras de tareas |

Regla corta: **a 32 px o menos, siempre el «pequeño»**; a 48 px o más, el grande.

## Colores

| Nombre | Hex | Dónde va |
|---|---|---|
| Azul lapislázuli | `#1D3FA6` | Trazos del ojo en fondo claro, fondo del icono de la app, `>_` del icono de la app |
| Oro | `#F0A500` | Iris en fondo claro, «SSH» del imagotipo claro |
| Oro claro | `#F5C542` | Trazos del ojo en fondo oscuro y en el icono de la app, «SSH» del imagotipo oscuro |
| Tinta | `#14213D` | `>_` en fondo claro, «orus» del imagotipo claro |
| Azul claro | `#3B6FF0` | Iris en fondo oscuro, borde fino del icono de la app |
| Blanco | `#FFFFFF` | `>_` en fondo oscuro, iris del icono de la app |
| Texto en oscuro | `#F1F5F9` | «orus» del imagotipo oscuro |

Sin degradados ni sombras: todos los colores son planos.

## Tipografía

- Imagotipo: **Montserrat Bold**, «SSH» en oro y «orus» en tinta (o `#F1F5F9` en oscuro). En los SVG ya
  está en curvas.
- Textos de la app y la web: la fuente del sistema o **Inter**.
- Terminal: **JetBrains Mono**.

Todas son gratis (Google Fonts).

## Qué cambia en el isotipo pequeño

A 16 px el dibujo grande se queda en una mancha y el `>_` desaparece. El pequeño está redibujado para los
píxeles:

- El iris es más grande (casi todo el alto del ojo) y el `>_` está pintado píxel a píxel: un `>` de 5 píxeles
  de alto y un `_` de 2 (a 24 px, un `>` de 7 píxeles y 2 de grueso; a 32 px, de 9).
- Menos detalle y trazos más gruesos (1,3–1,4 px a 16 px), con las líneas rectas sobre filas y columnas
  enteras para que no se vean borrosas.
- La ceja es casi recta, la lágrima vertical y la espiral más corta, para que entre todo en 16 × 16.
- Cada tamaño (16, 24 y 32) tiene su propio SVG, ajustado a su cuadrícula.

## Cómo se eligió

Las pruebas de nombres están en [NOMBRES.md](NOMBRES.md) y la comparación de todas las propuestas de logo en
[comparacion.png](comparacion.png). En `sshorus/ojo/` queda la propuesta original de la que sale el logo
final (isotipo e imagotipo en claro y oscuro, y PNG de 16 a 1024 px).

Propuestas que no se eligieron: Argos (pluma y anillo), SSHorus halcón (cabeza del halcón de perfil) y
Ocelo (mancha-ojo y ala).

## Siguiente paso

Cambiar el nombre en la app (migrando los datos, ver `docs/PENDIENTES.md`) y generar los iconos con:

```
npm run tauri icon docs/marca/sshorus/final/icono-app-1024.png
```

Después, cambiar `src-tauri/icons/32x32.png` por `icono-app-32.png`.
