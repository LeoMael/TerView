# Nombres posibles para TerView

Comprobado el **12/11/2026** con `gh`, la API de crates.io, el registro de npm, `whois`, RDAP del registro de
Google (para `.app` y `.dev`), `dig` y búsquedas en la web. Lo que está libre hoy puede no estarlo mañana:
si se elige uno, conviene **reservar enseguida** el dominio y el usuario de GitHub.

Cómo leer la tabla:

- **GitHub**: si la cuenta `github.com/<nombre>` existe y el repositorio más conocido con ese nombre.
- **crates / npm**: si el paquete con ese nombre ya existe (no hace falta publicar ahí, pero da una idea de
  cuánto se usa el nombre entre programadores).
- **Dominios**: «libre» = el registro dice que no existe; «tomado» = registrado (tiene DNS o datos de registro).
- **Nota**: de 1 (mala idea) a 5 (muy buena).

## Tabla

| Nombre | Significado | GitHub | crates / npm | Dominios `.com` `.app` `.dev` | Choques | Nota |
|---|---|---|---|---|---|---|
| **SSHorus** | SSH + Horus, el dios halcón egipcio cuyo ojo todo lo ve y protege | Cuenta **libre**. Ningún repositorio con ese nombre | **Libre / libre** | **Libre / libre / libre** | Ninguno directo. En la web solo sale «SSHoRTy» (otra cosa). Parientes lejanos: **Horusec** (escáner de vulnerabilidades, 1.300★), **Horus** (herramienta OSINT, 1.100★) | **4** |
| **Argos** | El gigante de cien ojos que vigila sin dormir | Cuenta **tomada** (organización vacía creada en ene. 2026). Repos: Argos Translate (6.600★), **Argos CI** (pruebas visuales, 660★), extensión de GNOME «argos» (1.800★) | Tomado / tomado | Tomado / tomado / tomado | **Argos**, tienda grande del Reino Unido (app con 592 mil valoraciones en la App Store, más de 1.100 puntos de recogida). **Cementos Argos / Grupo Argos** (Colombia, la cementera más grande del país). **ARGOS Cloud Security** (seguridad en la nube, Australia). Muy cerca de **Argus** (varias herramientas de monitoreo) y **Argo CD** (despliegues) | **3** |
| ArgosSH / ArgosTerm | Variantes de Argos para tener nombre propio | Cuentas **libres** | Libre / libre | **Libre / libre / libre** (los dos) | Los mismos de Argos al buscar en Google | (3) |
| **Ocelo** | La «mancha-ojo» de la pluma del pavo real y de las alas de mariposa (en inglés, *ocellus*) | Cuenta tomada (usuario sin repos). Nada con ese nombre exacto | **Libre / libre** | Tomado / tomado / tomado | Nada de software con ese nombre. Google tiende a corregir a **Ocelot** (pasarela de APIs de .NET, 8.700★) o a **Celo** | **3** |
| Vigía | Quien vigila desde lo alto | Cuenta tomada. **breferrari/vigia**: «monitor de terminal junto a tu agente de IA» | Tomado (el mismo proyecto) / libre | Tomado / tomado / tomado | Apps de seguridad física (Vigia de Arsegec, VigiControl). La tilde se pierde en inglés y en URLs | **2** |
| Atalaya | Torre de vigilancia | Cuenta tomada. **neural-beat/atalaya**: «tu servidor Linux a la vista, por SSH, sin instalar nada en él» (sept. 2026) | Libre / tomado | Tomado / tomado / tomado | **Choque directo**: el proyecto de arriba hace casi lo mismo que la app. Difícil de decir en inglés | **1** |
| Faro | Luz que guía y avisa | Cuenta tomada. **Grafana Faro** (1.150★) | Tomado / tomado | Tomado / tomado / tomado | **Grafana Faro** es un producto de observabilidad (monitoreo) de Grafana Labs. También la ciudad de Faro (Portugal) | **1** |
| Panoptes | El sobrenombre de Argos: «el que lo ve todo» | Cuenta tomada (Project PANOPTES). **yahoo/panoptes** (telemetría de redes) | Tomado / tomado | Tomado / tomado / tomado | Yahoo Panoptes, Zooniverse Panoptes. Recuerda al «panóptico» (cárcel vigilada): suena a espionaje | **2** |
| Udjat | Otro nombre del ojo de Horus | Cuenta tomada («Eye of Horus», sin repos) | Libre / libre | Tomado / **libre** / tomado | Nada importante. Pero cuesta decirlo y escribirlo («udyat», «wedjat», «oudjat») | **2** |

También se miraron **Oteo** (de «otear»: `.com`, `.app` y `.dev` tomados) y **Garita** (caseta del guardia:
`.com` y `.app` tomados, `.dev` libre; existe «garita», un cliente de escritorio para Kubernetes). No suben
de 2.

## Lo bueno y lo malo de los finalistas

**SSHorus**
- A favor: todo libre (GitHub, crates, npm, los tres dominios). Se busca bien: hoy en Google no hay nada con
  ese nombre, así que la app saldría primera. Dice qué es (SSH) y qué hace (vigilar, proteger).
- En contra: la pronunciación no es obvia (en español «es-es-jórus», en inglés «es-es-hórus» o «shórus»).
  Escrito en mayúsculas empieza por «SS»; con «SSH» bien marcado en otro color (como en el imagotipo) no se
  nota. En inglés, «Horus» a veces se usa en bromas por cómo suena; es menor.

**Argos**
- A favor: el que más le gusta al usuario, corto, igual en los dos idiomas, mito muy claro (vigilar sin
  dormir).
- En contra: **se entierra en Google** bajo la tienda del Reino Unido, la cementera colombiana y Argos CI
  (otra herramienta de programadores). Ni el usuario de GitHub ni ningún dominio corto están libres. Habría
  que usar una variante para lo técnico: **ArgosSH** o **ArgosTerm** (libres en todo) con «Argos» como
  nombre visible.

**Ocelo**
- A favor: palabra real y poco usada, se dice igual en español e inglés, liga con la pluma de Argos sin
  copiar su nombre. crates y npm libres. Logo muy simple de dibujar (una mancha-ojo).
- En contra: dominios cortos tomados (habría que usar `ocelo.sh`, `getocelo.app` o similar) y pocos saben
  qué es un «ocelo»: hay que explicarlo.

## Recomendación

1. **SSHorus**: el más seguro. Todo libre, nadie más lo usa y el nombre ya dice que es para SSH.
2. **Argos**, pero como **ArgosSH** en GitHub, dominio y paquetes. Es el más bonito, a cambio de competir en
   buscadores con marcas grandes.
3. **Ocelo**: si se quiere un nombre propio y suave, sin choques de software, aceptando un dominio más largo.

Descartados por chocar con productos parecidos: **Atalaya** (otro cliente SSH sin agente, casi igual),
**Faro** (Grafana Faro) y **Vigía** (otro monitor de terminal con ese nombre).

## Fuentes de la web

- Argos (tienda): [App Store](https://apps.apple.com/gb/app/argos-shop-tech-toys-more/id370371087),
  [Argos (retailer)](https://www.wikiwand.com/en/Argos_(retailer))
- Cementos Argos: [Grupo Argos](https://www.Wikipedia.org/wiki/Grupo_Argos),
  [Portafolio](https://www.portafolio.co/negocios/empresas/cementos-argos-advierte-por-uso-indebido-de-su-marca-en-productos-de-terceros-487078)
- ARGOS Cloud Security: [Slashdot](https://slashdot.org/software/p/ARGOS-Security/)
- Argus (monitoreo): [Argus (monitoring software)](https://en.wikipedia.org/wiki/Argus_(monitoring_software))
- Argos CI: [argos-ci.com](https://argos-ci.com)
- Grafana Faro: [grafana.com/oss/faro](https://grafana.com/oss/faro)
- Vigía (seguridad física): [Capterra](https://www.capterra.co.uk/software/1323831/Vigia)
- Atalaya: [github.com/neural-beat/atalaya](https://github.com/neural-beat/atalaya)
