import { useEffect, useState } from "react";
import { buildRoundsProgress } from "@/data/seed";
import type { RoundInfo, RoundProgressSegment } from "@/data/types";

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

function RoundSegment({ segment, liveFillPercent }: { segment: RoundProgressSegment; liveFillPercent: number }) {
  const fillPercent = segment.status === "done" ? 100 : segment.status === "live" ? liveFillPercent : 0;
  const fillColor = segment.status === "done" ? "var(--purple-600)" : segment.status === "live" ? "var(--pink-500)" : "transparent";
  return (
    <div
      style={{
        flex: 1,
        height: "40px",
        position: "relative",
        background: segment.status === "upcoming" ? "var(--gray-900)" : "var(--bg-surface)",
        boxShadow: "inset 2px 0 0 var(--bg-canvas), inset 3px 0 0 var(--border-strong)",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${fillPercent}%`, background: fillColor }} />
      {segment.status === "live" && (
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
          color: segment.status === "upcoming" ? "var(--text-tertiary)" : "var(--gray-50)",
          background: segment.status === "live" ? "var(--gray-950)" : "transparent",
          padding: "1px 3px",
        }}
      >
        {segment.n}
      </span>
    </div>
  );
}

export function RoundsBar({ round }: { round: RoundInfo }) {
  const now = useNow();
  const { liveRoundLabel, totalRounds, roundsProgress } = buildRoundsProgress(round.roundNumber);
  const countdown = formatCountdown(Math.max(0, round.endsAt - now));
  const liveFillPercent = Math.min(100, Math.max(0, ((now - round.startsAt) / (round.endsAt - round.startsAt)) * 100));

  return (
    <div style={{ width: "100%", background: "var(--bg-sunken)", borderBottom: "1px solid var(--border-subtle)" }}>
      <div style={{ display: "flex", width: "100%" }}>
        {roundsProgress.map((segment) => (
          <RoundSegment key={segment.n} segment={segment} liveFillPercent={liveFillPercent} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "var(--space-2) var(--space-3)" }}>
        <span style={{ font: "var(--font-mono)", fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-widest)", color: "var(--pink-300)", textTransform: "uppercase" }}>
          Round {liveRoundLabel} of {totalRounds} · live
        </span>
        <span style={{ font: "var(--weight-bold) var(--text-lg) var(--font-mono)", color: "var(--pink-300)" }}>{countdown} left</span>
      </div>
    </div>
  );
}
