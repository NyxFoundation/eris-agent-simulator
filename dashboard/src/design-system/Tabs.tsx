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
    // The strip scrolls sideways rather than letting flex squeeze the buttons: four Japanese
    // labels in 390px broke "ステーブルコイン" across two lines and left the strip
    // three rows tall.
    <div
      style={{
        display: "flex",
        gap: "4px",
        borderBottom: "1px solid var(--border-subtle)",
        overflowX: "auto",
        scrollbarWidth: "thin",
      }}
    >
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
              flexShrink: 0,
              whiteSpace: "nowrap",
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
