// What sits under the board: why one agent is doing what it is doing, and what the run has done to
// the numbers so far.
//
// Both follow the head rather than showing the finished run. That is the whole difference between
// this page and the rest of the dashboard: a chart drawn to the end of the run answers the question
// before the walk gets there, and a decision log scrolled to its last line is a transcript, not a
// thing you are watching happen.

import { useEffect, useMemo, useRef } from "react";
import { agentIcon, WorldIcon } from "@/components/WorldGlyphs";
import { decisionLogAbsence } from "@/data/logVisibility";
import { t } from "@/i18n/messages";
import { formatCompactUsd, formatPnlUsdc } from "@/lib/format";
import { navigate } from "@/navigation";
import type {
  LogTone,
  WorldAgentNode,
  WorldBoundary,
  WorldFrame,
  WorldLogLine,
  WorldVenueNode,
} from "@/data/types";

const TONE: Record<LogTone, string> = {
  info: "var(--text-tertiary)",
  success: "var(--success-text)",
  warning: "var(--warning-text)",
  danger: "var(--danger-text)",
};

const PANEL_TITLE = {
  font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-secondary)",
};

/**
 * One agent's own account of the run, up to the head.
 *
 * The lines are what the strategy wrote when it decided — the action it chose and the reason it
 * gave — plus the submits that came back reverted, which is the one mempool event worth a line: a
 * transaction that worked is already a dot crossing the board.
 */
export function AgentLogPanel({
  agent,
  agents,
  lines,
  headBlock,
  withheld,
}: {
  agent: string | null;
  agents: WorldAgentNode[];
  lines: WorldLogLine[] | undefined;
  headBlock: number | null;
  withheld: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const node = agents.find((a) => a.id === agent);
  // Which reason to give when there is nothing to list: the same rule as the agent page (#69).
  const absence = decisionLogAbsence(node?.external === true, withheld);

  // Only what has happened by the head. A log scrolled past the block the board is showing would
  // be telling the viewer what the agent is about to do.
  const upToHead = useMemo(
    () =>
      headBlock === null
        ? []
        : (lines ?? []).filter((l) => l.block <= headBlock).slice(-200),
    [lines, headBlock],
  );

  // Keep the newest line in view as the walk advances, the way a terminal does.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [upToHead.length, agent]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        height: "320px",
        padding: "var(--space-4) var(--space-6)",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <span style={{ ...PANEL_TITLE, display: "flex", alignItems: "center", gap: "8px" }}>
          <WorldIcon name="brain" size={14} color="var(--purple-200)" />
          {t("world.thinking")}
        </span>
        {node && (
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <WorldIcon
              name={agentIcon(node.strategyCategory, node.baseline)}
              size={13}
              color="var(--text-secondary)"
            />
            <a
              onClick={() => navigate(`/agent/${node.id}`)}
              style={{
                font: "var(--text-sm) var(--font-mono)",
                color: "var(--text-link)",
                cursor: "pointer",
              }}
            >
              {t("world.openAgent", { id: node.id })}
            </a>
          </span>
        )}
      </div>

      <div
        ref={listRef}
        style={{
          flex: 1,
          marginTop: "8px",
          overflowY: "auto",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-surface)",
        }}
      >
        {!agent ? (
          <Empty text={t("world.pickAgent")} />
        ) : absence === "audience" ? (
          <Empty text={t("world.logsWithheld")} />
        ) : absence === "self-hosted" ? (
          <Empty text={t("world.logExternal", { id: node?.id ?? "" })} />
        ) : upToHead.length === 0 ? (
          <Empty
            text={
              lines && lines.length > 0
                ? t("world.logNotYet", { id: agent })
                : t("world.logSilent", { id: agent })
            }
          />
        ) : (
          upToHead.map((line, i) => (
            <div
              key={`${line.block}-${i}`}
              style={{
                display: "grid",
                gridTemplateColumns: "72px 116px minmax(0,1fr)",
                gap: "10px",
                padding: "4px 11px",
                font: "var(--text-sm) var(--font-mono)",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-disabled)",
                }}
              >
                {line.block.toLocaleString("en-US")}
              </span>
              <span
                style={{
                  color: TONE[line.tone],
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {line.event}
              </span>
              <span
                style={{
                  color: "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={line.text}
              >
                {line.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p
      style={{
        margin: 0,
        padding: "14px 12px",
        font: "var(--text-xs) var(--font-sans)",
        lineHeight: 1.6,
        color: "var(--text-tertiary)",
      }}
    >
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// the two histories

const CHART_W = 560;
const CHART_H = 86;

/** A polyline over an already-indexed series, autoscaled with the rest of its chart. */
function line(
  points: (number | null)[],
  lo: number,
  hi: number,
  count: number,
): string {
  const span = hi - lo || 1;
  return points
    .map((v, i) =>
      v === null
        ? null
        : `${((i / Math.max(1, count - 1)) * CHART_W).toFixed(1)},${(
            CHART_H -
            ((v - lo) / span) * CHART_H
          ).toFixed(1)}`,
    )
    .filter(Boolean)
    .join(" ");
}

function bounds(series: (number | null)[][]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const points of series)
    for (const v of points)
      if (v !== null) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
  if (!Number.isFinite(lo)) return [0, 1];
  // Pad, so a flat stretch is a flat line across the middle rather than one pinned to an edge.
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.001 || 1;
  return [lo - pad, hi + pad];
}

function Chart({
  title,
  now,
  head,
  children,
  legend,
}: {
  title: string;
  now: string;
  /** Where the walk is, as a fraction of the chart's width. */
  head: number;
  children: React.ReactNode;
  legend: { label: string; color: string; dashed?: boolean }[];
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "8px",
        }}
      >
        <span style={PANEL_TITLE}>{title}</span>
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-secondary)",
          }}
        >
          {now}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: `${CHART_H}px`, display: "block", marginTop: "4px" }}
      >
        {children}
        {/* The head, on the same axis as the board above it. */}
        <line
          x1={head * CHART_W}
          x2={head * CHART_W}
          y1={0}
          y2={CHART_H}
          stroke="var(--pink-500)"
          strokeWidth={1.5}
        />
      </svg>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "10px",
          marginTop: "3px",
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
        }}
      >
        {legend.map((l) => (
          <span key={l.label} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span
              style={{
                width: "10px",
                height: "0",
                borderTop: `2px ${l.dashed ? "dashed" : "solid"} ${l.color}`,
                display: "inline-block",
              }}
            />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The two histories the board's numbers come from: what every venue quoted against the fair price,
 * and what the field was worth at each scored boundary.
 *
 * The balances are a step, not a curve, and deliberately so — nothing is marked between boundaries,
 * so a line drawn through the gap would be inventing the part of the run that is not scored.
 */
export function WorldCharts({
  frames,
  index,
  venues,
  boundaries,
  agents,
  selected,
}: {
  frames: WorldFrame[];
  index: number;
  venues: WorldVenueNode[];
  boundaries: WorldBoundary[];
  agents: WorldAgentNode[];
  /** The agent the balance chart names; the rest of the field is behind it. */
  selected: string | null;
}) {
  const head = frames.length > 1 ? index / (frames.length - 1) : 0;
  const frame = frames[index];

  // Only the venues that quote a price are lines. A utilisation and a discount share no axis with
  // a WETH mid, and putting them on one would make every price look flat.
  const priced = useMemo(
    () => venues.filter((v) => frames.some((f) => f.priceUsd[v.id] !== undefined)),
    [venues, frames],
  );

  const priceSeries = useMemo(() => {
    const fair = frames.map((f) => f.fairUsd);
    const byVenue = priced.map((v) => frames.map((f) => f.priceUsd[v.id] ?? null));
    return { fair, byVenue, range: bounds([fair, ...byVenue]) };
  }, [frames, priced]);

  // The balance chart shares the block axis with everything else, so a boundary sits where its
  // block sits — not at an even share of the width.
  const balance = useMemo(() => {
    const first = frames[0]?.fromBlock ?? 0;
    const last = frames[frames.length - 1]?.block ?? first + 1;
    const span = Math.max(1, last - first);
    const at = (block: number) => (block - first) / span;
    const others = agents.filter((a) => a.id !== selected).slice(0, 24);
    const seriesFor = (id: string) =>
      boundaries.map((b) => b.valueUsdc[id] ?? null);
    const mine = selected ? seriesFor(selected) : [];
    const rest = others.map((a) => seriesFor(a.id));
    return {
      xs: boundaries.map((b) => at(b.block)),
      mine,
      rest,
      range: bounds([...(mine.length ? [mine] : []), ...rest]),
    };
  }, [boundaries, agents, selected, frames]);

  const stepped = (xs: number[], values: (number | null)[], lo: number, hi: number) => {
    const span = hi - lo || 1;
    const y = (v: number) => CHART_H - ((v - lo) / span) * CHART_H;
    let d = "";
    let prev: number | null = null;
    values.forEach((v, i) => {
      if (v === null) return;
      const x = xs[i] * CHART_W;
      if (prev === null) d += `M${x.toFixed(1)},${y(v).toFixed(1)}`;
      else d += ` L${x.toFixed(1)},${y(prev).toFixed(1)} L${x.toFixed(1)},${y(v).toFixed(1)}`;
      prev = v;
    });
    return d;
  };

  const selectedValue = (() => {
    if (!selected || !frame) return null;
    let value: number | null = null;
    for (const b of boundaries) {
      if (b.block > frame.block) break;
      if (b.valueUsdc[selected] !== undefined) value = b.valueUsdc[selected];
    }
    return value;
  })();
  const selectedPnl = (() => {
    if (!selected || !frame) return null;
    let pnl: number | null = null;
    for (const b of boundaries) {
      if (b.block > frame.block) break;
      if (b.pnlUsdc[selected] !== undefined) pnl = b.pnlUsdc[selected];
    }
    return pnl;
  })();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        minWidth: 0,
        height: "320px",
        padding: "var(--space-4) var(--space-6)",
        boxSizing: "border-box",
        borderLeft: "1px solid var(--border-subtle)",
      }}
    >
      <Chart
        title={t("world.chart.price")}
        now={frame?.fair ? t("world.fair", { price: frame.fair }) : "—"}
        head={head}
        legend={[
          { label: t("world.chart.fairLegend"), color: "var(--text-tertiary)", dashed: true },
          ...priced.map((v) => ({ label: v.label, color: v.color })),
        ]}
      >
        <polyline
          points={line(priceSeries.fair, priceSeries.range[0], priceSeries.range[1], frames.length)}
          fill="none"
          stroke="var(--text-tertiary)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        {priced.map((v, i) => (
          <polyline
            key={v.id}
            points={line(
              priceSeries.byVenue[i],
              priceSeries.range[0],
              priceSeries.range[1],
              frames.length,
            )}
            fill="none"
            stroke={v.color}
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </Chart>

      <Chart
        title={t("world.chart.balance")}
        now={
          selectedValue === null
            ? t("world.chart.noBalance")
            : `${selected} ${formatCompactUsd(selectedValue)}${
                selectedPnl === null ? "" : ` (${formatPnlUsdc(selectedPnl)})`
              }`
        }
        head={head}
        legend={[
          { label: t("world.chart.selectedLegend"), color: "var(--pink-500)" },
          { label: t("world.chart.fieldLegend"), color: "var(--gray-500)" },
        ]}
      >
        {balance.rest.map((values, i) => (
          <path
            key={i}
            d={stepped(balance.xs, values, balance.range[0], balance.range[1])}
            fill="none"
            stroke="var(--gray-500)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {balance.mine.length > 0 && (
          <path
            d={stepped(balance.xs, balance.mine, balance.range[0], balance.range[1])}
            fill="none"
            stroke="var(--pink-500)"
            strokeWidth={1.8}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </Chart>
    </div>
  );
}
