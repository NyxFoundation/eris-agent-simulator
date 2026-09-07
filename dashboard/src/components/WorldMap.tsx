// The world, as one board: the agents on the left, the chain they all go through in the middle,
// the contracts holding state on the right, and this block's transactions travelling between them.
//
// Two decisions worth keeping. The dots are moved by writing attributes on a pool of pre-rendered
// circles inside one animation frame loop, not by React state — a component that re-rendered sixty
// times a second for twenty moving dots would make the rest of the page stutter. And a transaction
// changes a venue's number when it *lands*: the value under a node is the frame's, and the dot
// takes most of the frame to get there, which is what makes the board read as a chain rather than
// as a diagram with animation on it.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_MID_X,
  layoutWorld,
  MAP_W,
  pathD,
  pointAt,
  VENUE_MID_X,
  wirePoints,
  type Point,
} from "@/components/worldLayout";
import {
  agentIcon,
  venueIcon,
  WorldIcon,
  WorldSprite,
} from "@/components/WorldGlyphs";
import { t } from "@/i18n/messages";
import { formatCompactUsd, formatPnlUsdc } from "@/lib/format";
import type { WorldAgentNode, WorldFrame, WorldVenueNode } from "@/data/types";

/** Dots in flight at once. A block with more transactions than this shows the busiest of them. */
const DOT_POOL = 24;
/** Rows the chain panel lists. The rest are counted under it. */
const MEMPOOL_ROWS = 6;

const CATEGORY_COLOR: Record<string, string> = {
  arb: "var(--purple-200)",
  mm: "var(--amber-300)",
  dir: "var(--gray-200)",
};

interface Flight {
  toChain: Point[];
  toVenue: Point[] | null;
  /** ms from the frame's start. */
  start: number;
  ok: boolean;
}

export function WorldMap({
  agents,
  venues,
  frame,
  valueByAgent,
  pnlByAgent,
  selected,
  onSelect,
  frameMs,
  fair,
}: {
  agents: WorldAgentNode[];
  venues: WorldVenueNode[];
  frame: WorldFrame | null;
  /** Account value per agent at the last scored boundary at or before this frame. */
  valueByAgent: Record<string, number>;
  /** Gain per agent at that same boundary — the colour on the balance, not a second number. */
  pnlByAgent: Record<string, number>;
  /** Whose reasoning the panel below is following. */
  selected: string | null;
  onSelect: (agent: string) => void;
  /** How long one frame lasts on screen. Flights are timed against it. */
  frameMs: number;
  fair: string | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<(SVGCircleElement | null)[]>([]);
  const [scale, setScale] = useState(1);

  const layout = useMemo(
    () =>
      layoutWorld(
        agents.map((a) => a.id),
        venues.map((v) => v.id),
      ),
    [agents, venues],
  );

  // The board is drawn at map scale and shrunk to the column it is given; it never grows past 1:1,
  // where the chip text would start outrunning the type scale.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () =>
      setScale(Math.min(1, host.clientWidth / MAP_W) || 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const senders = useMemo(
    () => new Set((frame?.txs ?? []).map((tx) => tx.agent)),
    [frame],
  );
  const receivers = useMemo(
    () =>
      new Set(
        (frame?.txs ?? []).flatMap((tx) => (tx.venue ? [tx.venue] : [])),
      ),
    [frame],
  );

  // One flight per transaction: out to the chain, a beat while the block is assembled, then on to
  // the contract it touched. A transaction nothing names a venue for stops at the chain, which is
  // the honest picture — it was mined and this view cannot say where it went.
  useEffect(() => {
    const flights: Flight[] = [];
    const legOut = Math.max(160, frameMs * 0.34);
    const hold = Math.max(60, frameMs * 0.1);
    const legIn = Math.max(160, frameMs * 0.34);
    (frame?.txs ?? []).slice(0, DOT_POOL).forEach((tx, i) => {
      const from = layout.agents.get(tx.agent);
      if (!from) return;
      const venue = tx.venue ? layout.venues.get(tx.venue) : undefined;
      flights.push({
        toChain: wirePoints(from, layout.chain, AGENT_MID_X),
        toVenue:
          venue && tx.ok
            ? wirePoints(layout.chain, venue, VENUE_MID_X)
            : null,
        start: i * Math.min(40, frameMs / (DOT_POOL * 2)),
        ok: tx.ok,
      });
    });

    const dots = dotsRef.current;
    const hideAll = () => {
      for (const dot of dots) if (dot) dot.style.opacity = "0";
    };
    if (flights.length === 0) {
      hideAll();
      return;
    }

    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const time = now - t0;
      let alive = false;
      for (let i = 0; i < DOT_POOL; i++) {
        const dot = dots[i];
        if (!dot) continue;
        const flight = flights[i];
        if (!flight) {
          dot.style.opacity = "0";
          continue;
        }
        const local = time - flight.start;
        let at: Point | null = null;
        let color = "var(--pink-500)";
        if (local < 0) {
          at = null;
          alive = true;
        } else if (local < legOut) {
          at = pointAt(flight.toChain, local / legOut);
          alive = true;
        } else if (local < legOut + hold) {
          at = null;
          alive = true;
        } else if (
          flight.toVenue &&
          local < legOut + hold + legIn
        ) {
          at = pointAt(flight.toVenue, (local - legOut - hold) / legIn);
          color = "var(--success-text)";
          alive = true;
        } else if (!flight.ok && local < legOut + hold + legIn) {
          // A reverted transaction was in the block and paid for it; it just did not arrive. It
          // turns red at the chain instead of continuing to a contract it never reached.
          at = pointAt(flight.toChain, 1);
          color = "var(--danger-text)";
          alive = true;
        }
        if (at) {
          dot.setAttribute("cx", at.x.toFixed(1));
          dot.setAttribute("cy", at.y.toFixed(1));
          // The colour goes through the inline style, not the `fill` attribute: a design token is a
          // CSS variable, and a presentation attribute is not a reliable place to resolve one.
          dot.style.fill = color;
          dot.style.opacity = "1";
        } else {
          dot.style.opacity = "0";
        }
      }
      if (alive) raf = requestAnimationFrame(step);
      else hideAll();
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      hideAll();
    };
  }, [frame, frameMs, layout]);

  // Six of the block, and which six matters: the environment writes the price at the top of every
  // block and pays the most for it, so the first six by block order are six identical oracle rows
  // and the competition is exactly the part that falls off. Pick the field first, then put the
  // chosen rows back in block order -- the panel is a sample of the block, never a re-ordering of it.
  const listed = useMemo(() => {
    const txs = frame?.txs ?? [];
    const pick = new Set(
      [
        ...txs.filter((tx) => tx.kind === "agent"),
        ...txs.filter((tx) => tx.kind !== "agent"),
      ].slice(0, MEMPOOL_ROWS),
    );
    return txs.filter((tx) => pick.has(tx));
  }, [frame]);
  const hidden = (frame?.txCount ?? 0) - listed.length;

  return (
    <div ref={hostRef} style={{ width: "100%", overflow: "hidden" }}>
      <WorldSprite />
      <div
        style={{
          position: "relative",
          width: `${layout.width}px`,
          height: `${layout.height}px`,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          marginBottom: `${-(1 - scale) * layout.height}px`,
        }}
      >
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {agents.map((agent) => {
            const box = layout.agents.get(agent.id);
            if (!box) return null;
            return (
              <path
                key={agent.id}
                d={pathD(wirePoints(box, layout.chain, AGENT_MID_X))}
                fill="none"
                stroke={
                  senders.has(agent.id)
                    ? "var(--purple-500)"
                    : "var(--gray-700)"
                }
                strokeWidth={senders.has(agent.id) ? 1.4 : 0.8}
              />
            );
          })}
          {venues.map((venue) => {
            const box = layout.venues.get(venue.id);
            if (!box) return null;
            return (
              <path
                key={venue.id}
                d={pathD(wirePoints(layout.chain, box, VENUE_MID_X))}
                fill="none"
                stroke={
                  receivers.has(venue.id)
                    ? "var(--purple-500)"
                    : "var(--gray-700)"
                }
                strokeWidth={receivers.has(venue.id) ? 1.4 : 0.8}
              />
            );
          })}
          {Array.from({ length: DOT_POOL }, (_, i) => (
            <circle
              key={i}
              ref={(el) => {
                dotsRef.current[i] = el;
              }}
              r={3.4}
              cx={-10}
              cy={-10}
              style={{ opacity: 0 }}
            />
          ))}
        </svg>

        <ColumnHeading x={24} label={t("world.col.agents", { n: agents.length })} />
        <ColumnHeading x={layout.chain.x} label={t("world.col.chain")} />
        <ColumnHeading x={980} label={t("world.col.contracts")} />

        {agents.map((agent) => {
          const box = layout.agents.get(agent.id);
          if (!box) return null;
          const value = valueByAgent[agent.id];
          const pnl = pnlByAgent[agent.id];
          const isSelected = agent.id === selected;
          return (
            <div
              key={agent.id}
              className="row-link"
              onClick={() => onSelect(agent.id)}
              title={[
                agent.id,
                agent.address,
                value === undefined
                  ? t("world.chip.unscored")
                  : t("world.chip.balance", {
                      usd: value.toLocaleString("en-US", {
                        maximumFractionDigits: 2,
                      }),
                    }),
                pnl === undefined ? null : t("world.chip.pnl", { pnl: formatPnlUsdc(pnl) }),
              ]
                .filter(Boolean)
                .join(" · ")}
              style={{
                position: "absolute",
                left: `${box.x}px`,
                top: `${box.y}px`,
                width: `${box.w}px`,
                height: `${box.h}px`,
                display: "grid",
                gridTemplateColumns: "13px minmax(0,1fr) auto",
                alignItems: "center",
                gap: "8px",
                padding: "0 9px",
                boxSizing: "border-box",
                border: `1px solid ${
                  isSelected
                    ? "var(--pink-500)"
                    : senders.has(agent.id)
                      ? "var(--purple-400)"
                      : "var(--border-subtle)"
                }`,
                borderRadius: "var(--radius-sm)",
                background: senders.has(agent.id)
                  ? "var(--bg-surface-raised)"
                  : "var(--bg-surface)",
                boxShadow: isSelected ? "inset 2px 0 0 var(--pink-500)" : undefined,
              }}
            >
              <WorldIcon
                name={agentIcon(agent.strategyCategory, agent.baseline)}
                size={13}
                color={CATEGORY_COLOR[agent.strategyCategory] ?? "var(--gray-300)"}
              />
              <span
                style={{
                  font: "var(--text-sm) var(--font-mono)",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {agent.id}
              </span>
              {/* The balance, coloured by whether the run has been kind to it. Two numbers on a
                  node is a dashboard, and the eye stops following the motion — the gain is on the
                  hover and in the chart below. */}
              <span
                style={{
                  font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
                  color:
                    value === undefined
                      ? "var(--text-disabled)"
                      : pnl === undefined || pnl === 0
                        ? "var(--text-secondary)"
                        : pnl > 0
                          ? "var(--success-text)"
                          : "var(--danger-text)",
                }}
              >
                {value === undefined ? "·" : formatCompactUsd(value)}
              </span>
            </div>
          );
        })}

        <div
          style={{
            position: "absolute",
            left: `${layout.chain.x}px`,
            top: `${layout.chain.y}px`,
            width: `${layout.chain.w}px`,
            height: `${layout.chain.h}px`,
            boxSizing: "border-box",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-surface)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              padding: "9px 11px 7px",
              font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
              letterSpacing: "var(--tracking-wide)",
              textTransform: "uppercase",
              color: "var(--text-secondary)",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <WorldIcon name="chain" size={14} color="var(--purple-200)" />
              {frame
                ? frame.fromBlock === frame.block
                  ? t("world.block", { n: frame.block.toLocaleString("en-US") })
                  : t("world.blockRange", {
                      from: frame.fromBlock.toLocaleString("en-US"),
                      to: frame.block.toLocaleString("en-US"),
                    })
                : t("world.block", { n: "—" })}
            </span>
            <span style={{ color: "var(--text-tertiary)" }}>
              {fair ? t("world.fair", { price: fair }) : frame?.clock}
            </span>
          </div>
          <div
            style={{
              height: "3px",
              background: "var(--bg-sunken)",
              overflow: "hidden",
            }}
          >
            <div
              key={frame?.block ?? "idle"}
              style={{
                height: "100%",
                background: "var(--purple-400)",
                animation: `world-slot ${frameMs}ms linear forwards`,
              }}
            />
          </div>
          <div style={{ flex: 1, overflow: "hidden" }}>
            {listed.length === 0 && (
              <div
                style={{
                  padding: "12px 10px",
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-disabled)",
                }}
              >
                {t("world.emptyBlock")}
              </div>
            )}
            {listed.map((tx) => (
              <div
                key={tx.hash}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0,1.1fr) minmax(0,1fr) 62px",
                  gap: "8px",
                  alignItems: "baseline",
                  padding: "5px 11px",
                  borderBottom: "1px solid var(--border-subtle)",
                  font: "var(--text-sm) var(--font-mono)",
                  opacity: tx.ok ? 1 : 0.65,
                }}
              >
                <span
                  style={{
                    color: !tx.ok
                      ? "var(--danger-text)"
                      : tx.kind === "environment"
                        ? "var(--text-tertiary)"
                        : "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tx.method}
                </span>
                <span
                  style={{
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tx.agent}
                </span>
                <span
                  style={{
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    textAlign: "right",
                  }}
                >
                  {tx.fee}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              padding: "6px 10px",
              borderTop: "1px solid var(--border-subtle)",
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>
              {hidden > 0 ? t("world.moreTxs", { n: hidden }) : " "}
            </span>
            <span>
              {frame && frame.reverts > 0
                ? t("world.reverted", { n: frame.reverts })
                : " "}
            </span>
          </div>
        </div>

        {venues.map((venue) => {
          const box = layout.venues.get(venue.id);
          if (!box) return null;
          const value = frame?.venueValues[venue.id];
          return (
            <div
              key={venue.id}
              style={{
                position: "absolute",
                left: `${box.x}px`,
                top: `${box.y}px`,
                width: `${box.w}px`,
                height: `${box.h}px`,
                boxSizing: "border-box",
                padding: "7px 10px",
                border: `1px solid ${receivers.has(venue.id) ? "var(--purple-400)" : "var(--border-subtle)"}`,
                borderRadius: "var(--radius-sm)",
                background: receivers.has(venue.id)
                  ? "var(--bg-surface-raised)"
                  : "var(--bg-surface)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
                  color: "var(--text-primary)",
                }}
              >
                <WorldIcon name={venueIcon(venue.kind)} size={14} color={venue.color} />
                {venue.label}
              </span>
              <span
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                <span>{venue.metric}</span>
                <span
                  style={{
                    font: "var(--weight-semibold) var(--text-base) var(--font-mono)",
                    color: value
                      ? "var(--text-primary)"
                      : "var(--text-disabled)",
                  }}
                >
                  {value ?? "—"}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ColumnHeading({ x, label }: { x: number; label: string }) {
  return (
    <span
      style={{
        position: "absolute",
        left: `${x}px`,
        top: "4px",
        font: "var(--text-xs) var(--font-mono)",
        letterSpacing: "var(--tracking-wide)",
        textTransform: "uppercase",
        color: "var(--text-tertiary)",
      }}
    >
      {label}
    </span>
  );
}
