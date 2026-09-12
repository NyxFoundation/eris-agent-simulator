// Score by epoch: every agent's cumulative Score after each completed epoch, on one chart.
//
// This is the leaderboard's memory. The table says where everyone stands now; the chart says how
// they got there — who led early and faded, who climbed through the back half where the weights
// are heavier (rules §4.4.1). It is the one place the page spends colour: the top of the field in
// the accent ramp, the followed agent in pink with its name on the line, everyone else as a grey
// thread so the shape of the whole field is visible without a legend of forty names.
//
// Nothing here is a second ranking. The lines are `standingsThroughEpoch` at each ordinal, the
// same arithmetic as the table (core/src/scoring/deviationScore.ts), so the last point of every
// line is the number in the table.

import type { ScoreRace } from "@/data/standings";
import { t } from "@/i18n/messages";
import { navigate } from "@/navigation";

const WIDTH = 720;
const HEIGHT = 240;
const PAD = { top: 14, right: 116, bottom: 28, left: 40 };
const TOP_N = 10;

export function ScoreRaceChart({
  race,
  pinned,
  onPick,
}: {
  race: ScoreRace;
  /** The followed agent, drawn in the accent and named. */
  pinned: string | null;
  /** A click on a line or a legend name follows that agent. */
  onPick: (id: string) => void;
}) {
  const { ordinals, series, order } = race;
  if (ordinals.length < 2) {
    return (
      <p
        style={{
          margin: 0,
          padding: "18px 16px",
          font: "var(--text-xs) var(--font-sans)",
          color: "var(--text-tertiary)",
        }}
      >
        {t("home.chart.empty")}
      </p>
    );
  }

  const values = Object.values(series)
    .flat()
    .filter((v): v is number => v !== null && Number.isFinite(v));
  // 50 is always on the axis: it is the field's average by construction, and a chart whose scale
  // wanders away from it would make a field that all scored 50 look like drama.
  const lo = Math.min(50, ...values);
  const hi = Math.max(50, ...values);
  const span = Math.max(hi - lo, 4);
  const yMin = lo - span * 0.08;
  const yMax = hi + span * 0.08;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left +
    (ordinals.length === 1 ? 0 : (i / (ordinals.length - 1)) * innerW);
  const y = (v: number) =>
    PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const pathFor = (points: Array<number | null>): string => {
    let d = "";
    let pen = false;
    points.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? " L" : " M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d.trim();
  };

  // Draw order: the grey field first, then the top of the field, then the followed agent, so the
  // lines that carry meaning are never under the ones that carry context.
  const top = order.slice(0, TOP_N);
  const rest = order.slice(TOP_N).filter((id) => id !== pinned);
  const layered = [
    ...rest,
    ...[...top].reverse().filter((id) => id !== pinned),
  ];
  if (pinned && series[pinned]) layered.push(pinned);

  const strokeFor = (
    id: string,
  ): { stroke: string; width: number; opacity: number } => {
    if (id === pinned)
      return { stroke: "var(--pink-500)", width: 2.4, opacity: 1 };
    const rank = top.indexOf(id);
    if (rank >= 0)
      return {
        stroke: "var(--accent-primary)",
        width: rank < 3 ? 1.8 : 1.3,
        opacity: 0.95 - rank * 0.07,
      };
    return { stroke: "var(--text-disabled)", width: 1, opacity: 0.45 };
  };

  // Names on the right for the podium and the followed agent, nudged apart so they stay legible.
  const labelled = [
    ...top.slice(0, 3),
    ...(pinned && series[pinned] ? [pinned] : []),
  ].filter((id, i, arr) => arr.indexOf(id) === i);
  const last = ordinals.length - 1;
  const labels = labelled
    .map((id) => {
      const v = series[id]?.[last];
      return v === null || v === undefined ? null : { id, y: y(v) };
    })
    .filter((l): l is { id: string; y: number } => l !== null)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++)
    if (labels[i].y - labels[i - 1].y < 12) labels[i].y = labels[i - 1].y + 12;

  const ticks = [yMin + (yMax - yMin) * 0.1, 50, yMax - (yMax - yMin) * 0.1];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={t("home.chart.title")}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {/* the field average, the one line that is the same in every competition */}
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={y(50)}
          y2={y(50)}
          stroke="var(--border-subtle)"
          strokeDasharray="3 4"
        />
        <text
          x={PAD.left + 4}
          y={y(50) - 4}
          fill="var(--text-tertiary)"
          style={{ font: "9px var(--font-mono)" }}
        >
          {t("home.chart.mean")}
        </text>
        {ticks
          .filter((v) => Math.abs(v - 50) > (yMax - yMin) * 0.06)
          .map((v) => (
            <text
              key={v}
              x={PAD.left - 6}
              y={y(v) + 3}
              textAnchor="end"
              fill="var(--text-tertiary)"
              style={{ font: "9px var(--font-mono)" }}
            >
              {Math.round(v)}
            </text>
          ))}
        <text
          x={PAD.left - 6}
          y={y(50) + 3}
          textAnchor="end"
          fill="var(--text-tertiary)"
          style={{ font: "9px var(--font-mono)" }}
        >
          50
        </text>
        {/* x axis: the epoch ordinals */}
        {ordinals.map((s, i) => (
          <text
            key={s}
            x={x(i)}
            y={HEIGHT - 10}
            textAnchor="middle"
            fill="var(--text-tertiary)"
            style={{ font: "9px var(--font-mono)" }}
          >
            {s}
          </text>
        ))}
        {layered.map((id) => {
          const style = strokeFor(id);
          return (
            <path
              key={id}
              d={pathFor(series[id] ?? [])}
              fill="none"
              stroke={style.stroke}
              strokeWidth={style.width}
              strokeOpacity={style.opacity}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ cursor: "pointer" }}
              onClick={() => onPick(id)}
            >
              <title>{id}</title>
            </path>
          );
        })}
        {labels.map((l) => (
          <text
            key={l.id}
            x={WIDTH - PAD.right + 6}
            y={l.y + 3}
            fill={l.id === pinned ? "var(--pink-500)" : "var(--text-secondary)"}
            style={{ font: "10px var(--font-mono)", cursor: "pointer" }}
            onClick={() => onPick(l.id)}
          >
            {l.id.length > 16 ? `${l.id.slice(0, 15)}…` : l.id}
          </text>
        ))}
      </svg>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 12px",
          padding: "0 16px 14px",
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
        }}
      >
        <span>
          {t("home.chart.legend", { n: Math.min(TOP_N, order.length) })}
        </span>
        {top.map((id, i) => (
          // Two acts, two controls. Clicking the name follows the line on this chart; the arrow
          // opens the agent's page. They were one control, and a reader looking for the page
          // clicked the first name on the screen and nothing navigated (issue #84 O).
          <span
            key={id}
            style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
          >
            <button
              type="button"
              onClick={() => onPick(id)}
              title={t("home.pinTitle")}
              style={{
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                color:
                  id === pinned ? "var(--pink-500)" : "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: "14px",
                  height: "2px",
                  background:
                    id === pinned ? "var(--pink-500)" : "var(--accent-primary)",
                  opacity: id === pinned ? 1 : 0.95 - i * 0.07,
                }}
              />
              {id}
            </button>
            <button
              type="button"
              onClick={() => navigate(`/agent/${encodeURIComponent(id)}`)}
              title={t("home.chart.openAgent", { id })}
              aria-label={t("home.chart.openAgent", { id })}
              style={{
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                color: "var(--text-link)",
              }}
            >
              ↗
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
