import type { ChangeEventHandler, CSSProperties } from "react";

export interface SelectOption {
  label: string;
  value: string;
  /** An option that exists but cannot be chosen right now — offered greyed rather than removed, so
   * the list does not silently change length and leave the absence unexplained. */
  disabled?: boolean;
}

export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  style,
}: {
  label?: string;
  value?: string;
  options: SelectOption[];
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: "var(--font-sans)", ...style }}>
      {label && <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>{label}</span>}
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        style={{
          height: "38px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-default)",
          background: "var(--bg-sunken)",
          color: "var(--text-primary)",
          padding: "0 10px",
          fontSize: "var(--text-base)",
          fontFamily: "var(--font-sans)",
          opacity: disabled ? 0.5 : 1,
          width: "100%",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
