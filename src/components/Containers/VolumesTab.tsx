// Volúmenes: listar, crear, eliminar y limpiar los que no usa ningún contenedor.
import { useMemo, useState } from "react";
import { Brush, Copy, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { ago, createVolume, ownedBy, pruneVolumes, removeVolumes, validateObjName, type VolumeInfo } from "../../features/containers";
import { clipboard } from "../../lib/clipboard";
import { toast } from "../../stores/toasts";
import { promptDialog } from "../ui/dialogs";
import { PICK_OWNER_HINT, useCt } from "./context";
import { reclaimed } from "./ImagesTab";

/** Clave única (con «Todos», dos usuarios pueden tener un volumen con el mismo nombre). */
const volKey = (v: VolumeInfo) => `${v.owner ?? ""}/${v.name}`;

export function VolumesTab() {
  const ct = useCt();
  const { engine, res } = ct;
  const vols = useMemo(() => res.volumes.data ?? [], [res.volumes.data]);
  const [search, setSearch] = useState("");
  const [onlyUnused, setOnlyUnused] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return vols
      .filter(
        (v) =>
          (!onlyUnused || v.unused) &&
          (!s ||
            v.name.toLowerCase().includes(s) ||
            v.mountpoint.toLowerCase().includes(s) ||
            (ct.allOwners && ct.ownerLabel(v.owner).toLowerCase().includes(s))),
      )
      .sort((a, b) => Number(a.anonymous) - Number(b.anonymous) || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vols, search, onlyUnused, ct.allOwners, ct.ownerLabel]);
  const unused = vols.filter((v) => v.unused);
  const sel = vols.filter((v) => selected.has(volKey(v)));

  const create = async () => {
    const name = await promptDialog({
      title: "Nuevo volumen",
      label: "Nombre",
      placeholder: "datos_app",
      confirmText: "Crear",
      validate: (v) =>
        validateObjName(v.trim()) ?? (ownedBy(vols, ct.newOwner ?? undefined).some((x) => x.name === v.trim()) ? "Ya existe un volumen con ese nombre" : null),
    });
    if (!name) return;
    const r = await ct.run([createVolume(engine, name.trim())], 30);
    if (r.ok) toast.success("Volumen creado", name.trim());
    else toast.error("No se pudo crear el volumen", r.error ?? undefined);
    void ct.reload("volumes");
  };

  const remove = (list: VolumeInfo[]) => {
    const inUse = list.filter((v) => !v.unused);
    ct.review({
      title: list.length > 1 ? `Eliminar ${list.length} volúmenes` : `Eliminar volumen «${short(list[0].name)}»`,
      message: (
        <>
          <strong>Los datos que guardan se pierden para siempre.</strong>
          {inUse.length > 0 && ` ${inUse.length} de ellos los usa algún contenedor: no se podrán borrar salvo que fuerces (y el contenedor se quedaría sin datos).`}
        </>
      ),
      details: () => (
        <ul className="ct-list ct-list-scroll">
          {list.map((v) => (
            <li key={volKey(v)} className="mono">
              {v.name} {!v.unused && <span className="ct-tag">en uso</span>}
              {ct.allOwners && <span className="ct-tag">{ct.ownerLabel(v.owner)}</span>}
            </li>
          ))}
        </ul>
      ),
      options: inUse.length ? [{ key: "force", label: "Forzar aunque estén en uso (-f)" }] : undefined,
      build: (o) => ct.perOwner(list, (g) => removeVolumes(engine, g.map((v) => v.name), !!o.force)),
      danger: true,
      confirmWord: list.length > 1 || inUse.length ? "BORRAR" : undefined,
      runLabel: "Eliminar",
      success: list.length > 1 ? `${list.length} volúmenes eliminados` : "Volumen eliminado",
      reload: ["volumes", "df"],
      onDone: () => setSelected(new Set()),
    });
  };

  const prune = () =>
    ct.review({
      title: "Limpiar volúmenes sin usar",
      message: (
        <>
          <strong>Se borran los datos de los volúmenes que no usa ningún contenedor.</strong> Si algún contenedor parado los iba a usar
          más tarde, perderá esos datos.
        </>
      ),
      options:
        engine === "docker"
          ? [{ key: "all", label: "Incluir los volúmenes con nombre (-a)", hint: "Docker 23+: sin esto solo borra los anónimos" }]
          : undefined,
      details: (o) => {
        const list = engine === "docker" && !o.all ? unused.filter((v) => v.anonymous) : unused;
        return (
          <div>
            <div className="ct-summary">
              <strong>{list.length}</strong> volúmenes
            </div>
            <ul className="ct-list ct-list-scroll">
              {list.map((v) => (
                <li key={v.name} className="mono">
                  {v.name}
                </li>
              ))}
            </ul>
          </div>
        );
      },
      build: (o) => [pruneVolumes(engine, !!o.all)],
      danger: true,
      confirmWord: "BORRAR",
      runLabel: "Limpiar",
      timeoutSecs: 300,
      success: (r) => `Volúmenes sin usar eliminados\n${reclaimed(r.result?.stdout ?? "")}`,
      reload: ["volumes", "df"],
    });

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  return (
    <div className="ct-tab-body">
      <div className="ct-toolbar">
        <div className="ct-search">
          <Search size={13} />
          <input className="input" placeholder="Buscar volumen" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar volúmenes" />
          {search && (
            <button className="icon-btn" onClick={() => setSearch("")} aria-label="Limpiar búsqueda">
              <X size={12} />
            </button>
          )}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={onlyUnused} onChange={(e) => setOnlyUnused(e.target.checked)} /> Solo sin usar ({unused.length})
        </label>
        <span className="ct-grow" />
        {sel.length > 0 && (
          <button className="btn btn-sm ct-btn-danger" onClick={() => remove(sel)}>
            <Trash2 size={13} /> Eliminar {sel.length}
          </button>
        )}
        <button className="icon-btn" onClick={() => void ct.reload("volumes")} title="Actualizar" aria-label="Actualizar" disabled={res.volumes.loading}>
          <RefreshCw size={14} className={res.volumes.loading ? "ct-spin" : undefined} />
        </button>
        <button className="btn btn-sm" onClick={prune} disabled={unused.length === 0 || !ct.newOwner} title={ct.newOwner ? undefined : PICK_OWNER_HINT}>
          <Brush size={13} /> Limpiar sin usar
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => void create()} disabled={!ct.newOwner} title={ct.newOwner ? undefined : PICK_OWNER_HINT}>
          <Plus size={13} /> Nuevo volumen
        </button>
      </div>
      {res.volumes.error && (
        <div className="ct-error ct-error-inline" role="alert">
          <pre>{res.volumes.error}</pre>
          <button className="btn btn-sm" onClick={() => void ct.reload("volumes")}>
            Reintentar
          </button>
        </div>
      )}
      <div className="ct-table-wrap">
        {res.volumes.data === null && res.volumes.loading ? (
          <div className="empty-state">
            <span className="spinner" />
          </div>
        ) : (
          <table className="ct-table">
            <thead>
              <tr>
                <th className="ct-col-chk">
                  <span className="sr-only">Seleccionar</span>
                </th>
                <th className="ct-col-name">Nombre</th>
                {ct.allOwners && <th className="ct-col-owner">Usuario</th>}
                <th className="ct-col-state">Estado</th>
                <th className="ct-col-short">Driver</th>
                <th className="ct-col-image">Ubicación en el servidor</th>
                <th className="ct-col-created">Creado</th>
                <th className="ct-col-actions">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr
                  key={volKey(v)}
                  tabIndex={0}
                  className={selected.has(volKey(v)) ? "sel" : undefined}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === " ") {
                      e.preventDefault();
                      toggle(volKey(v));
                    } else if (e.key === "Delete") remove([v]);
                  }}
                >
                  <td className="ct-col-chk">
                    <input type="checkbox" checked={selected.has(volKey(v))} onChange={() => toggle(volKey(v))} aria-label={`Seleccionar ${v.name}`} tabIndex={-1} />
                  </td>
                  <td className="ct-col-name mono" title={v.name}>
                    <span className="ct-cell-flex">
                      <span className="ct-ellipsis">{short(v.name)}</span>
                      {v.anonymous && <span className="ct-tag">anónimo</span>}
                      {v.labels["com.docker.compose.project"] && <span className="ct-tag">{v.labels["com.docker.compose.project"]}</span>}
                    </span>
                  </td>
                  {ct.allOwners && <td className="ct-col-owner ct-ellipsis">{ct.ownerLabel(v.owner)}</td>}
                  <td className="ct-col-state">{v.unused ? <span className="faint">Sin usar</span> : <span className="ct-yes">En uso</span>}</td>
                  <td className="ct-col-short faint">{v.driver}</td>
                  <td className="ct-col-image mono faint ct-ellipsis-start" title={v.mountpoint}>
                    <bdi>{v.mountpoint || "—"}</bdi>
                  </td>
                  <td className="ct-col-created faint">{ago(v.created)}</td>
                  <td className="ct-col-actions">
                    <span className="ct-actions">
                      <button
                        className="icon-btn"
                        title="Copiar ruta"
                        aria-label="Copiar ruta"
                        disabled={!v.mountpoint}
                        tabIndex={-1}
                        onClick={() =>
                          clipboard.write(v.mountpoint).then(
                            () => toast.success("Ruta copiada", v.mountpoint),
                            (e) => toast.error("No se pudo copiar", e),
                          )
                        }
                      >
                        <Copy size={13} />
                      </button>
                      <button className="icon-btn ct-danger" title="Eliminar" aria-label={`Eliminar ${v.name}`} onClick={() => remove([v])} tabIndex={-1}>
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={ct.allOwners ? 8 : 7} className="ct-norows">
                    {vols.length ? "Ningún volumen coincide" : "No hay volúmenes"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Los nombres anónimos (64 hex) se acortan para la tabla. */
function short(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 12)}…` : name;
}
