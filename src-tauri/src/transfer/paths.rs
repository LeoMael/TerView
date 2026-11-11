//! Rutas: unir rutas remotas/locales con rutas relativas del lote y recorrer carpetas locales.

use std::path::{Component, Path, PathBuf};

/// Une una carpeta remota con una ruta relativa ("a/b.txt") usando `/`.
pub fn remote_join(base: &str, rel: &str) -> String {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return if base.is_empty() { "/".into() } else { base.to_string() };
    }
    let base = base.trim_end_matches('/');
    if base.is_empty() && !rel.is_empty() {
        // base era "/" (o vacía: tratamos como raíz).
        return format!("/{rel}");
    }
    format!("{base}/{rel}")
}

/// Último componente de una ruta remota ("/a/b/" → "b"). La raíz devuelve "".
pub fn remote_basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Padre de una ruta remota ("/a/b" → "/a", "/a" → "/", "a" → "").
pub fn remote_parent(path: &str) -> String {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => t[..i].to_string(),
        None => String::new(),
    }
}

/// Tipo de un elemento remoto según sus permisos (`st_mode`).
///
/// Ojo: `FileAttributes::is_regular()` de russh-sftp mira bits sueltos y da `true` también
/// para enlaces simbólicos y sockets; aquí se compara el tipo completo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteKind {
    Dir,
    File,
    Link,
    Other,
    /// El servidor no envió permisos.
    Unknown,
}

pub fn remote_kind(perms: Option<u32>) -> RemoteKind {
    match perms.map(|p| p & 0o170000) {
        None => RemoteKind::Unknown,
        Some(0o040000) => RemoteKind::Dir,
        Some(0o100000) => RemoteKind::File,
        Some(0o120000) => RemoteKind::Link,
        Some(0) => RemoteKind::Unknown,
        Some(_) => RemoteKind::Other,
    }
}

/// Nombre válido de un elemento remoto para crear localmente.
pub fn safe_remote_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0')
}

/// Nombre con el que se guarda en el disco local un elemento remoto (ya validado con
/// [`safe_remote_name`]). En Unix es el mismo; en Windows se adapta con [`windows_safe_name`].
pub fn local_file_name(remote_name: &str) -> String {
    if cfg!(windows) {
        windows_safe_name(remote_name)
    } else {
        remote_name.to_string()
    }
}

/// Nombres de dispositivo que Windows no deja usar como archivo (con cualquier extensión).
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹",
    "COM²", "COM³", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

/// Adapta un nombre a las reglas de Windows: `< > : " / \ | ? *` y los caracteres de control
/// pasan a `_`, se quitan puntos y espacios finales, y a los nombres reservados (`CON`, `NUL`,
/// `COM1`…, también con extensión: `nul.txt`) se les antepone `_`.
pub fn windows_safe_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = out.trim_end_matches(['.', ' ']).len();
    out.truncate(trimmed);
    if out.is_empty() {
        return "_".into();
    }
    let stem = out.split('.').next().unwrap_or("").trim_end_matches(' ');
    if WINDOWS_RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        out.insert(0, '_');
    }
    out
}

/// Clave para detectar nombres repetidos en una carpeta local (Windows no distingue mayúsculas).
pub fn local_name_key(name: &str) -> String {
    if cfg!(windows) { name.to_lowercase() } else { name.to_string() }
}

/// `nombre (2).ext`, `nombre (3).ext`… para no pisar otro elemento con el mismo nombre local.
pub fn numbered_name(name: &str, n: usize) -> String {
    match name.rfind('.').filter(|&i| i > 0) {
        Some(i) => format!("{} ({n}){}", &name[..i], &name[i..]),
        None => format!("{name} ({n})"),
    }
}

/// Objetivo de un enlace local, tal como se recrea en el servidor. En Windows los separadores
/// pasan a `/`, y los objetivos absolutos (`C:\…`, `\\?\…`, uniones de carpeta) no tienen sentido
/// en el servidor: `None`.
pub fn link_target_for_remote(target: &str) -> Option<String> {
    if !cfg!(windows) {
        return Some(target.to_string());
    }
    let t = target.replace('\\', "/");
    let bytes = t.as_bytes();
    let drive = bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
    if drive || t.starts_with('/') {
        return None;
    }
    Some(t)
}

/// Ruta relativa con `/` (componentes normales únicamente).
pub fn rel_to_slash(rel: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Nombre a mostrar para la raíz de un recorrido local.
pub fn local_root_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "raiz".into())
}

#[derive(Debug, Clone)]
pub struct LocalFile {
    /// Relativa al padre de la raíz, incluye el nombre de la raíz ("fotos/viaje/a.jpg").
    pub rel: String,
    pub path: PathBuf,
    pub size: u64,
}

/// Enlace simbólico local (se recrea en el destino con el mismo objetivo; nunca se sigue).
#[derive(Debug, Clone)]
pub struct LocalLink {
    pub rel: String,
    pub path: PathBuf,
    /// Objetivo tal cual (relativo o absoluto).
    pub target: String,
}

#[derive(Debug, Default)]
pub struct LocalPlan {
    /// Carpetas (relativas, incluye la raíz), padres antes que hijos.
    pub dirs: Vec<String>,
    pub files: Vec<LocalFile>,
    pub links: Vec<LocalLink>,
    /// (ruta relativa, mensaje) de lo que no se pudo leer.
    pub errors: Vec<(String, String)>,
    /// Elementos especiales omitidos (sockets, FIFO, dispositivos).
    pub skipped: usize,
}

/// Recorre una carpeta local sin seguir enlaces simbólicos (se devuelven aparte para
/// recrearlos; así no hay bucles). Bloqueante: usar en spawn_blocking.
pub fn walk_local(root: &Path) -> LocalPlan {
    let root_name = local_root_name(root);
    let mut plan = LocalPlan::default();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                let rel = e
                    .path()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .and_then(rel_to_slash)
                    .map(|r| join_rel(&root_name, &r))
                    .unwrap_or_else(|| root_name.clone());
                plan.errors.push((rel, local_io_message(&std::io::Error::from(e))));
                continue;
            }
        };
        let Some(sub) = entry.path().strip_prefix(root).ok().and_then(rel_to_slash) else {
            plan.skipped += 1;
            continue;
        };
        let rel = join_rel(&root_name, &sub);
        let ft = entry.file_type();
        if ft.is_dir() {
            plan.dirs.push(rel);
        } else if ft.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            plan.files.push(LocalFile {
                rel,
                path: entry.into_path(),
                size,
            });
        } else if ft.is_symlink() {
            match std::fs::read_link(entry.path()) {
                Ok(t) => match t.to_str().filter(|t| !t.is_empty()) {
                    Some(target) => match link_target_for_remote(target) {
                        Some(target) => plan.links.push(LocalLink {
                            rel,
                            path: entry.into_path(),
                            target,
                        }),
                        None => plan.errors.push((
                            rel,
                            "El enlace apunta a una ruta absoluta de este equipo; no se puede recrear en el servidor (se omite)"
                                .into(),
                        )),
                    },
                    None => plan
                        .errors
                        .push((rel, "El destino del enlace simbólico no es un nombre válido".into())),
                },
                Err(e) => plan.errors.push((rel, local_io_message(&e))),
            }
        } else {
            plan.skipped += 1;
        }
    }
    plan
}

pub fn join_rel(prefix: &str, rel: &str) -> String {
    match (prefix.is_empty(), rel.is_empty()) {
        (true, _) => rel.to_string(),
        (_, true) => prefix.to_string(),
        _ => format!("{prefix}/{rel}"),
    }
}

/// Mensaje en español para un error de disco local.
pub fn local_io_message(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::NotFound => "El archivo local no existe".into(),
        K::PermissionDenied => "Permiso denegado (equipo local)".into(),
        K::StorageFull => "No queda espacio en el disco local".into(),
        K::AlreadyExists => "Ya existe un elemento con ese nombre (equipo local)".into(),
        K::IsADirectory => "Es una carpeta (equipo local)".into(),
        _ => format!("Error de archivos local: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_join_cases() {
        assert_eq!(remote_join("/var/www", "a/b.txt"), "/var/www/a/b.txt");
        assert_eq!(remote_join("/var/www/", "a"), "/var/www/a");
        assert_eq!(remote_join("/", "a"), "/a");
        assert_eq!(remote_join("/x", ""), "/x");
        assert_eq!(remote_join("rel", "a"), "rel/a");
    }

    #[test]
    fn remote_names() {
        assert_eq!(remote_basename("/a/b/"), "b");
        assert_eq!(remote_basename("/a/b.txt"), "b.txt");
        assert_eq!(remote_basename("/"), "");
        assert_eq!(remote_parent("/a/b"), "/a");
        assert_eq!(remote_parent("/a"), "/");
        assert!(safe_remote_name("x.txt"));
        assert!(!safe_remote_name(".."));
        assert!(!safe_remote_name("a/b"));
    }

    #[test]
    fn remote_kinds() {
        assert_eq!(remote_kind(Some(0o040755)), RemoteKind::Dir);
        assert_eq!(remote_kind(Some(0o100644)), RemoteKind::File);
        assert_eq!(remote_kind(Some(0o120777)), RemoteKind::Link);
        assert_eq!(remote_kind(Some(0o140755)), RemoteKind::Other);
        assert_eq!(remote_kind(Some(0o644)), RemoteKind::Unknown);
        assert_eq!(remote_kind(None), RemoteKind::Unknown);
    }

    #[test]
    fn windows_names() {
        assert_eq!(windows_safe_name("informe.txt"), "informe.txt");
        assert_eq!(windows_safe_name("a:b*c?.log"), "a_b_c_.log");
        assert_eq!(windows_safe_name("x<y>|\"z\\w"), "x_y___z_w");
        assert_eq!(windows_safe_name("tab\there"), "tab_here");
        assert_eq!(windows_safe_name("final. . "), "final");
        assert_eq!(windows_safe_name("..."), "_");
        assert_eq!(windows_safe_name("CON"), "_CON");
        assert_eq!(windows_safe_name("nul.txt"), "_nul.txt");
        assert_eq!(windows_safe_name("Com1.tar.gz"), "_Com1.tar.gz");
        assert_eq!(windows_safe_name("console.log"), "console.log");
        assert_eq!(windows_safe_name("LPT10"), "LPT10");
        assert_eq!(numbered_name("a.txt", 2), "a (2).txt");
        assert_eq!(numbered_name(".bashrc", 2), ".bashrc (2)");
        assert_eq!(numbered_name("carpeta", 3), "carpeta (3)");
        if cfg!(windows) {
            assert_eq!(local_file_name("a:b"), "a_b");
            assert_eq!(link_target_for_remote(r"..\x\y").as_deref(), Some("../x/y"));
            assert_eq!(link_target_for_remote(r"C:\x"), None);
        } else {
            assert_eq!(local_file_name("a:b"), "a:b");
            assert_eq!(link_target_for_remote("/etc/hosts").as_deref(), Some("/etc/hosts"));
        }
    }

    #[test]
    fn rel_slash() {
        assert_eq!(rel_to_slash(Path::new("a/b/c.txt")).as_deref(), Some("a/b/c.txt"));
        assert_eq!(rel_to_slash(Path::new("")).as_deref(), Some(""));
        assert_eq!(rel_to_slash(Path::new("../a")), None);
        assert_eq!(join_rel("fotos", ""), "fotos");
        assert_eq!(join_rel("fotos", "a.jpg"), "fotos/a.jpg");
        assert_eq!(join_rel("", "a.jpg"), "a.jpg");
    }

    #[test]
    fn walker_lists_tree() {
        let root = std::env::temp_dir().join(format!("terview-walk-{}", uuid::Uuid::new_v4()));
        let fotos = root.join("fotos");
        std::fs::create_dir_all(fotos.join("viaje")).unwrap();
        std::fs::create_dir_all(fotos.join("vacia")).unwrap();
        std::fs::write(fotos.join("a.jpg"), b"12345").unwrap();
        std::fs::write(fotos.join("viaje/b.jpg"), b"xy").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(fotos.join("viaje"), fotos.join("enlace")).unwrap();

        let plan = walk_local(&fotos);
        assert_eq!(plan.dirs, vec!["fotos", "fotos/vacia", "fotos/viaje"]);
        let files: Vec<(&str, u64)> = plan.files.iter().map(|f| (f.rel.as_str(), f.size)).collect();
        assert_eq!(files, vec![("fotos/a.jpg", 5), ("fotos/viaje/b.jpg", 2)]);
        assert!(plan.errors.is_empty());
        #[cfg(unix)]
        {
            assert_eq!(plan.links.len(), 1);
            assert_eq!(plan.links[0].rel, "fotos/enlace");
            assert_eq!(plan.links[0].target, fotos.join("viaje").to_string_lossy());
            assert_eq!(plan.skipped, 0);
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
