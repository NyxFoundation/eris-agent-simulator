import { useState } from "react";
import type { ReactNode } from "react";

type Size = "sm" | "md" | "lg";
type Variant = "ghost" | "filled";

const DIMENSIONS: Record<Size, string> = { sm: "28px", md: "34px", lg: "40px" };

export function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  active = false,
  disabled = false,
  onClick,
  label,
}: {
  icon: ReactNode;
  size?: Size;
  variant?: Variant;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  label: string;
}) {
  const [hover, setHover] = useState(false);
  const dim = DIMENSIONS[size];
  const bg =
    variant === "filled"
      ? active
        ? "var(--accent-primary)"
        : "var(--bg-surface-raised)"
      : hover || active
        ? "var(--bg-surface-raised)"
        : "transparent";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: dim,
        height: dim,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-md)",
        border: "1px solid transparent",
        background: bg,
        color: variant === "filled" && active ? "var(--text-on-accent)" : "var(--text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "background var(--duration-fast) var(--ease-standard)",
      }}
    >
      {icon}
    </button>
  );
}
