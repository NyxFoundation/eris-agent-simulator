import type { LogTone } from "@/data/types";

const TONE_COLOR: Record<LogTone, string> = {
  info: "var(--text-secondary)",
  success: "var(--success-text)",
  danger: "var(--danger-text)",
  warning: "var(--warning-text)",
};

export interface LogStreamLine {
  time: string;
  text: string;
  tone?: LogTone;
}

export function LogStream({ lines, height = 260 }: { lines: LogStreamLine[]; height?: number }) {
  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-3) var(--space-4)",
        height,
        overflowY: "auto",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm)",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        boxSizing: "border-box",
      }}
    >
      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: "10px", color: TONE_COLOR[l.tone ?? "info"] }}>
          <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>{l.time}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
