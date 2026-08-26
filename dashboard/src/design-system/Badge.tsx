import type { CSSProperties, ReactNode } from "react";

type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

const TONES: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: "var(--bg-surface-overlay)", fg: "var(--text-secondary)" },
  accent: { bg: "var(--accent-muted)", fg: "var(--accent-secondary)" },
  success: { bg: "var(--success-bg)", fg: "var(--success-text)" },
  danger: { bg: "var(--danger-bg)", fg: "var(--danger-text)" },
  warning: { bg: "var(--warning-bg)", fg: "var(--warning-text)" },
};

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  style?: CSSProperties;
}) {
  const t = TONES[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        background: t.bg,
        color: t.fg,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-medium)",
        letterSpacing: "var(--tracking-wide)",
        textTransform: "uppercase",
        padding: "3px 8px",
        borderRadius: "var(--radius-full)",
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: t.fg,
          }}
        />
      )}
      {children}
    </span>
  );
}
