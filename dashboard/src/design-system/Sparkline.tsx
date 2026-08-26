import { useId } from "react";

type Tone = "neutral" | "success" | "danger";

export function Sparkline({
  points,
  width = 280,
  height = 64,
  tone = "neutral",
}: {
  points: number[];
  width?: number;
  height?: number;
  tone?: Tone;
}) {
  const gradId = useId();
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${i * step} ${height - ((p - min) / range) * height}`)
    .join(" ");
  const color = tone === "success" ? "var(--success)" : tone === "danger" ? "var(--danger)" : "var(--accent-secondary)";
  const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}
