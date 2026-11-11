// Catálogo base de la Biblioteca de comandos (fuente: docs/comandos/CATALOGO.md).
// La categoría Docker se genera a partir de las entradas de Podman.
import { parseVars } from "./template";

export type Distro = "rpm" | "deb" | "apk";

export interface CatalogVar {
  label?: string;
  /** Comando que lista opciones, una por línea ("valor<TAB>detalle" opcional). */
  suggest?: string;
  /** Opciones fijas. */
  options?: string[];
  default?: string;
}

export interface CatalogEntry {
  id: string;
  category: string;
  group: string;
  name: string;
  description?: string;
  command: string;
  dangerous: boolean;
  sudo: boolean;
  /** Solo lectura: ideal para "Ejecutar y ver resultado". */
  readOnly: boolean;
  /** Interactivo o sin fin (top, logs -f…): solo tiene sentido en la terminal. */
  interactive?: boolean;
  distro?: Distro;
  vars?: Record<string, CatalogVar>;
}

export const CATEGORIES = [
  "Podman",
  "Docker",
  "Análisis del sistema",
  "Procesos",
  "Discos y archivos",
  "Red",
  "Servicios",
  "Logs",
  "Usuarios",
  "Paquetes",
  "Seguridad",
  "Web",
  "Git",
] as const;

export const DISTRO_LABEL: Record<Distro, string> = {
  rpm: "Fedora/RHEL",
  deb: "Debian/Ubuntu",
  apk: "Alpine",
};

// ───────── Sugerencias por nombre de variable ─────────
// "podman" se cambia por "docker" en la categoría Docker.
const VAR_HINTS: Record<string, CatalogVar> = {
  contenedor: { suggest: "podman ps -a --format '{{.Names}}'" },
  imagen: { suggest: "podman images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>'" },
  pod: { suggest: "podman pod ps --format '{{.Name}}'" },
  volumen: { suggest: "podman volume ls --format '{{.Name}}'" },
  red: { suggest: "podman network ls --format '{{.Name}}'" },
  servicio: {
    suggest: "systemctl list-units --type=service --all --no-legend --plain --no-pager | awk '{print $1}'",
  },
  usuario: { suggest: "awk -F: '$3>=1000 || $3==0 {print $1}' /etc/passwd" },
  grupo: { suggest: "cut -d: -f1 /etc/group" },
  rama: { suggest: "git branch -a --format='%(refname:short)'" },
  pid: { suggest: "ps -eo pid=,comm= --sort=-pcpu 2>/dev/null | head -40 | awk '{print $1\"\\t\"$2}'" },
  shell: { options: ["sh", "bash", "ash", "zsh"] },
  accion: { label: "acción", options: ["start", "stop", "restart", "reload", "status"] },
  desde: { options: ["10m", "1h", "6h", "24h"] },
  lineas: { label: "líneas", options: ["50", "100", "200", "500", "1000"] },
  tamaño: { options: ["10M", "100M", "500M", "1G"] },
  carpeta: { suggest: "find . -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort | head -50" },
  archivo: { suggest: "find . -maxdepth 1 -type f 2>/dev/null | sort | head -50" },
};

// ───────── Definición compacta ─────────
// [nombre, comando, descripción, banderas] — banderas: r=solo lectura (📊), d=peligroso, s=sudo,
// i=interactivo; distro en `opts`.
type Row = [name: string, command: string, description?: string, flags?: string, distro?: Distro];

interface Section {
  category: string;
  group: string;
  rows: Row[];
}

const PODMAN: Section[] = [
  {
    category: "Podman",
    group: "Ver y estado",
    rows: [
      ["Contenedores en ejecución", "podman ps", "Lista los contenedores que están en marcha.", "r"],
      [
        "Todos los contenedores",
        'podman ps -a --format "table {{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.Ports}}"',
        "Todos los contenedores (también detenidos) con estado, imagen y puertos.",
        "r",
      ],
      ["Uso de recursos en vivo", "podman stats", "CPU, memoria y red de cada contenedor, actualizado en vivo.", "i"],
      ["Uso de recursos (una vez)", "podman stats --no-stream", "Foto única del consumo de cada contenedor.", "r"],
      ["Detalles de un contenedor", "podman inspect {{contenedor}}", "Configuración completa del contenedor en JSON.", "r"],
      ["Procesos dentro del contenedor", "podman top {{contenedor}}", "Procesos que corren dentro del contenedor.", "r"],
      ["Puertos publicados", "podman port {{contenedor}}", "Qué puertos del servidor apuntan al contenedor.", "r"],
      ["Información de Podman", "podman info", "Versión, almacenamiento, red y configuración del motor.", "r"],
      ["Versión", "podman version", "Versión del cliente y del motor.", "r"],
      ["Espacio usado", "podman system df", "Espacio en disco de imágenes, contenedores y volúmenes.", "r"],
    ],
  },
  {
    category: "Podman",
    group: "Levantar, parar, reiniciar",
    rows: [
      ["Iniciar contenedor", "podman start {{contenedor}}", "Arranca un contenedor detenido."],
      ["Detener contenedor", "podman stop {{contenedor}}", "Detiene el contenedor de forma ordenada."],
      ["Reiniciar contenedor", "podman restart {{contenedor}}", "Detiene y vuelve a arrancar el contenedor."],
      ["Pausar contenedor", "podman pause {{contenedor}}", "Congela los procesos del contenedor."],
      ["Reanudar contenedor", "podman unpause {{contenedor}}", "Continúa un contenedor pausado."],
      [
        "Crear y levantar (en segundo plano)",
        "podman run -d --name {{nombre}} -p {{puerto_host}}:{{puerto_contenedor}} {{imagen}}",
        "Crea un contenedor nuevo publicando un puerto y lo deja corriendo.",
      ],
      [
        "Levantar con reinicio automático",
        "podman run -d --restart=always --name {{nombre}} {{imagen}}",
        "Crea un contenedor que se reinicia solo si se cae.",
      ],
      [
        "Levantar con carpeta compartida",
        "podman run -d --name {{nombre}} -v {{carpeta_host}}:{{carpeta_contenedor}}:Z {{imagen}}",
        "Crea un contenedor montando una carpeta del servidor (con etiqueta SELinux).",
      ],
      ["Iniciar todos los detenidos", "podman start --all", "Arranca todos los contenedores detenidos."],
      ["Detener todos", "podman stop --all", "Detiene TODOS los contenedores en marcha.", "d"],
    ],
  },
  {
    category: "Podman",
    group: "Logs y entrar al contenedor",
    rows: [
      ["Ver logs", "podman logs --tail {{lineas:200}} {{contenedor}}", "Últimas líneas del log del contenedor.", "r"],
      [
        "Seguir logs en vivo",
        "podman logs -f --tail {{lineas:100}} {{contenedor}}",
        "Muestra los logs del contenedor en tiempo real.",
        "i",
      ],
      [
        "Logs desde hace un tiempo",
        "podman logs --since {{desde:1h}} {{contenedor}}",
        "Logs generados en el periodo indicado (10m, 1h, 24h…).",
        "r",
      ],
      ["Entrar con shell", "podman exec -it {{contenedor}} {{shell:sh}}", "Abre una shell dentro del contenedor.", "i"],
      ["Ejecutar un comando dentro", "podman exec {{contenedor}} {{comando}}", "Ejecuta un comando dentro del contenedor.", "r"],
      ["Copiar archivo al contenedor", "podman cp {{archivo}} {{contenedor}}:{{ruta}}", "Copia un archivo del servidor al contenedor."],
      [
        "Copiar archivo desde el contenedor",
        "podman cp {{contenedor}}:{{ruta}} {{destino}}",
        "Copia un archivo del contenedor al servidor.",
      ],
    ],
  },
  {
    category: "Podman",
    group: "Imágenes",
    rows: [
      ["Listar imágenes", "podman images", "Imágenes descargadas o construidas en el servidor.", "r"],
      ["Descargar imagen", "podman pull {{imagen}}", "Descarga una imagen del registro."],
      [
        "Construir imagen",
        "podman build -t {{nombre}}:{{etiqueta:latest}} {{carpeta:.}}",
        "Construye una imagen a partir del Containerfile/Dockerfile de la carpeta.",
      ],
      ["Etiquetar imagen", "podman tag {{imagen}} {{nueva_etiqueta}}", "Añade otro nombre/etiqueta a una imagen."],
      ["Subir imagen a registro", "podman push {{imagen}}", "Publica la imagen en su registro."],
      ["Iniciar sesión en registro", "podman login {{registro}}", "Pide usuario y contraseña del registro.", "i"],
      ["Historial de una imagen", "podman history {{imagen}}", "Capas que forman la imagen y su tamaño.", "r"],
    ],
  },
  {
    category: "Podman",
    group: "Compose (varios contenedores)",
    rows: [
      ["Levantar proyecto", "podman compose up -d", "Levanta los servicios del compose de la carpeta actual."],
      ["Bajar proyecto", "podman compose down", "Detiene y elimina los contenedores del proyecto."],
      ["Estado del proyecto", "podman compose ps", "Estado de los servicios del proyecto.", "r"],
      ["Logs del proyecto", "podman compose logs -f --tail {{lineas:100}}", "Logs de todos los servicios en vivo.", "i"],
      ["Reconstruir y levantar", "podman compose up -d --build", "Reconstruye las imágenes y levanta el proyecto."],
      [
        "Actualizar imágenes y levantar",
        "podman compose pull && podman compose up -d",
        "Descarga las imágenes nuevas y recrea los servicios.",
      ],
    ],
  },
  {
    category: "Podman",
    group: "Pods, volúmenes y redes",
    rows: [
      ["Listar pods", "podman pod ps", "Pods y cuántos contenedores tiene cada uno.", "r"],
      ["Crear pod", "podman pod create --name {{pod}} -p {{puerto_host}}:{{puerto}}", "Crea un pod publicando un puerto."],
      ["Iniciar pod", "podman pod start {{pod}}", "Arranca todos los contenedores del pod."],
      ["Detener pod", "podman pod stop {{pod}}", "Detiene todos los contenedores del pod."],
      ["Listar volúmenes", "podman volume ls", "Volúmenes de datos.", "r"],
      ["Crear volumen", "podman volume create {{volumen}}", "Crea un volumen de datos."],
      ["Detalles de volumen", "podman volume inspect {{volumen}}", "Dónde está y cómo está configurado el volumen.", "r"],
      ["Listar redes", "podman network ls", "Redes de contenedores.", "r"],
      ["Crear red", "podman network create {{red}}", "Crea una red para conectar contenedores."],
    ],
  },
  {
    category: "Podman",
    group: "Arranque automático con systemd",
    rows: [
      [
        "Generar servicio (Quadlet)",
        "mkdir -p ~/.config/containers/systemd && cat > ~/.config/containers/systemd/{{nombre}}.container <<'EOF'\n" +
          "[Unit]\nDescription={{nombre}}\n\n[Container]\nImage={{imagen}}\nContainerName={{nombre}}\n" +
          "PublishPort={{puerto_host}}:{{puerto_contenedor}}\n\n[Service]\nRestart=always\n\n" +
          "[Install]\nWantedBy=default.target\nEOF",
        "Crea el archivo .container para que systemd gestione el contenedor. Después: recargar servicios y activarlo.",
      ],
      ["Recargar servicios de usuario", "systemctl --user daemon-reload", "Relee los servicios (necesario tras crear un Quadlet)."],
      [
        "Activar servicio del contenedor",
        "systemctl --user enable --now {{nombre}}",
        "Arranca el servicio ahora y en cada inicio.",
      ],
      [
        "Mantener servicios sin sesión iniciada",
        "sudo loginctl enable-linger $USER",
        "Permite que tus servicios sigan corriendo sin tener sesión abierta.",
        "s",
      ],
      ["Actualizar contenedores automáticamente", "podman auto-update", "Actualiza los contenedores marcados con auto-update."],
    ],
  },
  {
    category: "Podman",
    group: "Limpieza",
    rows: [
      ["Borrar contenedor", "podman rm {{contenedor}}", "Elimina un contenedor detenido.", "d"],
      ["Borrar contenedor (forzado)", "podman rm -f {{contenedor}}", "Elimina el contenedor aunque esté en marcha.", "d"],
      ["Borrar imagen", "podman rmi {{imagen}}", "Elimina una imagen.", "d"],
      ["Borrar contenedores detenidos", "podman container prune -f", "Elimina todos los contenedores detenidos.", "d"],
      ["Borrar imágenes sin usar", "podman image prune -a -f", "Elimina todas las imágenes que no usa ningún contenedor.", "d"],
      [
        "Limpieza total",
        "podman system prune -a -f",
        "Elimina contenedores detenidos, imágenes sin usar, redes y caché de construcción.",
        "d",
      ],
    ],
  },
];

const OTHERS: Section[] = [
  {
    category: "Análisis del sistema",
    group: "Sistema",
    rows: [
      ["Sistema operativo", "cat /etc/os-release", "Distribución y versión.", "r"],
      ["Kernel y arquitectura", "uname -a", "Versión del kernel y arquitectura.", "r"],
      ["Nombre del equipo", "hostnamectl", "Nombre, sistema, kernel y tipo de máquina.", "r"],
      ["Tiempo encendido y carga", "uptime", "Desde cuándo está encendido y la carga media.", "r"],
      ["CPU (detalle)", "lscpu", "Modelo, núcleos e hilos del procesador.", "r"],
      ["Número de CPUs", "nproc", "Cantidad de procesadores disponibles.", "r"],
      ["Memoria y swap", "free -h", "Memoria usada y libre.", "r"],
    ],
  },
  {
    category: "Análisis del sistema",
    group: "Discos",
    rows: [
      ["Discos (uso)", "df -hT -x tmpfs -x devtmpfs", "Espacio usado por cada disco montado.", "r"],
      ["Discos (dispositivos)", "lsblk", "Discos y particiones.", "r"],
      [
        "Carpetas más pesadas",
        "du -h --max-depth=1 {{carpeta:/}} 2>/dev/null | sort -hr | head -20",
        "Las 20 subcarpetas que más ocupan.",
        "r",
      ],
    ],
  },
  {
    category: "Análisis del sistema",
    group: "Actividad",
    rows: [
      ["Procesos que más CPU usan", "ps aux --sort=-%cpu | head -15", "Top 15 por uso de CPU.", "r"],
      ["Procesos que más memoria usan", "ps aux --sort=-%mem | head -15", "Top 15 por uso de memoria.", "r"],
      ["Servicios fallidos", "systemctl --failed", "Servicios systemd en estado fallido.", "r"],
      ["Puertos abiertos", "ss -tulpn", "Puertos TCP/UDP a la escucha y qué proceso los usa.", "r"],
      ["Últimos errores del sistema", "journalctl -p err -n 50 --no-pager", "Las 50 últimas entradas de error del journal.", "r"],
      ["Últimos inicios de sesión", "last -n 20", "Quién entró y cuándo.", "r"],
      ["Usuarios conectados", "who", "Sesiones abiertas ahora.", "r"],
      ["Contenedores (Podman)", "podman ps -a", "Todos los contenedores de Podman.", "r"],
      ["Contenedores (Docker)", "docker ps -a", "Todos los contenedores de Docker.", "r"],
    ],
  },
  {
    category: "Análisis del sistema",
    group: "Actualizaciones",
    rows: [
      ["Actualizaciones pendientes", "dnf check-update", "Paquetes con actualización disponible.", "r", "rpm"],
      ["Actualizaciones pendientes", "apt list --upgradable", "Paquetes con actualización disponible.", "r", "deb"],
      ["Actualizaciones pendientes", "apk version -l '<'", "Paquetes con actualización disponible.", "r", "apk"],
    ],
  },
  {
    category: "Procesos",
    group: "Procesos",
    rows: [
      [
        "Monitor interactivo",
        "command -v htop >/dev/null && htop || top",
        "Monitor de procesos en vivo (htop si está, si no top).",
        "i",
      ],
      ["Buscar proceso", "ps aux | grep -i {{nombre}}", "Procesos cuyo nombre o argumentos coinciden.", "r"],
      ["Terminar proceso", "kill {{pid}}", "Pide al proceso que termine (SIGTERM).", "d"],
      ["Forzar cierre", "kill -9 {{pid}}", "Mata el proceso inmediatamente (SIGKILL).", "d"],
      ["Árbol de procesos", "pstree -p", "Procesos en forma de árbol con su PID.", "r"],
    ],
  },
  {
    category: "Discos y archivos",
    group: "Espacio",
    rows: [
      ["Espacio libre", "df -h", "Espacio de cada sistema de archivos.", "r"],
      ["Tamaño de carpeta", "du -sh {{carpeta}}", "Cuánto ocupa una carpeta.", "r"],
      [
        "Archivos más grandes",
        "find {{carpeta:/}} -type f -size +{{tamaño:100M}} -exec ls -lh {} \\; 2>/dev/null",
        "Archivos que superan el tamaño indicado.",
        "r",
      ],
    ],
  },
  {
    category: "Discos y archivos",
    group: "Buscar",
    rows: [
      ["Buscar archivo por nombre", 'find {{carpeta:.}} -iname "*{{nombre}}*"', "Busca archivos cuyo nombre contenga el texto.", "r"],
      ["Buscar texto en archivos", 'grep -rn "{{texto}}" {{carpeta:.}}', "Busca un texto dentro de los archivos.", "r"],
    ],
  },
  {
    category: "Discos y archivos",
    group: "Comprimir",
    rows: [
      ["Comprimir carpeta", "tar -czf {{archivo}}.tar.gz {{carpeta}}", "Crea un .tar.gz con la carpeta."],
      ["Descomprimir", "tar -xzf {{archivo}}", "Extrae un .tar.gz en la carpeta actual."],
    ],
  },
  {
    category: "Red",
    group: "Direcciones y conexiones",
    rows: [
      ["IPs del servidor", "ip -br addr", "Interfaces de red y sus direcciones.", "r"],
      ["IP pública", "curl -s ifconfig.me", "Dirección IP con la que sale a Internet.", "r"],
      ["Probar conexión", "ping -c 4 {{host}}", "Envía 4 pings al host.", "r"],
      ["Ruta hacia un host", "tracepath {{host}}", "Saltos de red hasta el host.", "r"],
      ["Puertos en uso", "ss -tulpn", "Puertos a la escucha.", "r"],
      ["¿Quién usa un puerto?", "ss -tulpn | grep :{{puerto}}", "Qué proceso escucha en ese puerto.", "r"],
      ["Probar una web", "curl -I {{url}}", "Cabeceras de respuesta de una URL.", "r"],
      ["DNS", "dig {{dominio}}", "Consulta DNS del dominio.", "r"],
    ],
  },
  {
    category: "Red",
    group: "Firewall",
    rows: [
      ["Firewall", "sudo firewall-cmd --list-all", "Reglas activas de firewalld.", "rs", "rpm"],
      [
        "Abrir puerto",
        "sudo firewall-cmd --add-port={{puerto}}/tcp --permanent && sudo firewall-cmd --reload",
        "Abre un puerto TCP de forma permanente.",
        "s",
        "rpm",
      ],
      ["Firewall", "sudo ufw status verbose", "Reglas activas de ufw.", "rs", "deb"],
      ["Abrir puerto", "sudo ufw allow {{puerto}}/tcp", "Abre un puerto TCP en ufw.", "s", "deb"],
    ],
  },
  {
    category: "Servicios",
    group: "systemd",
    rows: [
      ["Estado de un servicio", "systemctl status {{servicio}} --no-pager", "Si está activo, desde cuándo y sus últimos logs.", "r"],
      [
        "Iniciar / detener / reiniciar",
        "sudo systemctl {{accion:restart}} {{servicio}}",
        "Cambia el estado del servicio.",
        "s",
      ],
      ["Activar al arrancar", "sudo systemctl enable --now {{servicio}}", "Arranca el servicio ahora y en cada inicio.", "s"],
      [
        "Servicios activos",
        "systemctl list-units --type=service --state=running --no-pager",
        "Servicios en marcha.",
        "r",
      ],
      [
        "Logs de un servicio",
        "journalctl -u {{servicio}} -n {{lineas:100}} --no-pager",
        "Últimas líneas del log del servicio.",
        "r",
      ],
      ["Logs en vivo", "journalctl -u {{servicio}} -f", "Log del servicio en tiempo real.", "i"],
    ],
  },
  {
    category: "Logs",
    group: "Logs",
    rows: [
      ["Logs del sistema (hoy)", "journalctl --since today --no-pager | tail -200", "Últimas 200 líneas del journal de hoy.", "r"],
      ["Errores recientes", "journalctl -p err -b --no-pager", "Errores desde el último arranque.", "r"],
      ["Seguir un archivo de log", "tail -f {{archivo}}", "Muestra las líneas nuevas del archivo en vivo.", "i"],
      ["Logs de nginx (errores)", "sudo tail -n 100 /var/log/nginx/error.log", "Últimos errores de nginx.", "rs"],
    ],
  },
  {
    category: "Usuarios",
    group: "Usuarios y permisos",
    rows: [
      ["Quién soy", "whoami && id", "Tu usuario, grupos e identificadores.", "r"],
      ["Crear usuario", "sudo useradd -m {{usuario}}", "Crea un usuario con carpeta personal.", "s"],
      ["Cambiar contraseña", "sudo passwd {{usuario}}", "Pide la contraseña nueva del usuario.", "si"],
      ["Dar sudo", "sudo usermod -aG wheel {{usuario}}", "Añade el usuario al grupo wheel.", "sd", "rpm"],
      ["Dar sudo", "sudo usermod -aG sudo {{usuario}}", "Añade el usuario al grupo sudo.", "sd", "deb"],
      ["Dar sudo", "sudo addgroup {{usuario}} wheel", "Añade el usuario al grupo wheel.", "sd", "apk"],
      ["Cambiar dueño", "sudo chown -R {{usuario}}:{{grupo}} {{ruta}}", "Cambia el dueño de una ruta y todo su contenido.", "sd"],
    ],
  },
  {
    category: "Paquetes",
    group: "Fedora/RHEL (dnf)",
    rows: [
      ["Actualizar todo", "sudo dnf upgrade -y", "Instala todas las actualizaciones.", "s", "rpm"],
      ["Instalar", "sudo dnf install -y {{paquete}}", "Instala un paquete.", "s", "rpm"],
      ["Buscar", "dnf search {{paquete}}", "Busca paquetes por nombre o descripción.", "r", "rpm"],
      ["Desinstalar", "sudo dnf remove {{paquete}}", "Desinstala un paquete.", "sd", "rpm"],
    ],
  },
  {
    category: "Paquetes",
    group: "Debian/Ubuntu (apt)",
    rows: [
      ["Actualizar todo", "sudo apt update && sudo apt upgrade -y", "Actualiza la lista e instala las actualizaciones.", "s", "deb"],
      ["Instalar", "sudo apt install -y {{paquete}}", "Instala un paquete.", "s", "deb"],
      ["Buscar", "apt search {{paquete}}", "Busca paquetes por nombre o descripción.", "r", "deb"],
      ["Desinstalar", "sudo apt remove {{paquete}}", "Desinstala un paquete.", "sd", "deb"],
    ],
  },
  {
    category: "Paquetes",
    group: "Alpine (apk)",
    rows: [
      ["Actualizar todo", "sudo apk update && sudo apk upgrade", "Actualiza el índice e instala las actualizaciones.", "s", "apk"],
      ["Instalar", "sudo apk add {{paquete}}", "Instala un paquete.", "s", "apk"],
      ["Buscar", "apk search {{paquete}}", "Busca paquetes por nombre.", "r", "apk"],
      ["Desinstalar", "sudo apk del {{paquete}}", "Desinstala un paquete.", "sd", "apk"],
    ],
  },
  {
    category: "Seguridad",
    group: "Accesos",
    rows: [
      [
        "Intentos de acceso fallidos",
        'sudo journalctl -u sshd | grep -i "failed" | tail -50',
        "Últimos intentos de entrar por SSH que fallaron.",
        "rs",
      ],
      ["Llaves SSH autorizadas", "cat ~/.ssh/authorized_keys", "Llaves públicas que pueden entrar con tu usuario.", "r"],
      ["Estado de SELinux", "getenforce", "Enforcing, Permissive o Disabled.", "r"],
      ["Fail2ban", "sudo fail2ban-client status sshd", "IPs bloqueadas por fail2ban en SSH.", "rs"],
    ],
  },
  {
    category: "Web",
    group: "nginx y certificados",
    rows: [
      ["Probar configuración nginx", "sudo nginx -t", "Comprueba la configuración antes de recargar.", "rs"],
      ["Recargar nginx", "sudo systemctl reload nginx", "Aplica la configuración sin cortar conexiones.", "s"],
      ["Certificados (certbot)", "sudo certbot certificates", "Certificados y fechas de caducidad.", "rs"],
      ["Renovar certificados", "sudo certbot renew", "Renueva los certificados que estén por caducar.", "s"],
    ],
  },
  {
    category: "Git",
    group: "Repositorio",
    rows: [
      ["Estado", "git status", "Cambios pendientes en la carpeta actual.", "r"],
      ["Traer cambios", "git pull", "Descarga e integra los cambios del remoto."],
      ["Últimos commits", "git log --oneline -n {{n:15}}", "Historial resumido.", "r"],
      ["Cambiar de rama", "git checkout {{rama}}", "Cambia a otra rama."],
    ],
  },
];

// ───────── Construcción ─────────

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function swapEngine(cmd: string): string {
  return cmd.replace(/\bpodman\b/g, "docker");
}

function varsFor(command: string, docker: boolean): Record<string, CatalogVar> | undefined {
  const vars = parseVars(command);
  if (vars.length === 0) return undefined;
  const out: Record<string, CatalogVar> = {};
  for (const v of vars) {
    const hint = VAR_HINTS[v.name] ?? {};
    out[v.name] = {
      ...hint,
      suggest: hint.suggest && docker ? swapEngine(hint.suggest) : hint.suggest,
      default: v.default,
    };
  }
  return out;
}

function build(sections: Section[], docker = false): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const ids = new Set<string>();
  for (const sec of sections) {
    for (const [name, command, description, flags = "", distro] of sec.rows) {
      let id = `${slug(sec.category)}.${slug(name)}${distro ? `-${distro}` : ""}`;
      for (let n = 2; ids.has(id); n++) id = `${slug(sec.category)}.${slug(name)}-${n}`;
      ids.add(id);
      out.push({
        id,
        category: sec.category,
        group: sec.group,
        name,
        description,
        command,
        dangerous: flags.includes("d"),
        sudo: flags.includes("s"),
        readOnly: flags.includes("r"),
        interactive: flags.includes("i") || undefined,
        distro,
        vars: varsFor(command, docker),
      });
    }
  }
  return out;
}

/** Docker: mismas entradas que Podman (sin pods, Quadlet ni auto-update), más extras. */
function dockerSections(): Section[] {
  const skipGroups = new Set(["Arranque automático con systemd"]);
  const out: Section[] = [];
  for (const sec of PODMAN) {
    if (skipGroups.has(sec.group)) continue;
    const rows = sec.rows
      .filter(([, cmd]) => !/\bpodman pod\b/.test(cmd))
      .map(([name, cmd, desc, flags, distro]): Row => [
        name.replace(/Podman/g, "Docker"),
        swapEngine(cmd).replace(/:Z(\s)/g, "$1"),
        desc,
        flags,
        distro,
      ]);
    out.push({
      category: "Docker",
      group: sec.group === "Pods, volúmenes y redes" ? "Volúmenes y redes" : sec.group,
      rows,
    });
  }
  out.push({
    category: "Docker",
    group: "Servicio Docker",
    rows: [
      ["Reiniciar Docker", "sudo systemctl restart docker", "Reinicia el servicio de Docker (y sus contenedores).", "s"],
      ["Estado de Docker", "systemctl status docker --no-pager", "Si el servicio de Docker está activo.", "r"],
    ],
  });
  return out;
}

export const CATALOG: CatalogEntry[] = [...build(PODMAN), ...build(dockerSections(), true), ...build(OTHERS)];

/** Pista de variable por nombre (para "Mis comandos"). */
export function varHint(name: string): CatalogVar | undefined {
  return VAR_HINTS[name];
}
