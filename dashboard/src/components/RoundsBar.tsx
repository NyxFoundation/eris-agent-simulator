// The run's rounds. A round is a scoring epoch (ADR 0019) — the unit the competition score is
// actually computed over — so the bar is the run's own epoch series, not a season of runs: one
// segment per epoch, filled by progress, and clicking one opens that round's result.
import { useEffect, useState } from "react";
import {
  REPLAY_SPEEDS,
  seekReplay,
  setReplayPlaying,
  setReplaySpeed,
  startReplay,
  stopReplay,
} from "@/data/replay";
import { setSelectedRound, useSelectedRound } from "@/data/roundSelection";
import { navigate } from "@/navigation";
import { formatBps, formatMove, formatPnlUsdc } from "@/lib/format";
import type { RoundEpoch, RoundInfo } from "@/data/types";

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function formatCountdown(remainingMs: number): string {
  const totalSec = Math.floor(remainingMs / 1000);
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** A live view only holds a recent window of the chain, so an older round has no count to report —
 * which is not the same statement as "no transactions", and must not print as one. */
function formatTxCount(txCount: number | null): string {
  return txCount === null
    ? "tx count outside the live window"
    : `${txCount} tx`;
}

const LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

function RoundSegment({
  epoch,
  selected,
  liveFillPercent,
  onSelect,
}: {
  epoch: RoundEpoch;
  selected: boolean;
  liveFillPercent: number;
  onSelect: () => void;
}) {
  const fillPercent =
    epoch.status === "done"
      ? 100
      : epoch.status === "live"
        ? liveFillPercent
        : 0;
  const fillColor =
    epoch.status === "done"
      ? "var(--purple-600)"
      : epoch.status === "live"
        ? "var(--pink-500)"
        : "transparent";
  return (
    <div
      onClick={onSelect}
      title={`Round ${epoch.index} · blocks ${epoch.fromBlock.toLocaleString("en-US")}–${epoch.toBlock.toLocaleString("en-US")} · ${formatTxCount(epoch.txCount)}`}
      style={{
        flex: 1,
        height: "40px",
        position: "relative",
        cursor: "pointer",
        background:
          epoch.status === "upcoming" ? "var(--gray-900)" : "var(--bg-surface)",
        boxShadow: selected
          ? "inset 0 3px 0 var(--pink-300), inset 0 0 0 1px var(--pink-300)"
          : "inset 2px 0 0 var(--bg-canvas), inset 3px 0 0 var(--border-strong)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: `${fillPercent}%`,
          background: fillColor,
        }}
      />
      {epoch.status === "live" && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${fillPercent}%`,
            width: "2px",
            background: "var(--gray-50)",
            boxShadow: "0 0 10px rgba(255,255,255,0.8)",
            animation: "marker-pulse 1.2s ease-in-out infinite",
          }}
        />
      )}
      <span
        style={{
          position: "absolute",
          top: "5px",
          left: "8px",
          font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
          letterSpacing: "var(--tracking-wide)",
          color:
            epoch.status === "upcoming"
              ? "var(--text-tertiary)"
              : "var(--gray-50)",
          background:
            epoch.status === "live" ? "var(--gray-950)" : "transparent",
          padding: "1px 3px",
        }}
      >
        {String(epoch.index).padStart(2, "0")}
      </span>
    </div>
  );
}

const RESULT_GRID = "28px minmax(0,1fr) 96px 90px 70px";

function RoundResults({ epoch }: { epoch: RoundEpoch }) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--border-subtle)",
        background: "var(--bg-surface)",
        padding: "12px 16px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "14px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            font: "var(--weight-bold) var(--text-md) var(--font-mono)",
            color: "var(--text-primary)",
          }}
        >
          Round {String(epoch.index).padStart(2, "0")}
        </span>
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          blocks {epoch.fromBlock.toLocaleString("en-US")}–
          {epoch.toBlock.toLocaleString("en-US")} ·{" "}
          {formatTxCount(epoch.txCount)}
        </span>
        <span
          onClick={() => {
            navigate("/explorer");
          }}
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-link)",
            cursor: "pointer",
          }}
        >
          open in explorer →
        </span>
        <span
          onClick={() => setSelectedRound(null)}
          style={{
            marginLeft: "auto",
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-link)",
            cursor: "pointer",
          }}
        >
          close ✕
        </span>
      </div>

      {epoch.results.length === 0 ? (
        <span
          style={{
            font: "var(--text-sm) var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          {epoch.status === "done"
            ? "this round was not scored — the run recorded no epoch series"
            : "scored after the run completes: the value series is reconstructed from historical block state (ADR 0006 §4)"}
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: RESULT_GRID,
              gap: "8px",
              padding: "0 0 6px",
              ...LABEL_STYLE,
            }}
          >
            <span>#</span>
            <span>Agent</span>
            <span style={{ textAlign: "right" }}>Δ value</span>
            <span style={{ textAlign: "right" }}>Log return</span>
            <span style={{ textAlign: "right" }}>Rank</span>
          </div>
          {epoch.results.map((row) => {
            const gainColor =
              row.deltaUsdc > 0
                ? "var(--success-text)"
                : row.deltaUsdc < 0
                  ? "var(--danger-text)"
                  : "var(--text-tertiary)";
            const moveColor =
              row.move === 0
                ? "var(--text-disabled)"
                : row.move > 0
                  ? "var(--success-text)"
                  : "var(--danger-text)";
            return (
              <div
                key={row.agent}
                onClick={() => navigate(`/agent/${row.agent}`)}
                style={{
                  display: "grid",
                  gridTemplateColumns: RESULT_GRID,
                  gap: "8px",
                  padding: "5px 0",
                  borderTop: "1px solid var(--border-subtle)",
                  font: "var(--text-sm) var(--font-mono)",
                  cursor: "pointer",
                }}
              >
                <span style={{ color: "var(--text-tertiary)" }}>
                  {row.rank}
                </span>
                <span
                  style={{
                    color: "var(--text-link)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.agent}
                  {row.bankrupt && (
                    <span
                      title="score frozen at the bankruptcy floor (ADR 0019 G1/G2)"
                      style={{ color: "var(--danger-text)" }}
                    >
                      {" "}
                      ✱
                    </span>
                  )}
                </span>
                <span style={{ textAlign: "right", color: gainColor }}>
                  {formatPnlUsdc(row.deltaUsdc)}
                </span>
                <span style={{ textAlign: "right", color: gainColor }}>
                  {formatBps(row.logReturnBps)}
                </span>
                <span
                  style={{ textAlign: "right", color: "var(--text-secondary)" }}
                >
                  {row.cumulativeRank}{" "}
                  <span style={{ color: moveColor }}>
                    {formatMove(row.move)}
                  </span>
                </span>
              </div>
            );
          })}
          <span
            style={{
              marginTop: "8px",
              font: "10px var(--font-mono)",
              color: "var(--text-tertiary)",
            }}
          >
            Δ value is the raw change in account value, market exposure included
            — which is why a do-nothing agent still moves with the price. Log
            return is the same round measured in excess of the roster's
            do-nothing baseline, and that is the quantity the score (mean −
            λ·std) averages. Rank is cumulative gain since the run's first
            boundary; the arrow is its change over this round.
          </span>
        </div>
      )}

      {epoch.events.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={LABEL_STYLE}>What the environment did</span>
          {epoch.events.map((e, i) => (
            <span
              key={i}
              style={{
                font: "var(--text-xs) var(--font-mono)",
                color: "var(--text-secondary)",
              }}
            >
              {e.time} — {e.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}


// Replay transport. An archived run is a complete record, so walking it forward is a matter of
// clamping what the views derive from -- the control here only moves the head.
function ReplayControls({ round }: { round: RoundInfo }) {
  const replay = round.replay;
  const first = round.epochs[0]?.fromBlock;
  const last = round.epochs[round.epochs.length - 1]?.toBlock;

  if (!replay) {
    // Replay needs a finished run with rounds to walk: a live run is already moving, and a run with
    // no epoch series has no boundaries to step between.
    if (round.status !== "archived" || first === undefined || last === undefined)
      return null;
    return (
      <span
        onClick={() => startReplay(round.runId, first, last)}
        title="Walk this run forward from its first block"
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-link)",
          cursor: "pointer",
        }}
      >
        ▶ replay
      </span>
    );
  }

  const done = replay.block >= replay.toBlock;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        flex: 1,
        minWidth: "260px",
      }}
    >
      <span
        onClick={() => setReplayPlaying(!replay.playing)}
        style={{
          font: "var(--text-sm) var(--font-mono)",
          color: "var(--pink-300)",
          cursor: "pointer",
          width: "14px",
        }}
        title={replay.playing ? "Pause" : done ? "Replay again" : "Play"}
      >
        {replay.playing ? "❚❚" : "▶"}
      </span>
      <input
        type="range"
        min={replay.fromBlock}
        max={replay.toBlock}
        value={replay.block}
        onChange={(e) => seekReplay(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0, accentColor: "var(--pink-500)" }}
      />
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-secondary)",
          whiteSpace: "nowrap",
        }}
      >
        blk {replay.block.toLocaleString("en-US")} /{" "}
        {replay.toBlock.toLocaleString("en-US")}
      </span>
      {REPLAY_SPEEDS.map((speed) => (
        <span
          key={speed}
          onClick={() => setReplaySpeed(speed)}
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color:
              replay.speed === speed ? "var(--pink-300)" : "var(--text-tertiary)",
            cursor: "pointer",
          }}
        >
          {speed}x
        </span>
      ))}
      <span
        onClick={stopReplay}
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-link)",
          cursor: "pointer",
        }}
      >
        exit
      </span>
    </div>
  );
}

export function RoundsBar({ round }: { round: RoundInfo }) {
  const now = useNow();
  const selectedRound = useSelectedRound();
  const running = round.status === "live";
  const countdown = formatCountdown(Math.max(0, round.endsAt - now));

  // The live segment fills by chain progress through its own block range, not by wall clock: the
  // bar is a block series, and a stalled chain should show a stalled round.
  const liveEpoch = round.epochs.find((e) => e.status === "live");
  const liveFillPercent = liveEpoch
    ? Math.min(
        100,
        Math.max(
          0,
          ((round.blockNumber - liveEpoch.fromBlock) /
            Math.max(1, liveEpoch.toBlock - liveEpoch.fromBlock)) *
            100,
        ),
      )
    : 100;

  const selected = round.epochs.find((e) => e.index === selectedRound) ?? null;
  const doneCount = round.epochs.filter((e) => e.status === "done").length;

  return (
    <div
      style={{
        width: "100%",
        background: "var(--bg-sunken)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {round.epochs.length > 0 ? (
        <div style={{ display: "flex", width: "100%" }}>
          {round.epochs.map((epoch) => (
            <RoundSegment
              key={epoch.index}
              epoch={epoch}
              selected={epoch.index === selectedRound}
              liveFillPercent={liveFillPercent}
              onSelect={() =>
                setSelectedRound(
                  epoch.index === selectedRound ? null : epoch.index,
                )
              }
            />
          ))}
        </div>
      ) : (
        <div
          style={{
            height: "40px",
            display: "flex",
            alignItems: "center",
            padding: "0 var(--space-3)",
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          no round series in this run (run.epochBlocks: 0, or the run is too
          short for one epoch)
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "var(--space-3)",
          padding: "var(--space-2) var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            font: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            letterSpacing: "var(--tracking-widest)",
            color: running ? "var(--pink-300)" : "var(--text-tertiary)",
            textTransform: "uppercase",
          }}
        >
          Run {round.runNumber} ·{" "}
          {round.replay ? "REPLAY" : running ? "live" : "archived"}
          {round.epochs.length > 0 && (
            <>
              {" · "}
              {doneCount}/{round.epochs.length} rounds
              {round.epochBlocks > 0 ? ` × ${round.epochBlocks} blocks` : ""}
            </>
          )}
        </span>
        <ReplayControls round={round} />
        <span
          style={{
            font: "var(--weight-bold) var(--text-lg) var(--font-mono)",
            color: running ? "var(--pink-300)" : "var(--text-tertiary)",
          }}
        >
          {round.replay
            ? `replay ${Math.round(((round.replay.block - round.replay.fromBlock) / Math.max(1, round.replay.toBlock - round.replay.fromBlock)) * 100)}%`
            : running
              ? `${countdown} left`
              : "completed"}
        </span>
      </div>
      {selected && <RoundResults epoch={selected} />}
    </div>
  );
}
