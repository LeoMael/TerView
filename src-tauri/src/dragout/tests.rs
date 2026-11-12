use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use super::*;

fn temp_root() -> PathBuf {
    let p = std::env::temp_dir().join(format!("terview-arrastre-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn acepta_lo_preparado_con_espacios_y_acentos() {
    let root = temp_root();
    let dir = root.join("lote");
    fs::create_dir_all(dir.join("mis fotos ñandú")).unwrap();
    let file = dir.join("informe final #1 (copia) 100%.txt");
    fs::write(&file, "hola").unwrap();
    let paths = vec![
        file.to_string_lossy().into_owned(),
        dir.join("mis fotos ñandú").to_string_lossy().into_owned(),
    ];
    let ok = check_paths(&root, &paths).unwrap();
    assert_eq!(ok, vec![file, dir.join("mis fotos ñandú")]);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn rechaza_rutas_fuera_de_la_cache() {
    let root = temp_root();
    let other = temp_root();
    let outside = other.join("secreto.txt");
    fs::write(&outside, "x").unwrap();
    let err = check_paths(&root, &[outside.to_string_lossy().into_owned()]).unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");

    // Escapar con "..": se rechaza aunque exista.
    let sneaky = root.join("..").join(other.file_name().unwrap()).join("secreto.txt");
    let err = check_paths(&root, &[sneaky.to_string_lossy().into_owned()]).unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");

    // La raíz misma tampoco.
    let err = check_paths(&root, &[root.to_string_lossy().into_owned()]).unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");

    fs::remove_dir_all(&root).unwrap();
    fs::remove_dir_all(&other).unwrap();
}

#[test]
fn rechaza_rutas_relativas_vacias_o_que_ya_no_estan() {
    let root = temp_root();
    assert!(matches!(check_paths(&root, &[]), Err(AppError::Invalid(_))));
    assert!(matches!(check_paths(&root, &["lote/a.txt".into()]), Err(AppError::Invalid(_))));
    let gone = root.join("lote").join("borrado.txt");
    assert!(matches!(
        check_paths(&root, &[gone.to_string_lossy().into_owned()]),
        Err(AppError::NotFound(_))
    ));
    // Sin carpeta de caché todavía: "ya no está".
    let missing_root = root.join("no-existe");
    assert!(matches!(
        check_paths(&missing_root, &[gone.to_string_lossy().into_owned()]),
        Err(AppError::NotFound(_))
    ));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn limpieza_borra_solo_lo_viejo() {
    let root = temp_root();
    fs::create_dir_all(root.join("a").join("sub")).unwrap();
    fs::write(root.join("a").join("sub").join("x.bin"), [0u8; 16]).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();

    // Todo es más nuevo que hace una hora: no se borra nada.
    let past = SystemTime::now() - Duration::from_secs(3600);
    assert_eq!(clean_older_than(&root, past), 0);
    assert!(root.join("a").exists() && root.join("b").exists());

    // Con el corte en el futuro todo cuenta como viejo.
    let future = SystemTime::now() + Duration::from_secs(3600);
    assert_eq!(clean_older_than(&root, future), 2);
    assert!(!root.join("a").exists() && !root.join("b").exists());

    // Sin carpeta: no falla.
    assert_eq!(clean_older_than(&root.join("no-existe"), future), 0);
    fs::remove_dir_all(&root).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn uris_codificadas_para_espacios_y_no_ascii() {
    let uris = linux::file_uris(&[
        PathBuf::from("/tmp/mis fotos/año 2026 #1 100%.jpg"),
        PathBuf::from("/tmp/日本/Ñandú.txt"),
    ])
    .unwrap();
    assert_eq!(uris[0], "file:///tmp/mis%20fotos/a%C3%B1o%202026%20%231%20100%25.jpg");
    assert_eq!(uris[1], "file:///tmp/%E6%97%A5%E6%9C%AC/%C3%91and%C3%BA.txt");
    // Relativa: GLib la rechaza (el destino necesita rutas completas).
    assert!(linux::file_uris(&[PathBuf::from("relativa.txt")]).is_err());
}
