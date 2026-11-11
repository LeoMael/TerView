import { Check } from "lucide-react";
import { PRESET_COLORS } from "./colors";

/** Muestras de color; null = sin color. */
export function ColorPicker({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="cd-swatches" role="radiogroup" aria-label="Color">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        className={`cd-swatch cd-swatch-none${value === null ? " selected" : ""}`}
        title="Sin color"
        onClick={() => onChange(null)}
      />
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={`cd-swatch${value === c ? " selected" : ""}`}
          style={{ background: c }}
          title={c}
          onClick={() => onChange(c)}
        >
          {value === c && <Check size={12} strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}
