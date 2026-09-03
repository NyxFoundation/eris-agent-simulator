// The learning layer: what this simulator is, in the viewer's language.
//
// It lives on the standings page, which is where someone lands. It used to sit at the bottom of a
// scenario — one world out of thirty-five — so the explanation of what a scenario *is* was only
// reachable by first picking one, and reading it there implied it described that world in
// particular rather than the competition.
//
// Keys resolve through the dictionary so the copy exists in both languages and in exactly one
// place.

import { useState } from "react";
import { t, type MessageKey } from "@/i18n/messages";

interface InfoTab {
  key: string;
  num: string;
  label: MessageKey;
  body: MessageKey[];
}

const INFO_TAB_KEYS = [
  "overview",
  "environment",
  "scoring",
  "artifacts",
] as const;

const INFO_TABS: InfoTab[] = INFO_TAB_KEYS.map((key, i) => ({
  key,
  num: String(i + 1).padStart(2, "0"),
  label: `scenario.info.${key}.label` as MessageKey,
  body: [1, 2, 3, 4].map((n) => `scenario.info.${key}.p${n}` as MessageKey),
}));

export function InfoTabs() {
  const [activeKey, setActiveKey] = useState(INFO_TABS[0].key);
  const active = INFO_TABS.find((tab) => tab.key === activeKey) ?? INFO_TABS[0];

  return (
    <div
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0,1fr))",
          gap: "1px",
          background: "var(--border-subtle)",
        }}
      >
        {INFO_TABS.map((tab) => {
          const isActive = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              onClick={() => setActiveKey(tab.key)}
              style={{
                // Not bg-canvas: an inactive tab painted in the page's own background loses its
                // right edge against it, and the strip stops looking like a strip.
                background: isActive
                  ? "var(--bg-surface-raised)"
                  : "var(--bg-surface)",
                borderTop: `3px solid ${isActive ? "var(--pink-500)" : "transparent"}`,
                padding: "var(--space-3) var(--space-4)",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
                  letterSpacing: "var(--tracking-widest)",
                  color: isActive ? "var(--pink-300)" : "var(--text-disabled)",
                }}
              >
                {tab.num}
              </span>
              <span
                style={{
                  fontSize: "var(--text-base)",
                  fontWeight: "var(--weight-bold)",
                  letterSpacing: "var(--tracking-tight)",
                  textTransform: "uppercase",
                  color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-tertiary)",
                  lineHeight: 1.2,
                }}
              >
                {t(tab.label)}
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          padding: "var(--space-5) var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          maxWidth: "82ch",
        }}
      >
        {active.body.map((key) => (
          <p
            key={key}
            style={{
              margin: 0,
              fontSize: "var(--text-sm)",
              lineHeight: 1.75,
              color: "var(--text-secondary)",
            }}
          >
            {t(key)}
          </p>
        ))}
      </div>
    </div>
  );
}
