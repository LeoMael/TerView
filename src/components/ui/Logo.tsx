// Logo de TerView (isotipo + nombre). BASE compartida.
import logoUrl from "../../assets/logo.svg";

interface LogoProps {
  /** Alto del isotipo en px. */
  size?: number;
  /** Mostrar el nombre "TerView" al lado. */
  withName?: boolean;
  className?: string;
}

export function Logo({ size = 24, withName = false, className }: LogoProps) {
  return (
    <span className={`tv-logo${className ? ` ${className}` : ""}`} style={{ gap: Math.round(size * 0.35) }}>
      <img src={logoUrl} width={size} height={size} alt={withName ? "" : "TerView"} draggable={false} />
      {withName && (
        <span className="tv-logo-name" style={{ fontSize: Math.round(size * 0.72) }}>
          Ter<span>View</span>
        </span>
      )}
    </span>
  );
}
