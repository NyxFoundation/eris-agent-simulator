// The matrix's round cursor: the clock the whole competition is read against.
//
// One segment per round, spanning every scenario at once — at round k all 35 worlds are at their
// own round k, which is what makes independent scenarios watchable as a single competition. Playing
// advances the cursor; it is not a separate "replay" mode, because replay, round selection and a
// live head are the same act of putting a position on this axis.
//
// Scenarios are not all the same length (the depeg regime runs 9 rounds against everyone else's
// 29). Past a scenario's last round its world has ended and its result is final, so it stays in the
// standings — dropping it would move the field for a reason that is not a result — and the bar says
// how many are in that state instead of leaving the change unexplained.

import {
  CURSOR_SPEEDS,
  seekCursor,
  setCursorPlaying,
  setCursorSpeed,
  type CursorSpeed,
  type CursorState,
} from "@/data/roundCursor";

const LABEL = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

function Segment({
  index,
  state,
  onSelect,
}: {
  index: number;
  state: "past" | "current" | "future";
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={`round ${index}`}
      style={{
        flex: 1,
        minWidth: "6px",
        height: "22px",
        border: "none",
        padding: 0,
        cursor: "pointer",
        background:
          state === "current"
            ? "var(--pink-500)"
            : state === "past"
              ? "color-mix(in oklch, var(--pink-500), transparent 68%)"
              : "var(--bg-surface-raised)",
        borderRight: "1px solid var(--bg-canvas)",
      }}
    />
  );
}

export function RoundCursorBar({
  cursor,
  scenarioCount,
  endedScenarios,
  note,
}: {
  cursor: CursorState;
  scenarioCount: number;
  endedScenarios: number;
  /** Extra context for the current position, e.g. what landed in this round. */
  note?: string;
}) {
  const { round, maxRound, playing, speed } = cursor;
  if (maxRound <= 0) return null;
  const at = round ?? maxRound;
  const atEnd = round === null;

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
      <div style={{ display: "flex" }}>
        {Array.from({ length: maxRound }, (_, i) => i + 1).map((i) => (
          <Segment
            key={i}
            index={i}
            state={i === at ? "current" : i < at ? "past" : "future"}
            onSelect={() => seekCursor(i)}
          />
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          padding: "9px 16px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
            color: "var(--text-primary)",
            minWidth: "150px",
          }}
        >
          {atEnd
            ? `FINAL · ${maxRound} rounds`
            : `ROUND ${String(at).padStart(2, "0")} / ${maxRound}`}
        </span>

        <button
          type="button"
          onClick={() => setCursorPlaying(!playing)}
          style={{
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            background: playing ? "var(--pink-500)" : "transparent",
            color: playing ? "var(--gray-950)" : "var(--text-secondary)",
            font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
            padding: "3px 11px",
            cursor: "pointer",
            letterSpacing: "var(--tracking-wide)",
          }}
        >
          {playing ? "❚❚ pause" : "▶ play"}
        </button>

        <div style={{ display: "flex", gap: "4px" }}>
          {CURSOR_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setCursorSpeed(s as CursorSpeed)}
              style={{
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                background:
                  s === speed ? "var(--bg-surface-raised)" : "transparent",
                color:
                  s === speed ? "var(--text-primary)" : "var(--text-tertiary)",
                font: "var(--text-xs) var(--font-mono)",
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              {s}x
            </button>
          ))}
        </div>

        {!atEnd && (
          <button
            type="button"
            onClick={() => seekCursor(null)}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--text-link)",
              font: "var(--text-xs) var(--font-mono)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            jump to final →
          </button>
        )}

        <span style={{ ...LABEL, marginLeft: "auto", textAlign: "right" }}>
          {atEnd
            ? `${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"} · complete`
            : endedScenarios > 0
              ? `${scenarioCount - endedScenarios} of ${scenarioCount} still running · ${endedScenarios} ended earlier`
              : `${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"} @ round ${at}`}
        </span>
      </div>

      {note && (
        <div
          style={{
            padding: "0 16px 9px",
            font: "var(--text-xs) var(--font-sans)",
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
