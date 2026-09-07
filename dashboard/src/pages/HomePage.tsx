// The home: the competition standings, as a leaderboard people come back to.
//
// One table, under the one rule the competition is scored by (rules §4.4): per epoch a deviation
// score T over the field, across epochs a weighted average of T. Around it, the things a returning
// reader needs before the numbers: how far the competition has got and when it moves next (§4.7.1),
// the shape of the race so far (score by epoch), and the change since the last epoch beside each
// rank. The explanation of the units and the environment is one click away rather than in the
// scroll path -- a first-time reader opens it, a daily reader never sees it.
//
// Everything obeys the round cursor: scrubbing the bar replays the competition round by round, and
// the Δ column switches from "since the previous epoch" to "since the previous round" while it does.

import { useEffect, useMemo, useState } from "react";
import { InfoTabs } from "@/components/InfoTabs";
import { FindAgent } from "@/components/FindAgent";
import { RoundCursorBar } from "@/components/RoundCursorBar";
import { ScoreRaceChart } from "@/components/ScoreRaceChart";
import { Sidebar } from "@/components/Sidebar";
import { MoveCell, Panel, Stat, toneColor } from "@/components/competitionUi";
import {
  competitionName,
  isHiddenScenario,
  scenarioRunId,
} from "@/data/competition";
import { windowsAtRound } from "@/data/schedule";
import { buildScenarioList, type ScenarioListRow } from "@/data/scenarioList";
import {
  buildStandings,
  completedOrdinals,
  epochRankMoves,
  participantStandings,
  rankMoves,
  scoreRace,
} from "@/data/standings";
import { useMode } from "@/data/mode";
import { setPinnedAgent, usePinnedAgent } from "@/data/pinnedAgent";
import { setCursorRange, useCursor } from "@/data/roundCursor";
import { setSelectedRound } from "@/data/roundSelection";
import { getSelectedRunId, setSelectedRunId } from "@/data/runSelection";
import { useCompetitionSnapshot } from "@/data/useCompetitionSnapshot";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { formatPnlUsdc, formatScore } from "@/lib/format";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { navigate } from "@/navigation";
import { ScenarioPage } from "./ScenarioPage";

const PAGE_MAX_WIDTH = "1180px";

/**
 * "full-calm" reads as noise once every column is a regime; the shared prefix goes.
 *
 * The regimes were renamed (the five-venue set was retired and full-* took the plain names), so a
 * matrix run since then has nothing to strip. Matrices recorded before it do, and they are the
 * reason this stays: a stored run is read long after the file that named it changed.
 */
const shortRegime = (r: string) => r.replace(/^full-/, "");

const SCENARIO_GRID = "minmax(120px, 1.1fr) 92px minmax(120px, 1.2fr) 2fr";

// A first page of the standings. The live week's field is hundreds of agents; the top of the table
// is what a reader came for, and the rest is one click away rather than a scroll past.
const PAGE_SIZE = 50;
const PARTICIPANT_GRID =
  "30px minmax(140px, 1fr) minmax(140px, 1fr) 96px minmax(200px, 2fr)";

const TABLE_HEAD: React.CSSProperties = {
  display: "grid",
  columnGap: "8px",
  padding: "9px 16px",
  borderBottom: "1px solid var(--border-subtle)",
  font: "var(--text-xs) var(--font-mono)",
  color: "var(--text-tertiary)",
  letterSpacing: "var(--tracking-wide)",
  textTransform: "uppercase",
};
const TABLE_ROW: React.CSSProperties = {
  display: "grid",
  columnGap: "8px",
  padding: "10px 16px",
  borderBottom: "1px solid var(--border-subtle)",
  font: "var(--text-sm) var(--font-mono)",
  alignItems: "center",
};
const VIEW_BUTTON: React.CSSProperties = {
  font: "var(--text-xs) var(--font-mono)",
  padding: "5px 10px",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
};
const VIEW_BUTTON_ACTIVE: React.CSSProperties = {
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  borderColor: "var(--text-tertiary)",
};
const SHOW_MORE_BUTTON: React.CSSProperties = {
  ...VIEW_BUTTON,
  margin: "10px 16px",
};
const BADGE: React.CSSProperties = {
  font: "var(--weight-medium) 10px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "3px 7px",
};

/**
 * How the units nest, stated once.
 *
 * "Round" carries three meanings across the material a participant reads: the rules draft used it
 * for a block, this dashboard uses it for the scoring window, and a run is a scenario. A reader who
 * has not been told which is which cannot interpret "rank moved at round 14".
 */
function UnitLadder() {
  const rungs = [
    { label: t("units.competition"), body: t("units.competitionBody") },
    { label: t("units.scenario"), body: t("units.scenarioBody") },
    { label: t("units.round"), body: t("units.roundBody") },
    { label: t("units.block"), body: t("units.blockBody") },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
        gap: "1px",
        background: "var(--border-subtle)",
      }}
    >
      {rungs.map((rung, i) => (
        <div
          key={rung.label}
          style={{
            background: "var(--bg-surface)",
            padding: "11px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            minWidth: 0,
          }}
        >
          <span
            style={{
              font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
              letterSpacing: "var(--tracking-wide)",
              textTransform: "uppercase",
              color: "var(--text-primary)",
            }}
          >
            {/* The chevron is the containment: each rung sits inside the one before it. */}
            {i > 0 && (
              <span style={{ color: "var(--text-disabled)" }}>{"› "}</span>
            )}
            {rung.label}
          </span>
          <span
            style={{
              font: "var(--text-xs) var(--font-sans)",
              color: "var(--text-tertiary)",
              lineHeight: 1.55,
            }}
          >
            {rung.body}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * T per epoch as a 64px line, oldest to newest, with 50 as the dotted reference. The sports
 * "form" column: the score says where an agent is, this says whether it got there by being
 * steadily above the field or by one big epoch.
 */
function FormCell({ epochs }: { epochs: { s: number; t: number }[] }) {
  const sorted = [...epochs].sort((a, b) => a.s - b.s);
  if (sorted.length === 0)
    return <span style={{ color: "var(--text-disabled)" }}>—</span>;
  const w = 64;
  const h = 18;
  const ts = sorted.map((e) => e.t);
  const lo = Math.min(50, ...ts);
  const hi = Math.max(50, ...ts);
  const span = Math.max(hi - lo, 4);
  const y = (v: number) => h - 2 - ((v - lo) / span) * (h - 4);
  const x = (i: number) =>
    sorted.length === 1 ? w / 2 : (i / (sorted.length - 1)) * (w - 4) + 2;
  const d = ts
    .map(
      (v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`,
    )
    .join(" ");
  const latest = ts[ts.length - 1];
  return (
    <span
      title={t("home.formTitle", {
        n: sorted.length,
        latest: formatScore(latest),
      })}
      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <line
          x1={0}
          x2={w}
          y1={y(50)}
          y2={y(50)}
          stroke="var(--border-subtle)"
          strokeDasharray="2 3"
        />
        <path
          d={d}
          fill="none"
          stroke="var(--text-secondary)"
          strokeWidth={1.3}
          strokeLinejoin="round"
        />
        <circle
          cx={x(sorted.length - 1)}
          cy={y(latest)}
          r={2.2}
          fill={toneColor(latest - 50)}
        />
      </svg>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
        }}
      >
        {sorted.length}
      </span>
    </span>
  );
}

function ScenarioRow({
  row,
  scrubbing,
  hideLeader,
}: {
  row: ScenarioListRow;
  scrubbing: boolean;
  /** Rules §4.7: the trial environment posts no standings, and a leader per world is one. */
  hideLeader?: boolean;
}) {
  // An epoch the runner never ran has no world to open: the row states why instead of pretending
  // to be a link (issue #84 L).
  const open =
    row.runId === null
      ? undefined
      : () => {
          // A round index belongs to one run; carrying it into another scopes the next explorer
          // view to a block window that means nothing there.
          setSelectedRound(null);
          setSelectedRunId(row.runId as string);
          navigate("/scenario");
        };
  return (
    <div
      className={open ? "row-link" : undefined}
      onClick={open}
      style={{
        display: "grid",
        gridTemplateColumns: SCENARIO_GRID,
        columnGap: "8px",
        alignItems: "baseline",
        padding: "9px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
      }}
    >
      <span
        style={{
          color: open ? "var(--text-link)" : "var(--text-disabled)",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={row.runId ?? undefined}
      >
        {row.label}
      </span>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color:
            row.ended || row.runId === null
              ? "var(--text-disabled)"
              : "var(--text-secondary)",
        }}
        title={
          row.runId === null
            ? t("home.scenarios.failedTitle")
            : row.ended
              ? t("home.scenarios.endedTitle")
              : undefined
        }
      >
        {row.runId === null
          ? "—"
          : scrubbing
            ? t("home.scenarios.roundsAt", {
                at: row.roundsSoFar,
                n: row.rounds,
              })
            : String(row.rounds)}
        {row.ended && row.runId !== null && ` · ${t("home.scenarios.ended")}`}
      </span>
      {hideLeader ? (
        <span style={{ color: "var(--text-disabled)" }}>—</span>
      ) : row.leader ? (
        <span
          title={t("home.scenarios.leaderTitle")}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.leader.id}
          <span
            style={{
              marginLeft: "6px",
              font: "var(--text-xs) var(--font-mono)",
              color: toneColor(row.leader.pnlUsdc),
            }}
          >
            {formatPnlUsdc(row.leader.pnlUsdc)}
          </span>
        </span>
      ) : (
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-disabled)",
          }}
        >
          {/* An epoch that never ran has no leader for a reason the next column already gives;
              blaming collection for it would name the wrong cause. */}
          {row.runId === null
            ? "—"
            : row.missing
              ? t("home.scenarios.missing")
              : t("home.scenarios.noLeader")}
        </span>
      )}
      <span
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "5px",
          font: "var(--text-xs) var(--font-mono)",
        }}
      >
        {row.runId === null ? (
          <span
            style={{ color: "var(--text-disabled)" }}
            title={t("home.scenarios.failedTitle")}
          >
            {t("home.scenarios.failed", {
              reason: row.error ?? t("home.scenarios.noLeader"),
            })}
          </span>
        ) : isHiddenScenario(row) ? (
          // The kind of an episode ("crash", "whale") names the regime, which is what the public
          // view of a scenario matrix withholds (rules §3.3) — so this is "withheld", not "none".
          <span style={{ color: "var(--text-disabled)" }}>
            {t("home.scenarios.eventsWithheld")}
          </span>
        ) : row.events.length === 0 ? (
          <span style={{ color: "var(--text-disabled)" }}>
            {t("home.scenarios.noEvents")}
          </span>
        ) : (
          row.events.map((type) => (
            <span
              key={type}
              style={{
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                padding: "1px 6px",
                color: "var(--text-secondary)",
              }}
            >
              {type}
            </span>
          ))
        )}
      </span>
    </div>
  );
}

/**
 * A wall-clock time with its zone. The zone is not decoration: the audience of a hosted dashboard
 * is in several of them, and "updated 06:01 PM" told a reader in another one nothing they could
 * act on (issue #84 N). The date is added whenever it is not today's.
 */
function clock(ms: number, locale: string): string {
  const tag = locale === "ja" ? "ja-JP" : "en-US";
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(tag, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return sameDay
    ? time
    : `${d.toLocaleDateString(tag, { month: "numeric", day: "numeric" })} ${time}`;
}

/** "mm:ss" from now until `ms`, for the countdown to the next round boundary. */
function countdown(ms: number, nowMs: number): string {
  const total = Math.max(0, Math.round((ms - nowMs) / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * The one number on this page that moves between snapshots, in a component of its own so that it
 * is the only thing re-rendering every second — the standings table below it is hundreds of rows.
 */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{t("home.status.liveRoundIn", { t: countdown(at, now) })}</>;
}

export function HomePage() {
  const { data, loading, error } = useCompetitionSnapshot();
  const cursor = useCursor();
  const locale = useLocale();
  const mode = useMode();
  const pinned = usePinnedAgent();
  const narrow = useMediaQuery("(max-width: 720px)");
  // A field of hundreds (the live week) is not a table to scroll blind: a filter, a first page, the
  // participant-unit fold of rules §2.2, and the activity columns behind a switch.
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<"agents" | "participants">("agents");
  const [details, setDetails] = useState(false);

  // The cursor's range is the longest scenario in the competition. Shorter scenarios end early
  // rather than being excluded — see buildStandings.
  const maxRound = useMemo(() => {
    if (!data) return 0;
    let max = 0;
    for (const series of data.rounds.values())
      for (const values of Object.values(series.valuesByAgent))
        max = Math.max(max, values.length - 1);
    return max;
  }, [data]);

  useEffect(() => {
    setCursorRange(maxRound);
  }, [maxRound]);

  const standings = useMemo(() => {
    if (!data) return null;
    return buildStandings(data.competition, data.rounds, cursor.round);
  }, [data, cursor.round]);

  // Δ: since the previous round while the cursor scrubs; since the previous completed epoch
  // otherwise (rules §4.7.1 — the live week moves one epoch at a time).
  const moves = useMemo(() => {
    if (!data || !standings) return new Map<string, number | null>();
    return cursor.round === null
      ? epochRankMoves(data.competition, data.rounds, standings)
      : rankMoves(data.competition, data.rounds, standings);
  }, [data, standings, cursor.round]);

  const race = useMemo(() => {
    if (!data || !standings || data.competition.fromSingleRun) return null;
    return scoreRace(data.competition, data.rounds, standings);
  }, [data, standings]);

  const scenarioRows = useMemo(() => {
    if (!data) return [];
    return buildScenarioList(
      data.competition,
      data.rounds,
      data.schedules,
      cursor.round,
    );
  }, [data, cursor.round]);

  // One line of context for the selected round: which environment windows open here, who moved.
  const note = useMemo(() => {
    if (!data || !standings || cursor.round === null) return undefined;
    const open = windowsAtRound(data.schedules, cursor.round);
    const opening = open.filter((w) => w.opening);
    const moved = [...moves.values()].filter((m) => (m ?? 0) !== 0).length;
    const parts: string[] = [];
    if (opening.length > 0) {
      const types = [...new Set(opening.map((w) => w.window.type))].join(", ");
      parts.push(
        opening.length === 1
          ? t("home.noteOpensOne", { types })
          : t("home.noteOpens", { types, n: opening.length }),
      );
    } else if (open.length > 0) {
      parts.push(
        open.length === 1
          ? t("home.noteOpenOne")
          : t("home.noteOpen", { n: open.length }),
      );
    }
    parts.push(
      moved === 0
        ? t("home.noteNoMove")
        : moved === 1
          ? t("home.noteMovedOne")
          : t("home.noteMoved", { n: moved }),
    );
    return parts.join(" · ");
  }, [data, standings, cursor.round, moves]);

  // Keep the scenario selection inside the competition on screen, so drilling into Markets or
  // Explorer never lands on a world belonging to a different competition.
  useEffect(() => {
    if (!data) return;
    const ids = data.competition.file.scenarios.flatMap((s) =>
      typeof s.runDir === "string"
        ? [scenarioRunId(data.competition.id, s.runDir)]
        : [],
    );
    const current = getSelectedRunId();
    if (current && ids.includes(current)) return;
    if (ids[0]) setSelectedRunId(ids[0]);
  }, [data]);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-canvas)",
          font: "var(--text-sm) var(--font-mono)",
          color: "var(--text-tertiary)",
        }}
      >
        {t("common.loading")}
      </div>
    );
  }

  // Nothing to be the top page of: seed-provider mode, or an empty runs/. A competition that
  // exists but has scored nothing yet keeps its landing — the rules, the scenario list and the
  // participant lookup are what a reader needs most before the first result, and dropping the
  // whole page took them away exactly then (issue #84 T).
  if (error || !data || !standings) return <ScenarioPage />;

  const file = data.competition.file;
  const at = standings.throughRound;
  // ADR 0021 §1: a continuous competition is not the official scoring. ADR 0020 §2 puts the official
  // competition in `scenario` mode, so a continuous one -- the practice devnet, or a local
  // sim:realtime -- is by construction something else, and says so on the standings rather than only
  // in the manifest a participant may never open.
  //
  // On the positive assertion, not on "not scenario": a matrix.json written before ADR 0020 added
  // the field carries no resetUnit at all, and those were scenario matrices — the official shape.
  // Labelling them practice would be the same kind of error in the opposite direction.
  const practice = data.competition.file.resetUnit === "continuous";
  // A single run has one scenario labelled "run": its regime column would repeat the total.
  const regimes =
    narrow || standings.regimes.length <= 1 ? [] : standings.regimes;
  const scrubbing = at !== null;
  const recordedAt =
    file.createdAt && !Number.isNaN(new Date(file.createdAt).getTime())
      ? new Date(file.createdAt).toLocaleDateString(
          locale === "ja" ? "ja-JP" : "en-US",
          { year: "numeric", month: "short", day: "numeric" },
        )
      : null;
  // Facts recorded beside an agent's numbers (rules §4.4.2) get a column only when there are any;
  // the participant fold (rules §2.2) a toggle only when the roster names participants.
  const hasFlags = Object.keys(standings.flagsByAgent).length > 0;
  const hasParticipants = Object.keys(standings.participantOf).length > 0;
  const hasActivity = Object.keys(standings.txCountByAgent).length > 0;
  const q = query.trim().toLowerCase();
  const matches = (id: string) =>
    !q ||
    id.toLowerCase().includes(q) ||
    (standings.participantOf[id] ?? "").toLowerCase().includes(q);
  const filteredRows = standings.rows.filter((r) => matches(r.id));
  const participantRows = hasParticipants
    ? participantStandings(standings).filter(
        (p) =>
          p.participant.toLowerCase().includes(q) ||
          p.agents.some((a) => matches(a.id)),
      )
    : [];
  const showingParticipants = view === "participants" && hasParticipants;
  const filteredCount = showingParticipants
    ? participantRows.length
    : filteredRows.length;
  const visibleRows = showAll ? filteredRows : filteredRows.slice(0, PAGE_SIZE);
  const visibleParticipants = showAll
    ? participantRows
    : participantRows.slice(0, PAGE_SIZE);
  const visibleCount = showingParticipants
    ? visibleParticipants.length
    : visibleRows.length;

  // The status line (rules §4.7.1): how many epochs are scored, when the table last changed, and
  // when it changes next. One sentence, because it is read every time and the numbers are what
  // matters.
  const done = completedOrdinals(data.competition, data.rounds);
  const planned = data.scenariosPlanned;
  const nextStart = (() => {
    const scored = new Set(done);
    const upcoming = (file.schedule ?? [])
      .filter((e) => !scored.has(e.s) && typeof e.startsAt === "string")
      .map((e) => Date.parse(e.startsAt as string))
      .filter((ms) => Number.isFinite(ms))
      .sort((a, b) => a - b);
    return upcoming[0] ?? null;
  })();
  const statusParts: string[] = [];
  if (!data.competition.fromSingleRun) {
    statusParts.push(
      planned !== null && done.length < planned
        ? t("home.status.epochs", { done: done.length, planned })
        : done.length === 1
          ? t("home.status.epochsAllOne")
          : t("home.status.epochsAll", { n: done.length }),
    );
    if (data.updatedAtMs !== null)
      statusParts.push(
        t("home.status.updated", { time: clock(data.updatedAtMs, locale) }),
      );
    // What is running *in this competition*, and where it is. The old line said only that some run
    // somewhere was live, and only while the plan had epochs left — so a practice period, whose
    // plan grows a segment at a time, never said anything at all (issue #84 C).
    if (data.live) {
      statusParts.push(
        data.live.round !== null && data.live.rounds !== null
          ? t("home.status.liveRound", {
              label: data.live.label,
              round: data.live.round,
              rounds: data.live.rounds,
            })
          : t("home.status.live"),
      );
      if (data.live.blockNumber !== null)
        statusParts.push(
          t("home.status.liveBlock", {
            n: data.live.blockNumber.toLocaleString("en-US"),
          }),
        );
    }
    if (nextStart !== null && (planned === null || done.length < planned))
      statusParts.push(
        t("home.status.next", { time: clock(nextStart, locale) }),
      );
  }
  // More results are coming. Not "the plan has epochs left" alone: a practice period has no plan
  // beyond the segments it has written, and it is the case where "Final" was most wrong.
  const inProgress = data.inProgress;

  const togglePin = (id: string) => setPinnedAgent(pinned === id ? null : id);

  // Built without repeat(): `repeat(0, ...)` is invalid CSS and would break the whole grid for a
  // single-run competition, which has no regime columns.
  const columns = [
    "30px",
    "44px",
    "minmax(140px, 1fr)",
    "96px",
    ...(narrow ? [] : ["92px"]),
    ...regimes.map(() => "minmax(66px, 92px)"),
    ...(hasFlags ? ["56px"] : []),
    ...(details && hasActivity ? ["64px", "64px"] : []),
    ...(narrow ? [] : ["104px"]),
    "34px",
  ].join(" ");
  const tableMinWidth = narrow
    ? 0
    : 480 + regimes.length * 74 + (hasFlags ? 60 : 0) + (details ? 136 : 0);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: "var(--bg-canvas)",
      }}
    >
      <Sidebar activePage="home" />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <RoundCursorBar
          cursor={cursor}
          scenarioCount={file.scenarios.length}
          endedScenarios={standings.endedScenarios}
          inProgress={inProgress}
          note={note}
        />
        <main
          style={{
            maxWidth: PAGE_MAX_WIDTH,
            width: "100%",
            minWidth: 0,
            margin: "0 auto",
            padding: narrow ? "20px 14px 48px" : "32px 32px 64px",
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            boxSizing: "border-box",
          }}
        >
          <header
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <h1
                title={data.competition.id}
                style={{
                  margin: 0,
                  font: "var(--weight-bold) 21px var(--font-sans)",
                  letterSpacing: "var(--tracking-tight)",
                }}
              >
                {competitionName(data.competition)}
              </h1>
              {practice && (
                <span title={t("home.practiceNote")} style={BADGE}>
                  {t("home.practiceBadge")}
                </span>
              )}
              {/* The label only: the paragraph below this header is where the public view is
                  explained, and saying it in three places at once said it in none (issue #84 M). */}
              {mode.audience && <span style={BADGE}>{t("mode.audienceBadge")}</span>}
            </div>
            {statusParts.length > 0 && (
              <p
                style={{
                  margin: 0,
                  font: "var(--text-sm) var(--font-mono)",
                  color: inProgress
                    ? "var(--warning-text)"
                    : "var(--text-secondary)",
                }}
              >
                {statusParts.join(" · ")}
                {data.live?.roundEndsAtMs != null && (
                  <>
                    {" · "}
                    <Countdown at={data.live.roundEndsAtMs} />
                  </>
                )}
              </p>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 160px))",
                gap: "14px",
              }}
            >
              <Stat
                label={t("home.stat.scenarios")}
                value={String(file.scenarios.length)}
              />
              {standings.regimes.length > 1 && (
                <Stat
                  label={t("home.stat.regimes")}
                  value={String(standings.regimes.length)}
                />
              )}
              <Stat
                label={t("home.stat.agents")}
                value={String(standings.agentIds.length)}
              />
              <Stat
                label={t("home.stat.rounds")}
                value={
                  at !== null
                    ? t("home.roundsAt", { at, n: maxRound })
                    : inProgress
                      ? t("home.roundsSoFar", { n: maxRound })
                      : t("home.roundsFinal", { n: maxRound })
                }
              />
              {recordedAt && (
                <Stat label={t("home.stat.recorded")} value={recordedAt} />
              )}
            </div>
            {mode.audience && (
              <span
                style={{
                  font: "var(--text-xs) var(--font-sans)",
                  color: "var(--text-tertiary)",
                }}
              >
                {t("mode.audienceNote")}
              </span>
            )}
            {data.missingRounds > 0 && (
              <span
                style={{
                  font: "var(--text-xs) var(--font-sans)",
                  color: "var(--warning-text)",
                }}
              >
                {t("home.missingRounds", {
                  missing: data.missingRounds,
                  total: file.scenarios.length,
                })}
              </span>
            )}
          </header>

          {!mode.standings ? (
            // Neither final nor provisional: there is no standing here to be either (issue #84 C).
            <Panel title={t("home.standingsTitle")}>
              <p
                style={{
                  margin: 0,
                  padding: "16px",
                  font: "var(--text-sm) var(--font-sans)",
                  lineHeight: 1.6,
                  color: "var(--text-secondary)",
                }}
              >
                {t("home.standingsOff")}
              </p>
            </Panel>
          ) : standings.rows.length === 0 ? (
            // A competition with nothing scored yet, or one every epoch of which failed. Which of
            // the two it is decides what to say (issue #84 L); either way the page stays.
            <Panel title={t("home.noStandings.title")}>
              <p
                style={{
                  margin: 0,
                  padding: "16px",
                  font: "var(--text-sm) var(--font-sans)",
                  lineHeight: 1.6,
                  color: "var(--text-secondary)",
                }}
              >
                {(() => {
                  const failures = file.scenarios.filter(
                    (sc) => typeof sc.error === "string",
                  );
                  return failures.length > 0 &&
                    failures.length === file.scenarios.length
                    ? t("home.noStandings.failed", {
                        detail: failures[0].error as string,
                      })
                    : t("home.noStandings.pending");
                })()}
              </p>
            </Panel>
          ) : (
            <>
              {race && (
                <Panel
                  title={t("home.chart.title")}
                  subtitle={t("home.chart.subtitle", {
                    n: Math.min(10, race.order.length),
                  })}
                >
                  <div style={{ padding: "12px 12px 0" }}>
                    <ScoreRaceChart
                      race={race}
                      pinned={pinned}
                      onPick={togglePin}
                    />
                  </div>
                </Panel>
              )}

              <Panel
                title={
                  at !== null
                    ? t("home.standingsThrough", { at })
                    : inProgress
                      ? t("home.standingsSoFar")
                      : t("home.standingsFinal")
                }
                subtitle={
                  practice
                    ? `${t("home.practiceNote")} ${t("home.subtitle")}`
                    : t("home.subtitle")
                }
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setShowAll(false);
                    }}
                    placeholder={t("home.search")}
                    aria-label={t("home.search")}
                    style={{
                      flex: "1 1 220px",
                      minWidth: 0,
                      padding: "6px 10px",
                      font: "var(--text-sm) var(--font-mono)",
                      color: "var(--text-primary)",
                      background: "var(--bg-surface)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  />
                  {hasParticipants && (
                    <div style={{ display: "flex", gap: "4px" }}>
                      {(["agents", "participants"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setView(v)}
                          style={{
                            ...VIEW_BUTTON,
                            ...(view === v ? VIEW_BUTTON_ACTIVE : {}),
                          }}
                        >
                          {v === "agents"
                            ? t("home.view.agents")
                            : t("home.view.participants")}
                        </button>
                      ))}
                    </div>
                  )}
                  {hasActivity && !showingParticipants && (
                    <button
                      type="button"
                      onClick={() => setDetails((v) => !v)}
                      title={t("home.txsTitle")}
                      style={{
                        ...VIEW_BUTTON,
                        ...(details ? VIEW_BUTTON_ACTIVE : {}),
                      }}
                    >
                      {t("home.details")}
                    </button>
                  )}
                  {pinned && (
                    <button
                      type="button"
                      onClick={() => setPinnedAgent(null)}
                      title={t("home.unpin")}
                      style={{
                        ...VIEW_BUTTON,
                        color: "var(--pink-500)",
                        borderColor: "var(--pink-500)",
                      }}
                    >
                      {`${t("home.pinned")} ${pinned}`}
                    </button>
                  )}
                  <span
                    style={{
                      marginLeft: "auto",
                      font: "var(--text-xs) var(--font-mono)",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {`${visibleCount} / ${filteredCount}`}
                  </span>
                </div>
                {showingParticipants && (
                  <p
                    style={{
                      margin: 0,
                      padding: "8px 16px 0",
                      font: "var(--text-xs) var(--font-sans)",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {t("home.participantsNote")}
                  </p>
                )}
                <div
                  style={{
                    overflowX: "auto",
                    maxHeight: showAll ? "72vh" : undefined,
                    overflowY: showAll ? "auto" : undefined,
                  }}
                >
                  {showingParticipants ? (
                    <div style={{ minWidth: narrow ? 0 : "640px" }}>
                      <div
                        style={{
                          ...TABLE_HEAD,
                          gridTemplateColumns: PARTICIPANT_GRID,
                          position: "sticky",
                          top: 0,
                          background: "var(--bg-surface-raised)",
                          zIndex: 1,
                        }}
                      >
                        <span>#</span>
                        <span>{t("home.col.participant")}</span>
                        <span>{t("home.col.countedAgent")}</span>
                        <span style={{ textAlign: "right" }}>
                          {t("home.col.score")}
                        </span>
                        <span>{t("home.col.agents")}</span>
                      </div>
                      {visibleParticipants.map((row) => (
                        <div
                          key={row.participant}
                          style={{
                            ...TABLE_ROW,
                            gridTemplateColumns: PARTICIPANT_GRID,
                          }}
                        >
                          <span style={{ color: "var(--text-tertiary)" }}>
                            {row.rank}
                          </span>
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={row.participant}
                          >
                            {row.participant}
                          </span>
                          <span
                            className="row-link"
                            onClick={() =>
                              navigate(
                                `/agent/${encodeURIComponent(row.counted.id)}`,
                              )
                            }
                            style={{
                              color: "var(--text-link)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              cursor: "pointer",
                            }}
                            title={row.counted.id}
                          >
                            {row.counted.id}
                          </span>
                          <span
                            style={{
                              textAlign: "right",
                              color: toneColor((row.counted.score ?? 50) - 50),
                              fontWeight: "var(--weight-semibold)" as never,
                            }}
                          >
                            {formatScore(row.counted.score)}
                          </span>
                          <span
                            style={{
                              font: "var(--text-xs) var(--font-mono)",
                              color: "var(--text-secondary)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {row.agents
                              .map((a) => `${a.id} ${formatScore(a.score)}`)
                              .join(" · ")}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div
                      style={{
                        minWidth: tableMinWidth ? `${tableMinWidth}px` : 0,
                      }}
                    >
                      <div
                        style={{
                          ...TABLE_HEAD,
                          gridTemplateColumns: columns,
                          position: "sticky",
                          top: 0,
                          background: "var(--bg-surface-raised)",
                          zIndex: 1,
                        }}
                      >
                        <span>#</span>
                        <span
                          style={{ textAlign: "center" }}
                          title={scrubbing ? undefined : t("home.deltaTitle")}
                        >
                          {scrubbing ? t("home.col.move") : t("home.col.delta")}
                        </span>
                        <span>{t("home.col.agent")}</span>
                        <span style={{ textAlign: "right" }}>
                          {t("home.col.score")}
                        </span>
                        {!narrow && <span>{t("home.col.form")}</span>}
                        {regimes.map((r) => (
                          <span
                            key={r}
                            style={{
                              textAlign: "right",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={r}
                          >
                            {shortRegime(r)}
                          </span>
                        ))}
                        {hasFlags && (
                          <span style={{ textAlign: "center" }}>
                            {t("home.col.flags")}
                          </span>
                        )}
                        {details && hasActivity && (
                          <>
                            <span
                              style={{ textAlign: "right" }}
                              title={t("home.txsTitle")}
                            >
                              {t("home.col.txs")}
                            </span>
                            <span
                              style={{ textAlign: "right" }}
                              title={t("home.txsTitle")}
                            >
                              {t("home.col.reverts")}
                            </span>
                          </>
                        )}
                        {!narrow && (
                          <span
                            style={{ textAlign: "right" }}
                            title={t("home.netPnlTitle")}
                          >
                            {t("home.col.netPnl")}
                          </span>
                        )}
                        <span />
                      </div>

                      {visibleRows.map((row) => {
                        const byRegime = standings.tByRegime[row.id] ?? {};
                        const flags = standings.flagsByAgent[row.id] ?? [];
                        const isPinned = row.id === pinned;
                        return (
                          <div
                            key={row.id}
                            className="row-link"
                            onClick={() =>
                              navigate(`/agent/${encodeURIComponent(row.id)}`)
                            }
                            style={{
                              ...TABLE_ROW,
                              gridTemplateColumns: columns,
                              ...(isPinned
                                ? {
                                    background:
                                      "color-mix(in oklch, var(--pink-500) 12%, transparent)",
                                    boxShadow: "inset 3px 0 0 var(--pink-500)",
                                  }
                                : {}),
                            }}
                          >
                            <span style={{ color: "var(--text-tertiary)" }}>
                              {row.rank}
                              {row.tied ? "=" : ""}
                            </span>
                            <MoveCell move={moves.get(row.id) ?? null} />
                            <span
                              style={{
                                color: "var(--text-link)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={
                                standings.participantOf[row.id]
                                  ? `${row.id} · ${standings.participantOf[row.id]}`
                                  : row.id
                              }
                            >
                              {row.id}
                            </span>
                            <span
                              title={t("home.scoreTitle", {
                                n: row.epochs.length,
                                std:
                                  row.tStd === null ? "—" : row.tStd.toFixed(2),
                                worst: formatScore(row.worstT),
                              })}
                              style={{
                                textAlign: "right",
                                color: toneColor((row.score ?? 50) - 50),
                                fontWeight: "var(--weight-semibold)" as never,
                              }}
                            >
                              {formatScore(row.score)}
                            </span>
                            {!narrow && <FormCell epochs={row.epochs} />}
                            {regimes.map((r) => {
                              const v = byRegime[r];
                              return (
                                <span
                                  key={r}
                                  style={{
                                    textAlign: "right",
                                    font: "var(--text-xs) var(--font-mono)",
                                    color:
                                      v === undefined
                                        ? "var(--text-disabled)"
                                        : toneColor(v - 50),
                                  }}
                                >
                                  {formatScore(v)}
                                </span>
                              );
                            })}
                            {hasFlags && (
                              <span style={{ textAlign: "center" }}>
                                {flags.length > 0 && (
                                  <span
                                    title={t("home.flagsTitle", {
                                      flags: flags.join("; "),
                                    })}
                                    style={{
                                      display: "inline-block",
                                      minWidth: "18px",
                                      padding: "0 5px",
                                      borderRadius: "var(--radius-sm)",
                                      border: "1px solid var(--warning-text)",
                                      color: "var(--warning-text)",
                                      font: "var(--text-xs) var(--font-mono)",
                                    }}
                                  >
                                    !{flags.length}
                                  </span>
                                )}
                              </span>
                            )}
                            {details && hasActivity && (
                              <>
                                <span
                                  style={{
                                    textAlign: "right",
                                    font: "var(--text-xs) var(--font-mono)",
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  {(
                                    standings.txCountByAgent[row.id] ?? 0
                                  ).toLocaleString("en-US")}
                                </span>
                                <span
                                  style={{
                                    textAlign: "right",
                                    font: "var(--text-xs) var(--font-mono)",
                                    color:
                                      (standings.revertCountByAgent[row.id] ??
                                        0) > 0
                                        ? "var(--danger)"
                                        : "var(--text-disabled)",
                                  }}
                                >
                                  {(
                                    standings.revertCountByAgent[row.id] ?? 0
                                  ).toLocaleString("en-US")}
                                </span>
                              </>
                            )}
                            {/* Net PnL prices both ends at the run's final marks, so it has no value
                                "at round k" — while the cursor is mid-competition the finished number
                                is shown dimmed rather than under a round label. */}
                            {!narrow && (
                              <span
                                title={
                                  scrubbing ? t("home.netPnlScrub") : undefined
                                }
                                style={{
                                  textAlign: "right",
                                  font: "var(--text-xs) var(--font-mono)",
                                  color: scrubbing
                                    ? "var(--text-disabled)"
                                    : toneColor(
                                        standings.netPnlByAgent[row.id] ?? 0,
                                      ),
                                }}
                              >
                                {formatPnlUsdc(
                                  standings.netPnlByAgent[row.id] ?? 0,
                                )}
                              </span>
                            )}
                            <button
                              type="button"
                              aria-pressed={isPinned}
                              title={
                                isPinned ? t("home.unpin") : t("home.pinTitle")
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePin(row.id);
                              }}
                              style={{
                                border: "none",
                                background: "transparent",
                                cursor: "pointer",
                                padding: "2px 4px",
                                font: "14px var(--font-sans)",
                                lineHeight: 1,
                                color: isPinned
                                  ? "var(--pink-500)"
                                  : "var(--text-disabled)",
                              }}
                            >
                              {isPinned ? "★" : "☆"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {filteredCount > PAGE_SIZE && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    style={SHOW_MORE_BUTTON}
                  >
                    {showAll
                      ? t("home.showLess", { n: PAGE_SIZE })
                      : t("home.showMore", { n: filteredCount })}
                  </button>
                )}
              </Panel>
            </>
          )}

          {/* The one thing a participant needs that no ranking provides: their own agent. With
              standings not posted there is no row to click, and the only routes to an agent page
              were a wallet on the board or a typed URL (issue #84 G). */}
          <FindAgent addressByAgent={standings.addressByAgent} />

          {/* Choosing a world to look at, from the list rather than from a dropdown of names. */}
          <Panel
            title={t("home.scenarios.title")}
            subtitle={
              mode.audience
                ? `${t("home.scenarios.subtitle")} ${t("home.scenarios.audienceEvents")}`
                : t("home.scenarios.subtitle")
            }
          >
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: narrow ? 0 : "560px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: SCENARIO_GRID,
                    columnGap: "8px",
                    padding: "9px 16px",
                    borderBottom: "1px solid var(--border-subtle)",
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    letterSpacing: "var(--tracking-wide)",
                    textTransform: "uppercase",
                  }}
                >
                  <span>{t("home.scenarios.col.scenario")}</span>
                  <span>{t("home.scenarios.col.rounds")}</span>
                  <span>
                    {mode.standings ? t("home.scenarios.col.leader") : ""}
                  </span>
                  <span title={t("home.scenarios.eventsTitle")}>
                    {t("home.scenarios.col.events")}
                  </span>
                </div>
                {scenarioRows.map((row) => (
                  <ScenarioRow
                    key={row.key}
                    row={row}
                    scrubbing={scrubbing}
                    hideLeader={!mode.standings}
                  />
                ))}
              </div>
            </div>
          </Panel>

          {/* The explanation of what a competition is — the units, the environment, the scoring,
              the data. Folded, because a reader who comes back every epoch has read it, and a
              first-time reader is told exactly where it is. */}
          <details
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-surface)",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                padding: "13px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "3px",
                listStyle: "none",
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
                {t("home.about")}
              </span>
              <span
                style={{
                  font: "var(--text-xs) var(--font-sans)",
                  color: "var(--text-tertiary)",
                  lineHeight: 1.5,
                }}
              >
                {t("home.aboutHint")}
              </span>
            </summary>
            <div
              style={{
                borderTop: "1px solid var(--border-subtle)",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "18px",
              }}
            >
              <Panel title={t("units.title")}>
                <UnitLadder />
              </Panel>
              <InfoTabs />
            </div>
          </details>
        </main>
      </div>
    </div>
  );
}
