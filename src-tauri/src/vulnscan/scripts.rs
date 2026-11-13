//! Scripts POSIX (solo lectura) que se ejecutan en el servidor, fase por fase.
//!
//! Están aquí (y no en la interfaz) para que la interfaz, las pruebas y el futuro servidor MCP usen
//! exactamente los mismos. La interfaz los pide con `vulnscan_script` y los ejecuta con `runScript`
//! (con o sin sudo); la salida vuelve al motor en bruto y la leen los parsers de `parse/`.
//!
//! Formato de salida: secciones que empiezan con una línea `@@nombre` y terminan en `@@end`.
//! Ningún script cambia nada en el servidor: listan, leen archivos o montan una imagen y la desmontan.

use serde::{Deserialize, Serialize};

use super::model::{DistroTool, Engine};

/// Cita un argumento para un shell POSIX (`'…'`, con `'\''` para las comillas internas).
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Formato de `rpm -qa`: nombre, epoch, versión, release, arquitectura, rpm fuente y vendedor.
pub const RPM_QF: &str = r"%{NAME}\t%{EPOCHNUM}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\t%{SOURCERPM}\t%{VENDOR}\n";

/// Formato de `dpkg-query -W`: estado, paquete, versión, fuente, versión fuente y arquitectura.
pub const DPKG_FMT: &str = r"${db:Status-Abbrev}\t${Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\n";

/// Plantilla de Trivy: una línea por hallazgo (el JSON completo pasa de 2 MB en imágenes grandes).
/// Columnas: clase, id, paquete, instalada, arreglada, gravedad, estado y ruta (para librerías).
pub const TRIVY_TEMPLATE: &str = "{{- range . }}{{ $c := .Class }}{{- range .Vulnerabilities }}\n\
{{ $c }}\t{{ .VulnerabilityID }}\t{{ .PkgName }}\t{{ .InstalledVersion }}\t{{ .FixedVersion }}\t{{ .Severity }}\t{{ .Status }}\t{{ .PkgPath }}\
{{- end }}{{- end }}\n";

const PATH_LINE: &str = "PATH=$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin; export PATH; LC_ALL=C; export LC_ALL";

/// Qué gestor de paquetes hay (el primero que responde).
const PM_DETECT: &str = r#"if command -v dpkg-query >/dev/null 2>&1; then PM=dpkg
elif command -v rpm >/dev/null 2>&1 && rpm -q rpm >/dev/null 2>&1; then PM=rpm
elif command -v apk >/dev/null 2>&1; then PM=apk
elif command -v rpm >/dev/null 2>&1; then PM=rpm
else PM=none; fi"#;

/// Fase 1: distro, kernel, usuario, gestor de paquetes y herramientas disponibles. Sin root.
pub fn detect_script() -> String {
    format!(
        r#"{PATH_LINE}
echo @@os; cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null
echo @@kernel; uname -srm 2>/dev/null
echo @@id; id -un 2>/dev/null; id -u 2>/dev/null
echo @@container
if [ -f /run/.containerenv ] || [ -f /.dockerenv ]; then echo yes; else echo no; fi
{PM_DETECT}
echo @@pm; echo $PM
echo @@tools
for t in trivy debsecan pro dnf dnf5 yum zypper podman docker runuser sudo rpm; do
  p=$(command -v $t 2>/dev/null) && printf '%s\t%s\n' "$t" "$p"
done
echo @@dnf
if command -v dnf >/dev/null 2>&1; then dnf --version 2>/dev/null | head -n1; fi
echo @@trivy
if command -v trivy >/dev/null 2>&1; then trivy --version 2>/dev/null | head -n1; fi
echo @@pro
if command -v pro >/dev/null 2>&1; then
  if pro status --format json 2>/dev/null | grep -q '"attached": *true'; then echo attached; else echo free; fi
fi
echo @@docker
if command -v docker >/dev/null 2>&1 && docker info --format '{{{{.ServerVersion}}}}' >/dev/null 2>&1; then echo ok; else echo no; fi
echo @@end
"#
    )
}

/// Fase 1b (solo con root o sudo): cuentas con almacén de contenedores propio.
/// Columnas: usuario, uid, home, podman (yes/no), docker rootless (yes/no), /run/user/uid (yes/no).
pub fn users_script() -> String {
    format!(
        r#"{PATH_LINE}
echo @@users
{{ getent passwd 2>/dev/null || cat /etc/passwd; }} | while IFS=: read -r u x uid gid g home sh; do
  case $uid in ''|*[!0-9]*) continue ;; esac
  [ "$uid" -ge 1000 ] || continue
  [ "$uid" -ge 65534 ] && continue
  p=no; d=no; r=no
  [ -d "$home/.local/share/containers/storage" ] && p=yes
  [ -d "$home/.local/share/docker" ] && d=yes
  [ -d "/run/user/$uid" ] && r=yes
  [ $p = yes ] || [ $d = yes ] || continue
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$u" "$uid" "$home" "$p" "$d" "$r"
done
echo @@root
if [ -d /var/lib/containers/storage ] && command -v podman >/dev/null 2>&1; then echo podman; fi
if command -v docker >/dev/null 2>&1 && docker info --format '{{{{.ServerVersion}}}}' >/dev/null 2>&1; then echo docker; fi
echo @@end
"#
    )
}

/// Programas clave: nombre y cómo se pide su versión.
const PROGRAMS: &[(&str, &str)] = &[
    ("sudo", "-V 2>/dev/null"),
    ("ssh", "-V 2>&1"),
    ("sshd", "-V 2>&1"),
    ("nginx", "-v 2>&1"),
    ("caddy", "version 2>/dev/null"),
    ("podman", "--version 2>/dev/null"),
    ("docker", "--version 2>/dev/null"),
    ("node", "--version 2>/dev/null"),
    ("python3", "--version 2>&1"),
    ("php", "-v 2>/dev/null"),
    ("java", "-version 2>&1"),
    ("httpd", "-v 2>/dev/null"),
    ("apache2", "-v 2>/dev/null"),
    ("postgres", "--version 2>/dev/null"),
];

/// Fase 2: paquetes del sistema, programas clave (con su paquete dueño) y runtimes de `$HOME`. Sin root.
pub fn inventory_script() -> String {
    let mut progs = String::new();
    for (name, args) in PROGRAMS {
        progs.push_str(&format!(
            "p=$(command -v {name} 2>/dev/null) && {{ r=$(readlink -f \"$p\" 2>/dev/null || echo \"$p\"); \
             v=$(\"$p\" {args} | head -n1); printf '%s\\t%s\\t%s\\t%s\\n' {name} \"$r\" \"$(own \"$r\" \"$p\")\" \"$v\"; }}\n"
        ));
    }
    format!(
        r#"{PATH_LINE}
{PM_DETECT}
echo @@pm; echo $PM
echo @@pkgs
case $PM in
  dpkg) dpkg-query -W -f='{DPKG_FMT}' 2>/dev/null ;;
  rpm) rpm -qa --qf '{RPM_QF}' 2>/dev/null ;;
  apk) apk list -I 2>/dev/null ;;
esac
# Paquete dueño de un binario y su vendedor (RPM) o mantenedor (dpkg): «paquete<TAB>vendedor».
own() {{
  for f in "$1" "$2"; do
    [ -n "$f" ] || continue
    case $PM in
      dpkg)
        o=$(dpkg -S "$f" 2>/dev/null | head -n1 | cut -d: -f1)
        [ -n "$o" ] || o=$(dpkg -S "$(echo "$f" | sed 's#^/usr/#/#')" 2>/dev/null | head -n1 | cut -d: -f1)
        if [ -n "$o" ]; then printf '%s\t%s' "$o" "$(dpkg-query -W -f='${{Maintainer}}' "$o" 2>/dev/null)"; return; fi ;;
      rpm)
        if o=$(rpm -qf --qf '%{{NAME}}\t%{{VENDOR}}\n' "$f" 2>/dev/null); then printf '%s' "$(echo "$o" | head -n1)"; return; fi ;;
      apk)
        o=$(apk info --who-owns "$f" 2>/dev/null | sed -n 's/.* is owned by //p' | head -n1)
        if [ -n "$o" ]; then printf '%s\t' "$o"; return; fi ;;
    esac
  done
  printf '\t'
}}
echo @@tools
{progs}echo @@home
for d in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/tools/image/node/*/bin/node \
  "$HOME"/.pyenv/versions/*/bin/python3 "$HOME"/.sdkman/candidates/java/*/bin/java \
  /usr/local/bin/node /usr/local/bin/python3 /usr/local/bin/php /opt/*/bin/java /opt/*/bin/node; do
  [ -x "$d" ] || continue
  case $d in
    */node) v=$("$d" --version 2>/dev/null | head -n1); k=node ;;
    */python3) v=$("$d" --version 2>&1 | head -n1); k=python3 ;;
    */java) v=$("$d" -version 2>&1 | head -n1); k=java ;;
    */php) v=$("$d" -v 2>/dev/null | head -n1); k=php ;;
    *) continue ;;
  esac
  printf '%s\t%s\t%s\t%s\n' "$k" "$d" "$(own "$d" "")" "$v"
done
echo @@end
"#
    )
}

/// Fase 3: herramienta de seguridad de la distro (`codename` solo para debsecan). Sin root.
pub fn distro_script(tool: DistroTool, codename: &str) -> String {
    let body = match tool {
        DistroTool::Dnf4 | DistroTool::Yum => {
            let cmd = if tool == DistroTool::Yum { "yum" } else { "dnf" };
            let sec = if tool == DistroTool::Yum { "security" } else { "--security" };
            format!(
                "echo @@list\n{cmd} -q updateinfo list {sec} 2>/dev/null\necho \"@@rc $?\"\n\
                 echo @@info\n{cmd} -q updateinfo info {sec} 2>/dev/null\necho \"@@rc $?\""
            )
        }
        DistroTool::Dnf5 => "echo @@list\ndnf -q advisory list --security --json 2>/dev/null\necho \"@@rc $?\"\n\
             echo @@info\ndnf -q advisory info --security --json 2>/dev/null\necho \"@@rc $?\""
            .to_string(),
        DistroTool::Debsecan => {
            let suite = if codename.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !codename.is_empty() {
                format!(" --suite {codename}")
            } else {
                String::new()
            };
            format!("echo @@debsecan\ndebsecan{suite} --format detail 2>/dev/null\necho \"@@rc $?\"")
        }
        DistroTool::Pro => "echo @@pro\npro api u.pro.security.cves.v1 2>/dev/null\necho \"@@rc $?\"".to_string(),
        DistroTool::Zypper => "echo @@zypper\nzypper --non-interactive --xmlout list-patches --category security 2>/dev/null\n\
             echo \"@@rc $?\""
            .to_string(),
    };
    format!("{PATH_LINE}\n{body}\necho @@end\n")
}

/// Usuario dueño de un almacén de contenedores (para entrar como él con `runuser`/`sudo -u`/`su`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCtx {
    pub name: String,
    pub uid: u32,
    pub home: String,
}

fn valid_user(u: &UserCtx) -> bool {
    !u.name.is_empty()
        && u.name.len() <= 32
        && u.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !u.name.starts_with('-')
        && u.home.starts_with('/')
        && !u.home.contains(['\n', '\0'])
}

/// Ejecuta `inner` (texto de un script) con el shell. Si `user` es otro usuario (estamos como root),
/// se entra como él con `runuser -u` (util-linux), `sudo -u -H` o `su -s /bin/sh` (busybox), con su
/// HOME (sin él, Podman busca el almacén en el de root) y su XDG_RUNTIME_DIR si existe y es suyo.
/// `unshare` = envolver en `podman unshare` (para montar imágenes sin ser root).
fn run_as(user: Option<&UserCtx>, unshare: bool, inner: &str) -> String {
    let prefix = if unshare { "podman unshare sh -c" } else { "sh -c" };
    let Some(u) = user.filter(|u| valid_user(u)) else {
        return format!("TV_INNER={}\n{prefix} \"$TV_INNER\"", sh_quote(inner));
    };
    let name = sh_quote(&u.name);
    let home = sh_quote(&u.home);
    let uid = u.uid;
    format!(
        r#"TV_INNER={inner}
export TV_INNER
x=
if [ -d /run/user/{uid} ] && [ "$(stat -c %u /run/user/{uid} 2>/dev/null)" = {uid} ]; then x=XDG_RUNTIME_DIR=/run/user/{uid}; fi
cd / 2>/dev/null
if command -v runuser >/dev/null 2>&1; then
  runuser -u {name} -- env -u XDG_RUNTIME_DIR HOME={home} $x {prefix} "$TV_INNER"
elif command -v sudo >/dev/null 2>&1; then
  sudo -u {name} -H env -u XDG_RUNTIME_DIR HOME={home} $x {prefix} "$TV_INNER"
else
  su -s /bin/sh {name} -c "HOME={home_inner}; export HOME; ${{x:+export $x;}} {prefix} \"\$TV_INNER\""
fi"#,
        inner = sh_quote(inner),
        home_inner = u.home.replace(['"', '$', '`', '\\'], ""),
    )
}

/// Fase 4a: imágenes y contenedores de un motor (de un usuario, o del conectado / de root).
/// `@@images`: id corto, repositorio:etiqueta. `@@containers`: id, nombre, id de imagen, estado.
pub fn images_list_script(engine: Engine, user: Option<&UserCtx>) -> String {
    let inner = match engine {
        Engine::Podman => "echo @@images\n\
             podman images --format '{{.ID}}\t{{.Repository}}:{{.Tag}}' 2>&1\n\
             echo @@containers\n\
             podman ps -a --format '{{.ID}}\t{{.Names}}\t{{.ImageID}}\t{{.State}}' 2>&1\n\
             echo @@end"
            .to_string(),
        Engine::Docker => {
            let host = docker_host(user);
            format!(
                "{host}echo @@images\n\
                 docker images --no-trunc --format '{{{{.ID}}}}\t{{{{.Repository}}}}:{{{{.Tag}}}}' 2>&1\n\
                 echo @@containers\n\
                 docker ps -aq --no-trunc 2>/dev/null | xargs -r docker inspect --format '{{{{.Id}}}}\t{{{{.Name}}}}\t{{{{.Image}}}}\t{{{{.State.Status}}}}' 2>&1\n\
                 echo @@end"
            )
        }
    };
    let body = match engine {
        // Docker de otro usuario: su demonio rootless, por su socket (no hace falta entrar como él).
        Engine::Docker => format!("sh -c {}", sh_quote(&inner)),
        Engine::Podman => run_as(user, false, &inner),
    };
    format!("{PATH_LINE}\n{body}\n")
}

/// «Actualizar imagen» (lo único del escáner que cambia algo, y solo tras confirmar en la interfaz):
/// ejecuta `inner` (los comandos ya citados que se le mostraron al usuario) como el dueño de la imagen.
/// - `user` = None: tal cual (el usuario conectado, o root si la interfaz eleva).
/// - Podman de otro usuario: se entra como él igual que al analizar (`run_as`: su HOME y su
///   XDG_RUNTIME_DIR, necesario también para `systemctl --user`).
/// - Docker rootless de otro usuario: su demonio, por su socket (como al analizar).
///
/// Si el usuario no es válido no se ejecuta nada (nunca se cae a root por error). Sale con el código de `inner`.
pub fn as_owner_script(engine: Engine, user: Option<&UserCtx>, inner: &str) -> String {
    let inner = format!("{PATH_LINE}\n{inner}");
    let body = match user {
        None => inner,
        Some(u) if !valid_user(u) => "echo 'Usuario no válido' >&2\nexit 1".to_string(),
        Some(u) => match engine {
            Engine::Podman => run_as(Some(u), false, &inner),
            Engine::Docker => format!(
                "s=/run/user/{uid}/docker.sock\n\
                 if [ ! -S \"$s\" ]; then echo 'Docker rootless de este usuario: su demonio está parado' >&2; exit 1; fi\n\
                 DOCKER_HOST=unix://$s; export DOCKER_HOST\n\
                 sh -c {}",
                sh_quote(&inner),
                uid = u.uid
            ),
        },
    };
    format!("{PATH_LINE}\n{body}\n")
}

/// Docker rootless de otro usuario: su socket en /run/user/<uid>.
fn docker_host(user: Option<&UserCtx>) -> String {
    match user.filter(|u| valid_user(u)) {
        Some(u) => format!(
            "s=/run/user/{uid}/docker.sock\n\
             if [ ! -S \"$s\" ]; then echo '@@error Docker rootless de este usuario: demonio parado'; echo @@end; exit 0; fi\n\
             DOCKER_HOST=unix://$s; export DOCKER_HOST\n",
            uid = u.uid
        ),
        None => String::new(),
    }
}

/// Lectura de la base de paquetes dentro de `$m` (raíz de la imagen montada o copiada).
fn read_pkgdb() -> String {
    format!(
        r#"rd() {{ f="$m/$1"; i=0
  while [ -L "$f" ] && [ $i -lt 8 ]; do l=$(readlink "$f"); case $l in /*) f="$m$l" ;; *) f="$(dirname "$f")/$l" ;; esac; i=$((i+1)); done
  cat "$f" 2>/dev/null; }}
echo @@os; rd usr/lib/os-release || rd etc/os-release
if [ -s "$m/var/lib/dpkg/status" ] || [ -d "$m/var/lib/dpkg/status.d" ]; then
  echo @@dpkgstatus
  {{ cat "$m/var/lib/dpkg/status" 2>/dev/null; for f in "$m"/var/lib/dpkg/status.d/*; do [ -f "$f" ] && {{ cat "$f"; echo; }}; done; }} | grep -E '^(Package|Status|Version|Source|Architecture):|^$'
elif [ -s "$m/lib/apk/db/installed" ]; then
  echo @@apkdb; grep -E '^[PVoA]:|^$' "$m/lib/apk/db/installed"
elif [ -e "$m/var/lib/rpm" ] || [ -e "$m/usr/lib/sysimage/rpm" ]; then
  db="$m/usr/lib/sysimage/rpm"
  [ -e "$db/rpmdb.sqlite" ] || [ -e "$db/Packages" ] || [ -e "$db/Packages.db" ] || db="$m/var/lib/rpm"
  if command -v rpm >/dev/null 2>&1; then echo "@@method rpm --dbpath"; echo @@rpm; rpm --dbpath "$db" -qa --qf '{RPM_QF}' 2>/dev/null
  else echo @@needrpm; fi
else echo @@nopkgdb; fi"#
    )
}

/// Fase 4b: paquetes de una imagen sin arrancar sus servicios (ver PENDIENTES 10.5).
///
/// - Podman: `podman image mount` (dentro de `podman unshare` si no es root) y se lee la base de
///   paquetes como archivos; RPM con el `rpm` del anfitrión (`--dbpath`). Si el anfitrión no tiene `rpm`,
///   se ejecuta SOLO el `rpm` de la imagen, sin red (`podman run --network=none --entrypoint rpm`).
/// - Docker: `docker create` (no arranca nada) + `docker cp` de los archivos + `docker rm`.
/// - `trivy` = usar Trivy si está (sobre la imagen montada o con `trivy image` en Docker).
pub fn image_script(engine: Engine, user: Option<&UserCtx>, image_id: &str, trivy: bool) -> String {
    let id: String = image_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == ':').collect();
    let id = id.trim_start_matches("sha256:").to_string();
    let q_tpl = sh_quote(TRIVY_TEMPLATE);
    let trivy_flag = if trivy { 1 } else { 0 };
    match engine {
        Engine::Podman => {
            let inner = format!(
                r#"img={id}
m=$(podman image mount "$img" 2>&1) || {{ echo "@@error no se pudo montar la imagen: $m"; echo @@end; exit 0; }}
echo "@@method montada"
if [ {trivy_flag} = 1 ] && command -v trivy >/dev/null 2>&1; then
  echo @@os; cat "$m/usr/lib/os-release" 2>/dev/null || cat "$m/etc/os-release" 2>/dev/null
  echo @@trivyver; trivy --version 2>/dev/null | head -n1
  echo @@trivy; trivy rootfs --quiet --scanners vuln --format template --template {q_tpl} "$m" 2>/dev/null; echo "@@rc $?"
else
{pkgdb}
fi
podman image unmount "$img" >/dev/null 2>&1
echo @@end"#,
                pkgdb = read_pkgdb(),
            );
            // Como root no hace falta `podman unshare`; como usuario sí («must execute podman unshare first»).
            let mount = run_as(user, true, &inner);
            let mount_root = run_as(None, false, &inner);
            let fallback = run_as(
                user,
                false,
                &format!(
                    "echo '@@method rpm de la imagen'; echo @@rpm; podman run --rm --network=none --entrypoint rpm {id} -qa --qf '{RPM_QF}' 2>/dev/null; echo @@end"
                ),
            );
            let mount_cmd = if user.is_none() {
                format!("if [ \"$(id -u)\" = 0 ]; then\n{mount_root}\nelse\n{mount}\nfi")
            } else {
                mount
            };
            format!(
                "{PATH_LINE}\nout=$(\n{mount_cmd}\n)\nprintf '%s\\n' \"$out\"\ncase $out in *@@needrpm*)\n{fallback}\n;; esac\n"
            )
        }
        Engine::Docker => {
            let host = docker_host(user);
            format!(
                r#"{PATH_LINE}
{host}img={id}
if [ {trivy_flag} = 1 ] && command -v trivy >/dev/null 2>&1; then
  c=$(docker create --entrypoint /bin/true "$img" 2>/dev/null) && {{ m=$(mktemp -d); for f in usr/lib/os-release etc/os-release; do docker cp "$c:/$f" - 2>/dev/null | tar -xOf - 2>/dev/null && break; done > "$m/os"; echo @@os; cat "$m/os"; rm -rf "$m"; docker rm "$c" >/dev/null 2>&1; }}
  echo "@@method trivy image"
  echo @@trivyver; trivy --version 2>/dev/null | head -n1
  echo @@trivy; trivy image --quiet --scanners vuln --format template --template {q_tpl} "$img" 2>/dev/null; echo "@@rc $?"
  echo @@end; exit 0
fi
c=$(docker create --entrypoint /bin/true "$img" 2>&1) || {{ echo "@@error no se pudo preparar la imagen: $c"; echo @@end; exit 0; }}
m=$(mktemp -d)
get() {{ mkdir -p "$m/$(dirname "$1")"; docker cp "$c:/$1" - 2>/dev/null | tar -xf - -C "$m/$(dirname "$1")" 2>/dev/null; }}
for f in usr/lib/os-release etc/os-release var/lib/dpkg/status var/lib/dpkg/status.d lib/apk/db/installed usr/lib/sysimage/rpm var/lib/rpm; do get "$f"; done
echo "@@method docker cp"
{pkgdb}
rm -rf "$m"
docker rm "$c" >/dev/null 2>&1
echo @@end
"#,
                pkgdb = read_pkgdb().replace(
                    "else echo @@needrpm; fi",
                    &format!(
                        "else echo '@@method rpm de la imagen'; echo @@rpm; docker run --rm --network=none --entrypoint rpm \"$img\" -qa --qf '{RPM_QF}' 2>/dev/null; fi"
                    )
                ),
            )
        }
    }
}
