export interface TabItem {
  label: string;
  value: string;
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "4px", borderBottom: "1px solid var(--border-subtle)" }}>
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "10px 14px",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-base)",
              color: active ? "var(--text-primary)" : "var(--text-tertiary)",
              borderBottom: "2px solid " + (active ? "var(--accent-primary)" : "transparent"),
              marginBottom: "-1px",
              transition: "color var(--duration-fast) var(--ease-standard)",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
