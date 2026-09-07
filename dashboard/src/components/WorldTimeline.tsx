// The transport for the world map: where the walk is, and every way of moving it.
//
// The bar is the run's block axis, not a progress meter that fills while you wait — the point of it
// is going *back*. Click or drag anywhere on it to land there, step a block at a time with the
// arrows, or jump to the start. Round boundaries are ticked on the bar so a position can be read as
// "round 7, third block" rather than as a percentage of a file.

import { useCallback, useEffect, useRef } from "react";
import { t } from "@/i18n/messages";
import type { WorldFrame } from "@/data/types";

export const WORLD_SPEEDS = [0.5, 1, 2, 4] as const;
export type WorldSpeed = (typeof WORLD_SPEEDS)[number];

const BUTTON: React.CSSProperties = {
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-secondary)",
  font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
  padding: "3px 10px",
  cursor: "pointer",
  letterSpacing: "var(--tracking-wide)",
};

export function WorldTimeline({
  frames,
  index,
  playing,
  speed,
  onSeek,
  onPlaying,
  onSpeed,
}: {
  frames: WorldFrame[];
  index: number;
  playing: boolean;
  speed: WorldSpeed;
  onSeek: (index: number) => void;
  onPlaying: (playing: boolean) => void;
  onSpeed: (speed: WorldSpeed) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const last = Math.max(0, frames.length - 1);
  const frame = frames[index];

  const seekToClientX = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar || frames.length === 0) return;
      const rect = bar.getBoundingClientRect();
      const fraction = (clientX - rect.left) / Math.max(1, rect.width);
      onSeek(Math.round(Math.min(1, Math.max(0, fraction)) * last));
    },
    [frames.length, last, onSeek],
  );

  // Dragging is tracked on the window: a pointer that leaves the bar mid-scrub should keep
  // scrubbing, which is what every video scrubber does and what a hand on a trackpad expects.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (draggingRef.current) seekToClientX(e.clientX);
    };
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [seekToClientX]);

  // Arrow keys step, space plays, Home/End jump. Skipped while the viewer is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      if (e.key === "ArrowLeft") {
        onPlaying(false);
        onSeek(Math.max(0, index - (e.shiftKey ? 10 : 1)));
      } else if (e.key === "ArrowRight") {
        onPlaying(false);
        onSeek(Math.min(last, index + (e.shiftKey ? 10 : 1)));
      } else if (e.key === " ") {
        e.preventDefault();
        onPlaying(!playing);
      } else if (e.key === "Home") {
        onSeek(0);
      } else if (e.key === "End") {
        onSeek(last);
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, last, playing, onSeek, onPlaying]);

  const progress = last === 0 ? 0 : (index / last) * 100;
  // One tick per round boundary: the block axis is long, and a round is the unit everything else on
  // the dashboard is measured in.
  const ticks: number[] = [];
  for (let i = 1; i < frames.length; i++)
    if (frames[i].round !== frames[i - 1].round)
      ticks.push((i / Math.max(1, last)) * 100);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-sunken)",
        position: "sticky",
        top: 0,
        zIndex: 5,
      }}
    >
      <div
        ref={barRef}
        role="slider"
        aria-label={t("world.timeline")}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index}
        tabIndex={0}
        onPointerDown={(e) => {
          draggingRef.current = true;
          onPlaying(false);
          seekToClientX(e.clientX);
        }}
        style={{
          position: "relative",
          height: "22px",
          background: "var(--bg-surface-raised)",
          cursor: "pointer",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${progress}%`,
            background:
              "color-mix(in oklch, var(--pink-500), transparent 62%)",
          }}
        />
        {ticks.map((left, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${left}%`,
              width: "1px",
              background: "var(--bg-canvas)",
            }}
          />
        ))}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${progress}%`,
            width: "2px",
            marginLeft: "-1px",
            background: "var(--pink-500)",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "14px",
          padding: "9px 16px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
            color: "var(--text-primary)",
            minWidth: "190px",
          }}
        >
          {frame
            ? frame.fromBlock === frame.block
              ? t("world.at", {
                  block: frame.block.toLocaleString("en-US"),
                  i: index + 1,
                  n: frames.length,
                })
              : t("world.atRange", {
                  from: frame.fromBlock.toLocaleString("en-US"),
                  to: frame.block.toLocaleString("en-US"),
                  i: index + 1,
                  n: frames.length,
                })
            : t("world.noFrames")}
        </span>

        <div style={{ display: "flex", gap: "4px" }}>
          <button
            type="button"
            style={BUTTON}
            title={t("world.toStart")}
            onClick={() => {
              onPlaying(false);
              onSeek(0);
            }}
          >
            |◀
          </button>
          <button
            type="button"
            style={BUTTON}
            title={t("world.stepBack")}
            onClick={() => {
              onPlaying(false);
              onSeek(Math.max(0, index - 1));
            }}
          >
            ◀
          </button>
          <button
            type="button"
            onClick={() => onPlaying(!playing)}
            style={{
              ...BUTTON,
              background: playing ? "var(--pink-500)" : "transparent",
              color: playing ? "var(--gray-950)" : "var(--text-secondary)",
              minWidth: "84px",
            }}
          >
            {playing ? t("cursor.pause") : t("cursor.play")}
          </button>
          <button
            type="button"
            style={BUTTON}
            title={t("world.stepForward")}
            onClick={() => {
              onPlaying(false);
              onSeek(Math.min(last, index + 1));
            }}
          >
            ▶
          </button>
          <button
            type="button"
            style={BUTTON}
            title={t("world.toEnd")}
            onClick={() => {
              onPlaying(false);
              onSeek(last);
            }}
          >
            ▶|
          </button>
        </div>

        <div style={{ display: "flex", gap: "4px" }}>
          {WORLD_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSpeed(s)}
              style={{
                ...BUTTON,
                border: "1px solid var(--border-subtle)",
                background:
                  s === speed ? "var(--bg-surface-raised)" : "transparent",
                color:
                  s === speed ? "var(--text-primary)" : "var(--text-tertiary)",
                font: "var(--text-xs) var(--font-mono)",
                padding: "3px 8px",
              }}
            >
              {s}x
            </button>
          ))}
        </div>

        <span
          style={{
            marginLeft: "auto",
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-tertiary)",
            textAlign: "right",
          }}
        >
          {frame && frame.round > 0
            ? t("world.inRound", { n: frame.round })
            : ""}
          {frame ? ` · ${frame.clock}` : ""}
          {" · "}
          {t("world.keys")}
        </span>
      </div>
    </div>
  );
}
