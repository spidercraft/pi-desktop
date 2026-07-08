/** App-standard toggle switch — use this instead of native checkboxes. */
import type { ReactNode } from "react";

export function Toggle({
  checked,
  onChange,
  label,
  title,
  tipPlacement,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Optional text rendered next to the switch. */
  label?: ReactNode;
  title?: string;
  /** Optional preferred placement for the app-wide custom tooltip. */
  tipPlacement?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
}) {
  return (
    <label
      className={`switch ${disabled ? "disabled" : ""}`}
      title={title}
      data-tip-placement={tipPlacement}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}
