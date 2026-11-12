// Limpieza general: espacio usado (`system df`) y «Limpiar todo lo que no se usa» (`system prune`).
import { useMemo } from "react";
import { Box, Brush, HardDrive, Image as ImageIcon, Layers, Network, RefreshCw, Sparkles } from "lucide-react";
import { pruneContainers, pruneImages, pruneNetworks, pruneVolumes, systemPrune, type DfRow } from "../../features/containers";
import { formatBytes } from "../../lib/format";
import { useCt } from "./context";
import { reclaimed, usersOf } from "./ImagesTab";

const ICONS: Record<string, typeof Box> = {
  images: ImageIcon,
  containers: Box,
  "local volumes": HardDrive,
  "build cache": Layers,
};

function DfCard({ row }: { row: DfRow }) {
  const Icon = ICONS[row.type.toLowerCase()] ?? Box;
  const pct = row.size && row.reclaimable !== null ? Math.min(100, Math.round((row.reclaimable / row.size) * 100)) : 0;
  return (
    <div className="ct-card">
      <div className="ct-card-head">
        <Icon size={15} />
        <strong>{row.label}</strong>
      </div>
      <div className="ct-card-size">{row.size !== null ? formatBytes(row.size) : "—"}</div>
      <div className="faint ct-small">
        {row.total ?? "—"} en total · {row.active ?? "—"} en uso
      </div>
      <div className="progress ct-df-bar" role="img" aria-label={`${pct}% recuperable`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="faint ct-small">
        Se puede liberar: <strong className="ct-strong">{row.reclaimable !== null ? formatBytes(row.reclaimable) : row.reclaimableText || "—"}</strong>
        {row.size ? ` (${pct} %)` : ""}
      </div>
    </div>
  );
}

export function CleanupTab() {
  const ct = useCt();
  const { engine, res } = ct;
  const df = res.df.data ?? [];
  const containers = useMemo(() => res.containers.data ?? [], [res.containers.data]);
  const images = useMemo(() => res.images.data ?? [], [res.images.data]);
  const volumes = useMemo(() => res.volumes.data ?? [], [res.volumes.data]);

  const stopped = containers.filter((c) => c.state === "exited" || c.state === "created" || c.state === "dead");
  const unusedImages = images.filter((i) => Math.max(i.containers ?? 0, usersOf(i, containers).length) === 0);
  // Tras borrar los contenedores parados, sus imágenes también quedan sin usar.
  const survivors = containers.filter((c) => !stopped.includes(c));
  const unusedAfterPrune = images.filter((i) => usersOf(i, survivors).length === 0);
  const danglingAfterPrune = unusedAfterPrune.filter((i) => i.dangling);
  const danglingImages = unusedImages.filter((i) => i.dangling);
  const unusedVolumes = volumes.filter((v) => v.unused);
  const totalReclaim = df.reduce((s, r) => s + (r.reclaimable ?? 0), 0);
  const all: ("df" | "containers" | "images" | "volumes")[] = ["df", "containers", "images", "volumes"];

  const pruneAll = () =>
    ct.review({
      title: "Limpiar todo lo que no se usa",
      message: (
        <>
          Se eliminan los <strong>contenedores parados</strong>, las <strong>redes sin usar</strong>, las imágenes sin nombre y la caché
          de compilación. Elige qué más quieres borrar:
        </>
      ),
      options: [
        { key: "all", label: "Todas las imágenes que no usa ningún contenedor (-a)", initial: true },
        { key: "volumes", label: "Volúmenes sin usar (--volumes): se pierden sus datos" },
      ],
      details: (o) => (
        <div className="ct-prune-summary">
          <div>
            <strong>{stopped.length}</strong> contenedores parados
            {stopped.length > 0 && <span className="faint"> ({stopped.slice(0, 6).map((c) => c.name).join(", ")}{stopped.length > 6 ? "…" : ""})</span>}
          </div>
          <div>
            <strong>{o.all ? unusedAfterPrune.length : danglingAfterPrune.length}</strong> imágenes
            <span className="faint"> · hasta {formatBytes((o.all ? unusedAfterPrune : danglingAfterPrune).reduce((s, i) => s + (i.size ?? 0), 0))}</span>
          </div>
          {o.volumes && (
            <div className="ct-bad-text">
              <strong>{unusedVolumes.length}</strong> volúmenes con sus datos
            </div>
          )}
          <div className="faint">
            Recuperable según «{engine} system df»: {formatBytes(totalReclaim)}
          </div>
        </div>
      ),
      build: (o) => [systemPrune(engine, { all: !!o.all, volumes: !!o.volumes })],
      danger: true,
      confirmWord: "LIMPIAR",
      runLabel: "Limpiar todo",
      timeoutSecs: 600,
      success: (r) => `Limpieza terminada\n${reclaimed(r.result?.stdout ?? "")}`,
      reload: ["df", "containers", "images", "volumes", "networks"],
    });

  const quick = [
    {
      icon: Box,
      label: "Contenedores parados",
      count: stopped.length,
      run: () =>
        ct.review({
          title: "Borrar contenedores parados",
          message: "Se eliminan todos los contenedores que no están en marcha.",
          details: () => (
            <ul className="ct-list ct-list-scroll">
              {stopped.map((c) => (
                <li key={c.id}>
                  <strong>{c.name}</strong> <span className="faint">{c.image}</span>
                </li>
              ))}
            </ul>
          ),
          build: () => [pruneContainers(engine)],
          danger: true,
          runLabel: "Borrar",
          success: (r) => `Contenedores parados eliminados\n${reclaimed(r.result?.stdout ?? "")}`,
          reload: ["df", "containers"],
        }),
    },
    {
      icon: ImageIcon,
      label: "Imágenes sin nombre",
      count: danglingImages.length,
      run: () =>
        ct.review({
          title: "Borrar imágenes sin nombre",
          message: "Restos de compilaciones y actualizaciones que ya no usa nadie.",
          build: () => [pruneImages(engine, false)],
          danger: true,
          runLabel: "Borrar",
          timeoutSecs: 300,
          success: (r) => `Imágenes sin nombre eliminadas\n${reclaimed(r.result?.stdout ?? "")}`,
          reload: ["df", "images"],
        }),
    },
    {
      icon: HardDrive,
      label: "Volúmenes sin usar",
      count: unusedVolumes.length,
      run: () =>
        ct.review({
          title: "Borrar volúmenes sin usar",
          message: <strong>Se pierden los datos de esos volúmenes.</strong>,
          options: engine === "docker" ? [{ key: "all", label: "Incluir los que tienen nombre (-a)" }] : undefined,
          details: () => (
            <ul className="ct-list ct-list-scroll">
              {unusedVolumes.map((v) => (
                <li key={v.name} className="mono">
                  {v.name}
                </li>
              ))}
            </ul>
          ),
          build: (o) => [pruneVolumes(engine, !!o.all)],
          danger: true,
          confirmWord: "BORRAR",
          runLabel: "Borrar",
          success: (r) => `Volúmenes eliminados\n${reclaimed(r.result?.stdout ?? "")}`,
          reload: ["df", "volumes"],
        }),
    },
    {
      icon: Network,
      label: "Redes sin usar",
      count: null,
      run: () =>
        ct.review({
          title: "Borrar redes sin usar",
          message: "Se eliminan las redes sin contenedores. Las integradas no se tocan.",
          build: () => [pruneNetworks(engine)],
          danger: true,
          runLabel: "Borrar",
          success: "Redes sin usar eliminadas",
          reload: ["networks"],
        }),
    },
  ];

  const loading = all.some((k) => res[k].loading);

  return (
    <div className="ct-tab-body ct-cleanup">
      <div className="ct-toolbar">
        <h3 className="ct-h3">Espacio usado</h3>
        <span className="ct-grow" />
        <button className="icon-btn" onClick={() => void ct.reload(...all)} title="Actualizar" aria-label="Actualizar" disabled={loading}>
          <RefreshCw size={14} className={loading ? "ct-spin" : undefined} />
        </button>
      </div>
      {res.df.error && (
        <div className="ct-error ct-error-inline" role="alert">
          <pre>{res.df.error}</pre>
        </div>
      )}
      {res.df.data === null && res.df.loading ? (
        <div className="ct-pad faint">
          <span className="spinner ct-spinner-sm" /> Calculando espacio (puede tardar un poco)…
        </div>
      ) : (
        <div className="ct-cards">
          {df.map((r) => (
            <DfCard key={r.type} row={r} />
          ))}
        </div>
      )}

      <div className="ct-bigclean">
        <Sparkles size={22} />
        <div className="ct-grow">
          <strong>Limpiar todo lo que no se usa</strong>
          <div className="faint ct-small">
            Contenedores parados, redes vacías, imágenes sin usar y caché. Se puede liberar hasta <strong className="ct-strong">{formatBytes(totalReclaim)}</strong>.
          </div>
        </div>
        <button className="btn btn-danger" onClick={pruneAll} disabled={res.df.data === null}>
          <Brush size={14} /> Limpiar todo…
        </button>
      </div>

      <h4 className="section-label">Limpiezas sueltas</h4>
      <div className="ct-quick">
        {quick.map((qk) => (
          <button key={qk.label} className="ct-quick-btn" onClick={qk.run} disabled={qk.count === 0}>
            <qk.icon size={15} />
            <span>{qk.label}</span>
            {qk.count !== null && <span className="ct-count">{qk.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
