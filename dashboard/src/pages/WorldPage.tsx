// The world: one scenario as a board you can walk.
//
// Every other page in this dashboard answers "what happened" — the standings, a venue's state, a
// block range. This one answers "what does it look like while it happens": thirty-two wallets, the
// chain they all go through, the contracts they move, and one block at a time passing between them.
// It is the view the demo film is staged in, with the film's one missing affordance — you can stop
// it, and you can go back.
//
// The head is the page's own, deliberately. The competition cursor moves in rounds and the replay
// head refetches on every step; a walk over blocks needs neither, because the frames it steps
// through are already in the snapshot it was handed.

import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { WorldMap } from "@/components/WorldMap";
import {
  WorldTimeline,
  type WorldSpeed,
} from "@/components/WorldTimeline";
import { useWorldSnapshot } from "@/data/useWorldSnapshot";
import { useScenarioLabel } from "@/data/useScenarioLabel";
import { t } from "@/i18n/messages";
import { navigate } from "@/navigation";
import type { TapeTone } from "@/data/types";

/** One frame at 1x. A run's blocks are two seconds apart; the walk is a little quicker than real. */
const FRAME_MS = 1100;

const TONE_COLOR: Record<TapeTone, string> = {
  up: "var(--success-text)",
  down: "var(--danger-text)",
  accent: "var(--pink-300)",
  purple: "var(--purple-200)",
  neutral: "var(--text-primary)",
};

function Centered({ text, tone }: { text: string; tone?: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-canvas)",
      }}
    >
      <span
        style={{
          font: "var(--text-sm) var(--font-mono)",
          color: tone ?? "var(--text-tertiary)",
        }}
      >
        {text}
      </span>
    </div>
  );
}

export function WorldPage() {
  const { data, loading, error } = useWorldSnapshot();
  const scenario = useScenarioLabel();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<WorldSpeed>(1);

  const frames = useMemo(() => data?.frames ?? [], [data]);
  const last = Math.max(0, frames.length - 1);

  // A different run, or a different round of one, is a different walk: it starts at its own first
  // block rather than wherever the previous one had been left.
  const walkKey = `${data?.round.runId ?? ""}:${data?.scope.roundIndex ?? "all"}`;
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [walkKey]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const timer = window.setInterval(() => {
      setIndex((at) => {
        if (at >= last) {
          // Stop at the end rather than looping. A walk that silently restarts reads as a chain
          // that rewound, and this one never does.
          setPlaying(false);
          return last;
        }
        return at + 1;
      });
    }, FRAME_MS / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed, last, frames.length]);

  const at = Math.min(index, last);
  const frame = frames[at] ?? null;

  // The last scored cross-section at or before the head. Between boundaries an agent's figure is
  // the one it was last scored at, never an interpolation: nothing is scored inside a round.
  const pnlByAgent = useMemo(() => {
    if (!data || !frame) return {};
    let chosen: Record<string, number> = {};
    for (const boundary of data.boundaries) {
      if (boundary.block > frame.block) break;
      chosen = boundary.pnlUsdc;
    }
    return chosen;
  }, [data, frame]);

  if (loading) return <Centered text={t("common.loading")} />;
  if (error || !data)
    return (
      <Centered
        text={t("common.loadFailed", {
          detail: error ? `: ${error.message}` : "",
        })}
        tone="var(--danger-text)"
      />
    );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-canvas)",
        display: "flex",
        alignItems: "stretch",
      }}
    >
      <Sidebar activePage="world" />

      <div style={{ flex: 1, minWidth: 0 }}>
        <WorldTimeline
          frames={frames}
          index={at}
          playing={playing}
          speed={speed}
          onSeek={setIndex}
          onPlaying={setPlaying}
          onSpeed={setSpeed}
        />

        <header
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            padding: "var(--space-6) var(--space-6) var(--space-4)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <a
            onClick={() => navigate("/scenario")}
            style={{
              font: "var(--text-xs) var(--font-mono)",
              letterSpacing: "var(--tracking-wide)",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              cursor: "pointer",
              textDecoration: "none",
            }}
          >
            <span style={{ color: "var(--text-link)" }}>
              {t("units.scenario")}
            </span>
            {"  ›  "}
            {t("nav.world")}
          </a>
          <h1
            title={data.round.runId}
            style={{
              margin: 0,
              font: "var(--weight-bold) 21px var(--font-sans)",
              letterSpacing: "var(--tracking-tight)",
              color: "var(--text-primary)",
            }}
          >
            {scenario.name?.replace(/^full-/, "") ?? t("scenario.fallbackTitle")}
          </h1>
          <span
            style={{
              font: "var(--text-sm) var(--font-mono)",
              color: "var(--text-secondary)",
            }}
          >
            {[
              t("world.meta.agents", { n: data.agents.length }),
              t("world.meta.venues", { n: data.venues.length }),
              data.scope.roundIndex === null
                ? t("world.meta.wholeRun", {
                    from: data.scope.fromBlock.toLocaleString("en-US"),
                    to: data.scope.toBlock.toLocaleString("en-US"),
                  })
                : t("world.meta.round", { n: data.scope.roundIndex }),
              data.blocksPerFrame > 1
                ? t("world.meta.grouped", { n: data.blocksPerFrame })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </header>

        {frames.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: "var(--space-6)",
              font: "var(--text-sm) var(--font-sans)",
              color: "var(--text-tertiary)",
              lineHeight: 1.6,
            }}
          >
            {t("world.empty")}
          </p>
        ) : (
          <>
            <div style={{ padding: "var(--space-4) var(--space-6)" }}>
              <WorldMap
                agents={data.agents}
                venues={data.venues}
                frame={frame}
                pnlByAgent={pnlByAgent}
                frameMs={FRAME_MS / speed}
                fair={frame?.fair ?? null}
              />
            </div>

            <div
              style={{
                borderTop: "1px solid var(--border-subtle)",
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)",
              }}
            >
              <div style={{ padding: "var(--space-4) var(--space-6)" }}>
                <span
                  style={{
                    font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
                    letterSpacing: "var(--tracking-widest)",
                    textTransform: "uppercase",
                    color: "var(--text-secondary)",
                  }}
                >
                  {t("world.thisBlock")}
                </span>
                <div
                  style={{
                    marginTop: "10px",
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0,1fr))",
                    gap: "10px",
                  }}
                >
                  <Stat
                    label={t("world.stat.txs")}
                    value={String(frame?.txCount ?? 0)}
                  />
                  <Stat
                    label={t("world.stat.reverts")}
                    value={String(frame?.reverts ?? 0)}
                    tone={
                      (frame?.reverts ?? 0) > 0
                        ? "var(--danger-text)"
                        : undefined
                    }
                  />
                  <Stat
                    label={t("world.stat.senders")}
                    value={String(frame?.senderCount ?? 0)}
                  />
                </div>
              </div>

              <div
                style={{
                  borderLeft: "1px solid var(--border-subtle)",
                  padding: "var(--space-4) var(--space-6)",
                }}
              >
                <span
                  style={{
                    font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
                    letterSpacing: "var(--tracking-widest)",
                    textTransform: "uppercase",
                    color: "var(--text-secondary)",
                  }}
                >
                  {t("world.environment")}
                </span>
                <div style={{ marginTop: "10px" }}>
                  {frame && frame.events.length > 0 ? (
                    frame.events.map((event, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          gap: "10px",
                          padding: "4px 0",
                          font: "var(--text-xs) var(--font-mono)",
                        }}
                      >
                        <span
                          style={{
                            color: TONE_COLOR[event.tone],
                            minWidth: "88px",
                          }}
                        >
                          {event.kind}
                        </span>
                        <span style={{ color: "var(--text-secondary)" }}>
                          {event.text}
                        </span>
                      </div>
                    ))
                  ) : (
                    <span
                      style={{
                        font: "var(--text-xs) var(--font-mono)",
                        color: "var(--text-disabled)",
                      }}
                    >
                      {t("world.quiet")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm)",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
      }}
    >
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-wide)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-base) var(--font-mono)",
          color: tone ?? "var(--text-primary)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
