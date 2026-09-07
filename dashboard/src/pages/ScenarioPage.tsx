// One scenario: a world you can walk.
//
// This is the scenario level of the dashboard (competition ⊃ scenario ⊃ round). Every page above
// and beside it answers "what happened" — the standings, a venue's state, a block range. This one
// answers "what does it look like while it happens": the wallets on the left, the chain they all go
// through, the contracts they move, and one block at a time passing between them. It is the view
// the demo film is staged in, with the film's one missing affordance — you can stop it, and you can
// go back. It used to be a landing page of previews (market tiles, a ranking, seven blocks) with the
// board on a tab of its own; the previews were the board's numbers without the time axis, so the
// board is the page.
//
// Two clocks meet here and only one is the page's. The rounds bar is the competition cursor —
// round k of every world — and the block axis walks the frames inside the selected round, or the
// whole run. The walk's head is local state rather than the replay head: the replay head refetches
// every snapshot on every step, and a walk over frames the snapshot already holds needs no fetch.
// When the reader leaves the page mid-walk the head is handed to the replay store once, so /markets
// and /explorer open at the block the board was on rather than at the end of the run.

import { useEffect, useMemo, useRef, useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { WorldMap } from "@/components/WorldMap";
import { AgentLogPanel, WorldCharts } from "@/components/WorldPanels";
import { WorldTimeline, type WorldSpeed } from "@/components/WorldTimeline";
import { useMode } from "@/data/mode";
import { getReplay, replayHeadFor, seekReplay, startReplay } from "@/data/replay";
import { useScenarioLabel } from "@/data/useScenarioLabel";
import { useWorldSnapshot } from "@/data/useWorldSnapshot";
import { t } from "@/i18n/messages";
import { formatScore } from "@/lib/format";
import { navigate } from "@/navigation";
import type { AgentStanding, RoundInfo, TapeTone } from "@/data/types";

/** One frame at 1x. A run's blocks are two seconds apart; the walk is a little quicker than real. */
const FRAME_MS = 1100;

const TONE_COLOR: Record<TapeTone, string> = {
  up: "var(--success-text)",
  down: "var(--danger-text)",
  accent: "var(--pink-300)",
  purple: "var(--purple-200)",
  neutral: "var(--text-primary)",
};

const PANEL_TITLE = {
  font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-secondary)",
};

const COLUMN_LABEL = {
  font: "var(--text-xs) var(--font-mono)",
  color: "var(--text-tertiary)",
  letterSpacing: "var(--tracking-wide)",
  textTransform: "uppercase" as const,
};

/** Where the replay head goes when the reader leaves mid-walk. */
interface Handover {
  runId: string;
  status: RoundInfo["status"];
  fromBlock: number | undefined;
  toBlock: number | undefined;
  block: number;
  atEnd: boolean;
}

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

const STANDINGS_GRID = "44px minmax(0,1fr) 72px";

/**
 * The ranking within this world, beside the board. A row picks that wallet on the board — its log
 * and its line in the charts follow — and the agent's own page is one link away in the log panel.
 */
function ScenarioStandings({
  rows,
  closedRounds,
  selected,
  onSelect,
  shown,
}: {
  rows: AgentStanding[];
  /** How many rounds had closed at the walk's block: the rounds the ranking is through. */
  closedRounds: number;
  selected: string | null;
  onSelect: (agent: string) => void;
  /** Rules §4.7: the trial environment posts no standings, and a per-world ranking is one. */
  shown: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        height: "320px",
        padding: "var(--space-4) var(--space-6)",
        boxSizing: "border-box",
        borderRight: "1px solid var(--border-subtle)",
      }}
    >
      <span style={PANEL_TITLE}>
        {closedRounds > 0
          ? t("home.standingsThrough", { at: closedRounds })
          : t("scenario.standings")}
      </span>
      <div
        style={{
          flex: 1,
          marginTop: "8px",
          overflowY: "auto",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-surface)",
        }}
      >
        {!shown ? (
          <p
            style={{
              margin: 0,
              padding: "12px 14px",
              font: "var(--text-xs) var(--font-sans)",
              lineHeight: 1.6,
              color: "var(--text-tertiary)",
            }}
          >
            {t("home.standingsOff")}
          </p>
        ) : closedRounds === 0 ? (
          <p
            style={{
              margin: 0,
              padding: "12px 14px",
              font: "var(--text-xs) var(--font-sans)",
              lineHeight: 1.6,
              color: "var(--text-tertiary)",
            }}
          >
            {t("world.chart.noBalance")}
          </p>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: STANDINGS_GRID,
                gap: "6px",
                padding: "6px 12px",
                background: "var(--bg-surface-raised)",
                borderBottom: "1px solid var(--border-subtle)",
                position: "sticky",
                top: 0,
              }}
            >
              <span style={COLUMN_LABEL}>{t("rounds.col.rank")}</span>
              <span style={COLUMN_LABEL}>{t("home.col.agent")}</span>
              <span
                title={t("agent.standing.score")}
                style={{ ...COLUMN_LABEL, textAlign: "right" }}
              >
                {t("home.col.score")}
              </span>
            </div>
            {rows.map((row) => {
              const picked = row.agent === selected;
              const moveColor =
                row.move === 0
                  ? "var(--text-disabled)"
                  : row.move > 0
                    ? "var(--success-text)"
                    : "var(--danger-text)";
              const moveLabel =
                row.move === 0
                  ? "—"
                  : row.move > 0
                    ? `+${row.move}`
                    : String(row.move);
              return (
                <div
                  key={row.agent}
                  onClick={() => onSelect(row.agent)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: STANDINGS_GRID,
                    gap: "6px",
                    alignItems: "center",
                    padding: "5px 12px",
                    borderBottom: "1px solid var(--border-subtle)",
                    cursor: "pointer",
                    background: picked ? "var(--bg-surface-raised)" : "transparent",
                    boxShadow: picked ? "inset 2px 0 0 var(--pink-300)" : undefined,
                  }}
                >
                  <span style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
                    <span
                      style={{
                        font: "var(--weight-bold) var(--text-md) var(--font-mono)",
                        color: row.rank <= 3 ? "var(--pink-300)" : "var(--text-secondary)",
                        lineHeight: 1,
                      }}
                    >
                      {String(row.rank).padStart(2, "0")}
                    </span>
                    <span
                      style={{
                        font: "10px var(--font-mono)",
                        color: moveColor,
                        lineHeight: 1,
                      }}
                    >
                      {moveLabel}
                    </span>
                  </span>
                  <span
                    style={{
                      font: "var(--text-sm) var(--font-mono)",
                      color: picked ? "var(--text-primary)" : "var(--text-link)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.agent}
                  </span>
                  <span
                    style={{
                      font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
                      color: "var(--text-primary)",
                      textAlign: "right",
                    }}
                  >
                    {formatScore(row.score)}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export function ScenarioPage() {
  const { data, loading, error } = useWorldSnapshot();
  const scenario = useScenarioLabel();
  const mode = useMode();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<WorldSpeed>(1);
  const [picked, setPicked] = useState<string | null>(null);
  // Whether the reader has moved the walk at all. A page left where it opened hands nothing over.
  const movedRef = useRef(false);

  const frames = useMemo(() => data?.frames ?? [], [data]);
  const last = Math.max(0, frames.length - 1);
  // Read by the walk-reset effect below without being one of its dependencies: a live run's
  // snapshot refreshes every few seconds, and a refresh must not send the walk back to the start.
  const framesRef = useRef(frames);
  framesRef.current = frames;

  // A different run, or a different round of one, is a different walk: it starts at its own first
  // block rather than wherever the previous one had been left — unless a replay is armed for this
  // run, which marks where the reader left the board, and the walk opens there.
  const runId = data?.round.runId ?? null;
  const walkKey = `${runId ?? ""}:${data?.scope.roundIndex ?? "all"}`;
  useEffect(() => {
    const head = runId === null ? null : replayHeadFor(runId);
    const list = framesRef.current;
    let start = 0;
    if (head !== null) {
      const i = list.findIndex((f) => f.block >= head);
      start = i < 0 ? Math.max(0, list.length - 1) : i;
    }
    setIndex(start);
    setPlaying(false);
    setPicked(null);
    movedRef.current = false;
  }, [walkKey, runId]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    movedRef.current = true;
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

  // The hand-over, on the way out. An archived run gets the replay armed at the walk's block; a
  // run already being replayed has its head moved. A walk that reached the end hands over nothing:
  // the other pages' default is the whole run, and arming a replay parked at its last block would
  // only label the same view "replay".
  const handoverRef = useRef<Handover | null>(null);
  handoverRef.current =
    data && frame
      ? {
          runId: data.round.runId,
          status: data.round.status,
          fromBlock: data.round.epochs[0]?.fromBlock,
          toBlock: data.round.epochs[data.round.epochs.length - 1]?.toBlock,
          block: frame.block,
          atEnd: at >= last,
        }
      : null;
  useEffect(
    () => () => {
      const h = handoverRef.current;
      if (!h || !movedRef.current || h.atEnd) return;
      if (h.status === "archived") {
        if (h.fromBlock === undefined || h.toBlock === undefined) return;
        startReplay(h.runId, h.fromBlock, h.toBlock);
        seekReplay(h.block);
      } else if (h.status === "replay" && getReplay().runId === h.runId) {
        seekReplay(h.block);
      }
    },
    [],
  );

  // The last scored cross-section at or before the head. Between boundaries an agent's figure is
  // the one it was last scored at, never an interpolation: nothing is scored inside a round.
  const marks = useMemo(() => {
    if (!data || !frame) return { valueUsdc: {}, pnlUsdc: {} };
    let chosen = { valueUsdc: {}, pnlUsdc: {} } as {
      valueUsdc: Record<string, number>;
      pnlUsdc: Record<string, number>;
    };
    for (const boundary of data.boundaries) {
      if (boundary.block > frame.block) break;
      chosen = { valueUsdc: boundary.valueUsdc, pnlUsdc: boundary.pnlUsdc };
    }
    return chosen;
  }, [data, frame]);

  // Whose reasoning the panel follows. Nobody has picked yet on first load, so it opens on the
  // agent that traded most in this window -- the one whose log has something in it.
  const busiest = useMemo(() => {
    if (!data) return null;
    const counts = new Map<string, number>();
    for (const f of data.frames)
      for (const tx of f.txs)
        if (tx.kind === "agent")
          counts.set(tx.agent, (counts.get(tx.agent) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [data]);
  const selected = picked ?? busiest;

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

  const { round } = data;
  const seek = (i: number) => {
    movedRef.current = true;
    setIndex(i);
  };

  // The standings beside the board are the field through the rounds closed by the walk's block.
  // The finished run's ranking beside a walk would be the answer printed on every frame.
  const closedAtHead = frame
    ? round.epochs.filter((e) => e.toBlock <= frame.block).length
    : round.epochs.filter((e) => e.status === "done").length;
  const standings =
    data.standingsThroughRound[
      Math.min(closedAtHead, data.standingsThroughRound.length - 1)
    ] ?? [];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-canvas)",
        display: "flex",
        alignItems: "stretch",
      }}
    >
      <Sidebar activePage="scenario" />

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* The competition's clock: which round this world is scoped to. Its replay transport is
            off here, because the block axis below is this page's own. */}
        <RoundsBar round={round} transport={false} />

        {/* The page header, in the standings page's grammar: the scenario's name at heading size,
            one meta line, nothing decorative. */}
        <header
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            padding: "var(--space-6) var(--space-6) var(--space-4)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {/* Which unit is on screen, and what it sits inside. A scenario opened from the
              standings otherwise looks like a page in its own right, and "round 14" on it reads as
              a round of the competition rather than of this one world. */}
          <a
            onClick={() => navigate("/")}
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
              {t("units.competition")}
            </span>
            {"  ›  "}
            {t("units.scenario")}
          </a>
          {/* The scenario names itself (regime#seed, or a practice period's day). */}
          <h1
            title={round.runId}
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
              scenario.seed !== null
                ? t("scenario.seed", { n: scenario.seed })
                : null,
              round.epochs.length > 0
                ? t("scenario.roundsBlocks", {
                    rounds: round.epochs.length,
                    blocks: round.epochBlocks,
                  })
                : null,
              scenario.competition,
              scenario.name === null ? round.runId : null,
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
          <>
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
            <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
              <ScenarioStandings
                rows={standings}
                closedRounds={closedAtHead}
                selected={selected}
                onSelect={setPicked}
                shown={mode.standings}
              />
            </div>
          </>
        ) : (
          <>
            <WorldTimeline
              frames={frames}
              index={at}
              playing={playing}
              speed={speed}
              onSeek={seek}
              onPlaying={setPlaying}
              onSpeed={setSpeed}
            />

            <div style={{ padding: "var(--space-4) var(--space-6)" }}>
              <WorldMap
                agents={data.agents}
                venues={data.venues}
                frame={frame}
                valueByAgent={marks.valueUsdc}
                pnlByAgent={marks.pnlUsdc}
                selected={selected}
                onSelect={setPicked}
                frameMs={FRAME_MS / speed}
                fair={frame?.fair ?? null}
              />
            </div>

            {/* One strip for what this block was, then the three panels the board's numbers come
                from: where everyone stands in this world, why one agent is doing this, and what the
                run has done to the prices and the balances so far. */}
            <div
              style={{
                borderTop: "1px solid var(--border-subtle)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-6)",
                flexWrap: "wrap",
                padding: "10px var(--space-6)",
              }}
            >
              <span style={PANEL_TITLE}>{t("world.thisBlock")}</span>
              <Stat label={t("world.stat.txs")} value={String(frame?.txCount ?? 0)} />
              <Stat
                label={t("world.stat.reverts")}
                value={String(frame?.reverts ?? 0)}
                tone={(frame?.reverts ?? 0) > 0 ? "var(--danger-text)" : undefined}
              />
              <Stat
                label={t("world.stat.senders")}
                value={String(frame?.senderCount ?? 0)}
              />
              <span
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                  minWidth: 0,
                  textAlign: "right",
                }}
              >
                <span style={COLUMN_LABEL}>{t("world.environment")}</span>
                {frame && frame.events.length > 0 ? (
                  frame.events.map((event, i) => (
                    <span
                      key={i}
                      style={{
                        font: "var(--text-xs) var(--font-mono)",
                        color: TONE_COLOR[event.tone],
                      }}
                    >
                      {event.kind} · {event.text}
                    </span>
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
              </span>
            </div>

            <div
              style={{
                borderTop: "1px solid var(--border-subtle)",
                display: "grid",
                gridTemplateColumns:
                  "minmax(0,0.72fr) minmax(0,1fr) minmax(0,1.15fr)",
              }}
            >
              <ScenarioStandings
                rows={standings}
                closedRounds={closedAtHead}
                selected={selected}
                onSelect={setPicked}
                shown={mode.standings}
              />
              <AgentLogPanel
                agent={selected}
                agents={data.agents}
                lines={selected ? data.agentLog[selected] : undefined}
                headBlock={frame?.block ?? null}
                withheld={data.logsWithheld}
              />
              <WorldCharts
                frames={frames}
                index={at}
                venues={data.venues}
                boundaries={data.boundaries}
                agents={data.agents}
                selected={selected}
              />
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
        display: "flex",
        alignItems: "baseline",
        gap: "7px",
      }}
    >
      <span style={COLUMN_LABEL}>{label}</span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
          color: tone ?? "var(--text-primary)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
