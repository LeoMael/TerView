//! Diferencias por líneas para el diálogo de aprobación de `write_file` (formato unificado simple).
//!
//! Se quitan primero las líneas iguales del principio y del final (lo normal al editar un archivo)
//! y el centro se compara con la subsecuencia común más larga. Si el centro es enorme, se muestra
//! como «todo cambiado» para no gastar memoria.

/// Líneas de contexto alrededor de cada cambio.
const CONTEXT: usize = 3;
/// Tamaño máximo (líneas × líneas) de la tabla de comparación.
const MAX_CELLS: usize = 4_000_000;
/// Líneas máximas del resultado (el resto se resume).
const MAX_OUT_LINES: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Same,
    Del,
    Add,
}

/// Diferencias entre `old` y `new`. Vacío si son iguales.
pub fn unified(old: &str, new: &str) -> String {
    if old == new {
        return String::new();
    }
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let ops = diff_ops(&a, &b);
    render(&a, &b, &ops)
}

fn diff_ops<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<Op> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let ma = &a[pre..a.len() - suf];
    let mb = &b[pre..b.len() - suf];
    let mut ops = vec![Op::Same; pre];
    if ma.len().saturating_mul(mb.len()) > MAX_CELLS {
        ops.extend(std::iter::repeat_n(Op::Del, ma.len()));
        ops.extend(std::iter::repeat_n(Op::Add, mb.len()));
    } else {
        ops.extend(lcs_ops(ma, mb));
    }
    ops.extend(std::iter::repeat_n(Op::Same, suf));
    ops
}

/// Subsecuencia común más larga (tabla completa; el tamaño ya está limitado).
fn lcs_ops(a: &[&str], b: &[&str]) -> Vec<Op> {
    let (n, m) = (a.len(), b.len());
    let w = m + 1;
    let mut t = vec![0u32; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            t[i * w + j] = if a[i] == b[j] {
                t[(i + 1) * w + j + 1] + 1
            } else {
                t[(i + 1) * w + j].max(t[i * w + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut ops = Vec::with_capacity(n + m);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push(Op::Same);
            i += 1;
            j += 1;
        } else if t[(i + 1) * w + j] >= t[i * w + j + 1] {
            ops.push(Op::Del);
            i += 1;
        } else {
            ops.push(Op::Add);
            j += 1;
        }
    }
    ops.extend(std::iter::repeat_n(Op::Del, n - i));
    ops.extend(std::iter::repeat_n(Op::Add, m - j));
    ops
}

fn render(a: &[&str], b: &[&str], ops: &[Op]) -> String {
    // Posición (línea vieja, línea nueva) antes de cada operación.
    let mut pos = Vec::with_capacity(ops.len());
    let (mut i, mut j) = (0usize, 0usize);
    for op in ops {
        pos.push((i, j));
        match op {
            Op::Same => {
                i += 1;
                j += 1;
            }
            Op::Del => i += 1,
            Op::Add => j += 1,
        }
    }
    // Qué operaciones se muestran: los cambios y CONTEXT líneas iguales alrededor.
    let mut show = vec![false; ops.len()];
    for (k, op) in ops.iter().enumerate() {
        if *op != Op::Same {
            let lo = k.saturating_sub(CONTEXT);
            let hi = (k + CONTEXT + 1).min(ops.len());
            for s in &mut show[lo..hi] {
                *s = true;
            }
        }
    }
    let mut out = Vec::new();
    let mut k = 0;
    while k < ops.len() {
        if !show[k] {
            k += 1;
            continue;
        }
        let start = k;
        while k < ops.len() && show[k] {
            k += 1;
        }
        let (oi, nj) = pos[start];
        let del = ops[start..k].iter().filter(|o| **o != Op::Add).count();
        let add = ops[start..k].iter().filter(|o| **o != Op::Del).count();
        out.push(format!("@@ -{},{} +{},{} @@", oi + 1, del, nj + 1, add));
        for idx in start..k {
            let (pi, pj) = pos[idx];
            match ops[idx] {
                Op::Same => out.push(format!(" {}", a[pi])),
                Op::Del => out.push(format!("-{}", a[pi])),
                Op::Add => out.push(format!("+{}", b[pj])),
            }
        }
    }
    if out.len() > MAX_OUT_LINES {
        let rest = out.len() - MAX_OUT_LINES;
        out.truncate(MAX_OUT_LINES);
        out.push(format!("… ({rest} líneas más de diferencias)"));
    }
    out.join("\n")
}
