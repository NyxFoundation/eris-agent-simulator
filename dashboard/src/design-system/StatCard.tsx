type Tone = "neutral" | "success" | "danger";

export function StatCard({
  label,
  value,
  delta,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  delta?: string;
  tone?: Tone;
}) {
  const deltaColor =
    tone === "success" ? "var(--success-text)" : tone === "danger" ? "var(--danger-text)" : "var(--text-tertiary)";
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-4) var(--space-5)",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        minWidth: "160px",
      }}
    >
      <span style={{ font: "var(--text-sm) var(--font-sans)", color: "var(--text-tertiary)" }}>{label}</span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-2xl) var(--font-mono)",
          color: "var(--text-primary)",
        }}
      >
        {value}
      </span>
      {delta && <span style={{ font: "var(--text-sm) var(--font-mono)", color: deltaColor }}>{delta}</span>}
    </div>
  );
}
