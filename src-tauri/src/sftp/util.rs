//! Utilidades del módulo SFTP: errores, permisos estilo `ls -l`, orden natural y rutas.

use std::cmp::Ordering;
use std::io;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, StatusCode};

use crate::error::AppError;
use crate::types::{FileEntry, FileKind};

// ───────────────────────── Errores ─────────────────────────

/// Error interno de una operación: distingue "el canal murió" (se reabre y reintenta)
/// de un error normal que se devuelve a la interfaz.
#[derive(Debug)]
pub enum Fail {
    Channel(String),
    App(AppError),
}

impl From<AppError> for Fail {
    fn from(e: AppError) -> Self {
        Fail::App(e)
    }
}

impl Fail {
    pub fn into_app(self) -> AppError {
        match self {
            Fail::App(e) => e,
            Fail::Channel(msg) => AppError::Sftp(format!("se perdió el canal SFTP ({msg})")),
        }
    }
}

pub type OpResult<T> = Result<T, Fail>;

/// ¿Es un código de estado SFTP concreto?
pub fn is_status(e: &SftpError, code: StatusCode) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == code)
}

/// Convierte un error de russh-sftp en `Fail`, con la ruta afectada para el mensaje.
pub fn map_sftp(e: SftpError, path: &str) -> Fail {
    match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => Fail::App(AppError::NotFound(path.to_string())),
            StatusCode::PermissionDenied => Fail::App(AppError::Sftp(format!("permiso denegado en «{path}»"))),
            StatusCode::Failure => {
                let detail = if s.error_message.is_empty() || s.error_message.eq_ignore_ascii_case("failure") {
                    String::new()
                } else {
                    format!(": {}", s.error_message)
                };
                Fail::App(AppError::Sftp(format!("la operación falló en «{path}»{detail}")))
            }
            StatusCode::OpUnsupported => {
                Fail::App(AppError::Sftp("el servidor no admite esta operación".to_string()))
            }
            StatusCode::BadMessage => Fail::App(AppError::Sftp("el servidor rechazó la petición (mensaje no válido)".to_string())),
            StatusCode::Eof => Fail::App(AppError::Sftp(format!("fin de archivo inesperado en «{path}»"))),
            StatusCode::NoConnection | StatusCode::ConnectionLost => Fail::Channel(s.status_code.to_string()),
            StatusCode::Ok => Fail::App(AppError::Sftp("respuesta inesperada del servidor".to_string())),
        },
        SftpError::Timeout => Fail::App(AppError::Sftp("el servidor no respondió a tiempo".to_string())),
        SftpError::Limited(m) => Fail::App(AppError::Sftp(format!("límite del servidor excedido: {m}"))),
        SftpError::IO(m) => Fail::Channel(m),
        SftpError::UnexpectedPacket => Fail::Channel("paquete inesperado".to_string()),
        SftpError::UnexpectedBehavior(m) => Fail::Channel(m),
    }
}

/// Errores de E/S de `File` (AsyncRead/AsyncWrite): pueden envolver un error SFTP.
pub fn map_io(e: io::Error, path: &str) -> Fail {
    let inner = e.get_ref().and_then(|i| i.downcast_ref::<SftpError>()).cloned();
    match inner {
        Some(se) => map_sftp(se, path),
        None if e.kind() == io::ErrorKind::TimedOut => {
            Fail::App(AppError::Sftp("el servidor no respondió a tiempo".to_string()))
        }
        None => Fail::App(AppError::Sftp(format!("error al acceder a «{path}»: {e}"))),
    }
}

/// `.ctx(path)` para convertir resultados de russh-sftp con la ruta en el mensaje.
pub trait Ctx<T> {
    fn ctx(self, path: &str) -> OpResult<T>;
}

impl<T> Ctx<T> for Result<T, SftpError> {
    fn ctx(self, path: &str) -> OpResult<T> {
        self.map_err(|e| map_sftp(e, path))
    }
}

impl<T> Ctx<T> for Result<T, io::Error> {
    fn ctx(self, path: &str) -> OpResult<T> {
        self.map_err(|e| map_io(e, path))
    }
}

// ───────────────────────── Permisos y entradas ─────────────────────────

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;
const S_IFREG: u32 = 0o100000;
const S_IFCHR: u32 = 0o020000;
const S_IFBLK: u32 = 0o060000;
const S_IFIFO: u32 = 0o010000;
const S_IFSOCK: u32 = 0o140000;

pub fn kind_of(mode: Option<u32>) -> FileKind {
    match mode.map(|m| m & S_IFMT) {
        Some(S_IFDIR) => FileKind::Dir,
        Some(S_IFLNK) => FileKind::Symlink,
        Some(S_IFREG) => FileKind::File,
        _ => FileKind::Other,
    }
}

/// "drwxr-xr-x", "lrwxrwxrwx", "-rwsr-xr-t"…
pub fn permissions_str(mode: Option<u32>) -> String {
    let Some(m) = mode else {
        return "?---------".to_string();
    };
    let t = match m & S_IFMT {
        S_IFDIR => 'd',
        S_IFLNK => 'l',
        S_IFREG => '-',
        S_IFCHR => 'c',
        S_IFBLK => 'b',
        S_IFIFO => 'p',
        S_IFSOCK => 's',
        _ => '?',
    };
    let bit = |mask: u32, c: char| if m & mask != 0 { c } else { '-' };
    let special = |x: u32, s: u32, lower: char, upper: char| match (m & x != 0, m & s != 0) {
        (true, true) => lower,
        (false, true) => upper,
        (true, false) => 'x',
        (false, false) => '-',
    };
    let mut out = String::with_capacity(10);
    out.push(t);
    out.push(bit(0o400, 'r'));
    out.push(bit(0o200, 'w'));
    out.push(special(0o100, 0o4000, 's', 'S'));
    out.push(bit(0o040, 'r'));
    out.push(bit(0o020, 'w'));
    out.push(special(0o010, 0o2000, 's', 'S'));
    out.push(bit(0o004, 'r'));
    out.push(bit(0o002, 'w'));
    out.push(special(0o001, 0o1000, 't', 'T'));
    out
}

/// Construye un `FileEntry` a partir de los atributos de `lstat`
/// (y, si es symlink, de los del destino).
pub fn make_entry(name: String, path: String, attrs: &FileAttributes, target: Option<&FileAttributes>) -> FileEntry {
    let kind = kind_of(attrs.permissions);
    let is_dir_link = kind == FileKind::Symlink && target.is_some_and(|t| kind_of(t.permissions) == FileKind::Dir);
    // Para enlaces a archivos mostramos el tamaño del destino (lo que se descargaría).
    let size = match (kind, target) {
        (FileKind::Symlink, Some(t)) if !is_dir_link => t.size.unwrap_or(0),
        _ => attrs.size.unwrap_or(0),
    };
    FileEntry {
        name,
        path,
        kind,
        is_dir_link,
        size,
        modified: attrs.mtime.map(u64::from),
        permissions: attrs.permissions.map(|p| p & 0o7777),
        permissions_str: permissions_str(attrs.permissions),
        uid: attrs.uid,
        gid: attrs.gid,
    }
}

// ───────────────────────── Orden ─────────────────────────

/// Comparación "natural" sin distinguir mayúsculas: "a2" < "a10".
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let ta = na.trim_start_matches('0');
                let tb = nb.trim_start_matches('0');
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(ca), Some(cb)) => {
                let la = ca.to_lowercase();
                let lb = cb.to_lowercase();
                let ord = la.cmp(lb);
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
    // Empate sin mayúsculas: desempata de forma estable.
    a.cmp(b)
}

/// Carpetas (y enlaces a carpetas) primero; luego orden natural por nombre.
pub fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let da = a.kind == FileKind::Dir || a.is_dir_link;
        let db = b.kind == FileKind::Dir || b.is_dir_link;
        db.cmp(&da).then_with(|| natural_cmp(&a.name, &b.name))
    });
}

// ───────────────────────── Rutas ─────────────────────────

/// Quita barras finales repetidas ("/a/b/" → "/a/b"; "/" se queda).
pub fn normalize(path: &str) -> String {
    let t = path.trim_end_matches('/');
    if t.is_empty() {
        if path.starts_with('/') { "/".to_string() } else { String::new() }
    } else {
        t.to_string()
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", dir.trim_end_matches('/'))
    }
}

pub fn basename(path: &str) -> String {
    let p = path.trim_end_matches('/');
    let name = match p.rfind('/') {
        Some(i) => &p[i + 1..],
        None => p,
    };
    if name.is_empty() { "/".to_string() } else { name.to_string() }
}

pub fn parent(path: &str) -> String {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => p[..i].to_string(),
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn perms() {
        assert_eq!(permissions_str(Some(0o040755)), "drwxr-xr-x");
        assert_eq!(permissions_str(Some(0o120777)), "lrwxrwxrwx");
        assert_eq!(permissions_str(Some(0o100644)), "-rw-r--r--");
        assert_eq!(permissions_str(Some(0o104755)), "-rwsr-xr-x");
        assert_eq!(permissions_str(Some(0o041777)), "drwxrwxrwt");
        assert_eq!(permissions_str(Some(0o101644)), "-rw-r--r-T");
    }

    #[test]
    fn natural() {
        let mut v = vec!["file10", "File2", "file1", "a", "B", "file02b"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["a", "B", "file1", "File2", "file02b", "file10"]);
    }

    #[test]
    fn paths() {
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/x/", "a"), "/x/a");
        assert_eq!(basename("/x/y.txt"), "y.txt");
        assert_eq!(basename("/"), "/");
        assert_eq!(parent("/x/y"), "/x");
        assert_eq!(parent("/x"), "/");
        assert_eq!(normalize("/a/b//"), "/a/b");
        assert_eq!(normalize("/"), "/");
    }
}
