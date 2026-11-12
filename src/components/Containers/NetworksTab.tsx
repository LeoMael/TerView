// Redes: listar, crear, eliminar y limpiar las que no usa ningún contenedor.
import { useMemo, useState } from "react";
import { Brush, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { ago, createNetwork, pruneNetworks, removeNetworks, validateObjName, type Container, type NetworkInfo } from "../../features/containers";
import { toast } from "../../stores/toasts";
import { promptDialog } from "../ui/dialogs";
import { useCt } from "./context";

/** Contenedores conectados a la red (según la lista de `ps`). */
function membersOf(n: NetworkInfo, containers: Container[]): Container[] {
  return containers.filter((c) => c.networks.includes(n.name));
}

export function NetworksTab() {
  const ct = useCt();
  const { engine, res } = ct;
  const nets = useMemo(() => res.networks.data ?? [], [res.networks.data]);
  const containers = useMemo(() => res.containers.data ?? [], [res.containers.data]);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return nets
      .filter((n) => !s || n.name.toLowerCase().includes(s) || n.subnets.some((x) => x.includes(s)))
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }, [nets, search]);

  const unused = nets.filter((n) => !n.builtin && membersOf(n, containers).length === 0);

  const create = async () => {
    const name = await promptDialog({
      title: "Nueva red",
      message: "Los contenedores de una misma red se ven entre sí por su nombre.",
      label: "Nombre",
      placeholder: "mi_red",
      confirmText: "Crear",
      validate: (v) => validateObjName(v.trim()) ?? (nets.some((x) => x.name === v.trim()) ? "Ya existe una red con ese nombre" : null),
    });
    if (!name) return;
    const r = await ct.run([createNetwork(engine, name.trim())], 30);
    if (r.ok) toast.success("Red creada", name.trim());
    else toast.error("No se pudo crear la red", r.error ?? undefined);
    void ct.reload("networks");
  };

  const remove = (n: NetworkInfo) => {
    const members = membersOf(n, containers);
    ct.review({
      title: `Eliminar red «${n.name}»`,
      message:
        members.length > 0
          ? `La usan ${members.length} contenedor(es): ${members.map((m) => m.name).join(", ")}. Hay que eliminarlos o desconectarlos antes.`
          : "Se elimina la red. Los contenedores que se creen después ya no podrán usarla.",
      build: () => [removeNetworks(engine, [n.name])],
      danger: true,
      runLabel: "Eliminar",
      success: "Red eliminada",
      reload: ["networks"],
    });
  };

  const prune = () =>
    ct.review({
      title: "Limpiar redes sin usar",
      message: "Se eliminan las redes creadas por ti o por Compose que no tienen ningún contenedor (ni parado). Las redes integradas no se tocan.",
      details: () => (
        <ul className="ct-list ct-list-scroll">
          {unused.map((n) => (
            <li key={n.name} className="mono">
              {n.name}
            </li>
          ))}
        </ul>
      ),
      build: () => [pruneNetworks(engine)],
      danger: true,
      runLabel: "Limpiar",
      success: "Redes sin usar eliminadas",
      reload: ["networks"],
    });

  return (
    <div className="ct-tab-body">
      <div className="ct-toolbar">
        <div className="ct-search">
          <Search size={13} />
          <input className="input" placeholder="Buscar red o subred" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar redes" />
          {search && (
            <button className="icon-btn" onClick={() => setSearch("")} aria-label="Limpiar búsqueda">
              <X size={12} />
            </button>
          )}
        </div>
        <span className="faint">{nets.length} redes</span>
        <span className="ct-grow" />
        <button className="icon-btn" onClick={() => void ct.reload("networks", "containers")} title="Actualizar" aria-label="Actualizar" disabled={res.networks.loading}>
          <RefreshCw size={14} className={res.networks.loading ? "ct-spin" : undefined} />
        </button>
        <button className="btn btn-sm" onClick={prune} disabled={unused.length === 0}>
          <Brush size={13} /> Limpiar sin usar
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => void create()}>
          <Plus size={13} /> Nueva red
        </button>
      </div>
      {res.networks.error && (
        <div className="ct-error ct-error-inline" role="alert">
          <pre>{res.networks.error}</pre>
          <button className="btn btn-sm" onClick={() => void ct.reload("networks")}>
            Reintentar
          </button>
        </div>
      )}
      <div className="ct-table-wrap">
        {res.networks.data === null && res.networks.loading ? (
          <div className="empty-state">
            <span className="spinner" />
          </div>
        ) : (
          <table className="ct-table">
            <thead>
              <tr>
                <th className="ct-col-name">Nombre</th>
                <th className="ct-col-short">Driver</th>
                <th className="ct-col-image">Subred</th>
                <th className="ct-col-state">Contenedores</th>
                <th className="ct-col-created">Creada</th>
                <th className="ct-col-actions">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => {
                const members = membersOf(n, containers);
                return (
                  <tr key={n.name} tabIndex={0} onKeyDown={(e) => e.target === e.currentTarget && e.key === "Delete" && !n.builtin && remove(n)}>
                    <td className="ct-col-name mono">
                      <span className="ct-cell-flex">
                        <span className="ct-ellipsis">{n.name}</span>
                        {n.builtin && <span className="ct-tag">integrada</span>}
                        {n.internal && <span className="ct-tag">interna</span>}
                        {n.labels["com.docker.compose.project"] && <span className="ct-tag">{n.labels["com.docker.compose.project"]}</span>}
                      </span>
                    </td>
                    <td className="ct-col-short faint">{n.driver}</td>
                    <td className="ct-col-image mono faint">{n.subnets.join(", ") || "—"}</td>
                    <td className="ct-col-state ct-ellipsis" title={members.map((m) => m.name).join("\n")}>
                      {members.length ? members.map((m) => m.name).join(", ") : <span className="faint">—</span>}
                    </td>
                    <td className="ct-col-created faint">{ago(n.created)}</td>
                    <td className="ct-col-actions">
                      <span className="ct-actions">
                        <button
                          className="icon-btn ct-danger"
                          title={n.builtin ? "Las redes integradas no se pueden borrar" : "Eliminar"}
                          aria-label={`Eliminar ${n.name}`}
                          onClick={() => remove(n)}
                          disabled={n.builtin}
                          tabIndex={-1}
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="ct-norows">
                    Ninguna red coincide
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
