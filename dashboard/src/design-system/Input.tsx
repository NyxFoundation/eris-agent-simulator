import { useState } from "react";
import type { ChangeEventHandler, CSSProperties } from "react";

export function Input({
  label,
  placeholder,
  value,
  onChange,
  mono = false,
  suffix,
  error,
  disabled = false,
  style,
}: {
  label?: string;
  placeholder?: string;
  value?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  mono?: boolean;
  suffix?: string;
  error?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [focus, setFocus] = useState(false);

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: "var(--font-sans)", ...style }}>
      {label && <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>{label}</span>}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          background: "var(--bg-sunken)",
          border: `1px solid ${error ? "var(--danger)" : focus ? "var(--border-focus)" : "var(--border-default)"}`,
          borderRadius: "var(--radius-md)",
          padding: "0 12px",
          height: "38px",
          boxShadow: focus ? "var(--focus-ring)" : "none",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <input
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={onChange}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--text-primary)",
            fontSize: "var(--text-base)",
            fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
            width: "100%",
          }}
        />
        {suffix && (
          <span style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
            {suffix}
          </span>
        )}
      </div>
      {error && <span style={{ fontSize: "var(--text-xs)", color: "var(--danger-text)" }}>{error}</span>}
    </label>
  );
}
