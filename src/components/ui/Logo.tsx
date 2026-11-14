// Logo de SSHorus (icono + nombre). BASE compartida.
// A 32 px o menos se usa el icono dibujado a píxel (docs/marca/sshorus/final/icono-app-24/32.svg);
// a más tamaño, el dibujo completo (icono-app.svg). El disco azul noche se ve en temas claros y oscuros.
import logoUrl from "../../assets/logo.svg";
import logo24Url from "../../assets/logo-24.svg";
import logo32Url from "../../assets/logo-32.svg";

interface LogoProps {
  /** Alto del icono en px. */
  size?: number;
  /** Mostrar el nombre "SSHorus" al lado. */
  withName?: boolean;
  className?: string;
}

export function Logo({ size = 24, withName = false, className }: LogoProps) {
  const src = size <= 24 ? logo24Url : size <= 32 ? logo32Url : logoUrl;
  return (
    <span className={`tv-logo${className ? ` ${className}` : ""}`} style={{ gap: Math.round(size * 0.35) }}>
      <img src={src} width={size} height={size} alt={withName ? "" : "SSHorus"} draggable={false} />
      {withName && (
        <span className="tv-logo-name" style={{ fontSize: Math.round(size * 0.72) }}>
          <span>SSH</span>orus
        </span>
      )}
    </span>
  );
}
