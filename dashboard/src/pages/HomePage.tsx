// The home: the competition standings.
//
// One table, under the one rule the competition is scored by. A row opens the agent's page, where
// the round-level distribution behind its place lives. Everything obeys the round cursor, so
// scrubbing the bar replays the competition from here.

import { useEffect, useMemo } from "react";
import { RoundCursorBar } from "@/components/RoundCursorBar";
import { Sidebar } from "@/components/Sidebar";
import {
  formatStanding,
  MoveCell,
  Panel,
  plural,
  Stat,
  toneColor,
} from "@/components/competitionUi";
import { scenarioRunId } from "@/data/competition";
import { windowsAtRound } from "@/data/schedule";
import { buildStandings, rankMoves } from "@/data/standings";
import { setCursorRange, useCursor } from "@/data/roundCursor";
import { getSelectedRunId, setSelectedRunId } from "@/data/runSelection";
import { useCompetitionSnapshot } from "@/data/useCompetitionSnapshot";
import { formatPnlUsdc } from "@/lib/format";
import { navigate } from "@/navigation";
import { ScenarioPage } from "./ScenarioPage";

const PAGE_MAX_WIDTH = "1180px";

export function HomePage() {
  const { data, loading, error } = useCompetitionSnapshot();
  const cursor = useCursor();

  // The cursor's range is the longest scenario in the competition. Shorter scenarios end early
  // rather than being excluded — see buildStandings.
  const maxRound = useMemo(() => {
    if (!data) return 0;
    let max = 0;
    for (const series of data.rounds.values())
      for (const returns of Object.values(series.byAgent))
        max = Math.max(max, returns.length);
    return max;
  }, [data]);

  useEffect(() => {
    setCursorRange(maxRound);
  }, [maxRound]);

  const standings = useMemo(() => {
    if (!data) return null;
    return buildStandings(data.competition, data.rounds, cursor.round);
  }, [data, cursor.round]);

  const moves = useMemo(() => {
    if (!data || !standings) return new Map<string, number | null>();
    return rankMoves(data.competition, data.rounds, standings);
  }, [data, standings]);

  // One line of context for the selected round: which environment windows open here, who moved.
  const note = useMemo(() => {
    if (!data || !standings || cursor.round === null) return undefined;
    const open = windowsAtRound(data.schedules, cursor.round);
    const opening = open.filter((w) => w.opening);
    const moved = [...moves.values()].filter((m) => (m ?? 0) !== 0).length;
    const parts: string[] = [];
    if (opening.length > 0) {
      const names = [...new Set(opening.map((w) => w.window.type))].join(", ");
      parts.push(`${names} opens in ${plural(opening.length, "scenario")}`);
    } else if (open.length > 0) {
      parts.push(`${plural(open.length, "window")} still open`);
    }
    parts.push(
      moved === 0
        ? "nobody changed place"
        : `${plural(moved, "agent")} changed place`,
    );
    return parts.join(" · ");
  }, [data, standings, cursor.round, moves]);

  // Keep the scenario selection inside the competition on screen, so drilling into Markets or
  // Explorer never lands on a world belonging to a different competition.
  useEffect(() => {
    if (!data) return;
    const ids = data.competition.file.scenarios.map((s) =>
      scenarioRunId(data.competition.id, s.runDir),
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
        Loading…
      </div>
    );
  }

  // Nothing to rank: seed-provider mode, an empty runs/, or a run still in progress — a live run's
  // results are written when it finishes. The scenario view is the right home for all three.
  if (error || !data || !standings || standings.rows.length === 0)
    return <ScenarioPage />;

  const file = data.competition.file;
  const at = standings.throughRound;
  // A single run has one scenario labelled "run": its regime column would repeat the total.
  const regimes = standings.regimes.length > 1 ? standings.regimes : [];
  const scrubbing = at !== null;
  // Built without repeat(): `repeat(0, ...)` is invalid CSS and would break the whole grid for a
  // single-run competition, which has no regime columns.
  const columns = [
    "36px",
    "46px",
    "minmax(150px, 1fr)",
    "96px",
    ...regimes.map(() => "minmax(72px, 94px)"),
    "110px",
  ].join(" ");

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
          note={note}
        />
        <main
          style={{
            maxWidth: PAGE_MAX_WIDTH,
            width: "100%",
            minWidth: 0,
            margin: "0 auto",
            padding: "32px 32px 64px",
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            boxSizing: "border-box",
          }}
        >
          <header
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            <h1
              style={{
                margin: 0,
                font: "var(--weight-bold) 21px var(--font-sans)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {file.scenarioSet ?? data.competition.id}
            </h1>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 160px))",
                gap: "14px",
              }}
            >
              <Stat label="scenarios" value={String(file.scenarios.length)} />
              {regimes.length > 0 && (
                <Stat label="regimes" value={String(regimes.length)} />
              )}
              <Stat label="agents" value={String(standings.agentIds.length)} />
              <Stat
                label="rounds"
                value={
                  at === null ? `${maxRound} · final` : `${at} of ${maxRound}`
                }
              />
            </div>
            {data.missingRounds > 0 && (
              <span
                style={{
                  font: "var(--text-xs) var(--font-sans)",
                  color: "var(--warning-text)",
                }}
              >
                {data.missingRounds} of {file.scenarios.length} scenario runs
                were not collected — they still rank, but have no round detail.
              </span>
            )}
          </header>

          <Panel
            title={
              at === null
                ? "Standings · final"
                : `Standings · through round ${at}`
            }
            subtitle="Score: each scenario's mean − λ·std of per-round returns, ranked within its field and averaged with equal weight per regime. Open a row for why it sits where it does."
          >
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: `${420 + regimes.length * 78}px` }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    padding: "9px 16px",
                    borderBottom: "1px solid var(--border-subtle)",
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    letterSpacing: "var(--tracking-wide)",
                    textTransform: "uppercase",
                  }}
                >
                  <span>#</span>
                  <span style={{ textAlign: "center" }}>move</span>
                  <span>agent</span>
                  <span style={{ textAlign: "right" }}>score</span>
                  {regimes.map((r) => (
                    <span key={r} style={{ textAlign: "right" }} title={r}>
                      {r.replace(/^full-/, "")}
                    </span>
                  ))}
                  <span style={{ textAlign: "right" }}>net PnL</span>
                </div>

                {standings.rows.map((row, i) => (
                  <div
                    key={row.id}
                    onClick={() =>
                      navigate(`/agent/${encodeURIComponent(row.id)}`)
                    }
                    style={{
                      display: "grid",
                      gridTemplateColumns: columns,
                      padding: "10px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      font: "var(--text-sm) var(--font-mono)",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ color: "var(--text-tertiary)" }}>
                      {i + 1}
                    </span>
                    <MoveCell move={moves.get(row.id) ?? null} />
                    <span
                      style={{
                        color: "var(--text-link)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={row.id}
                    >
                      {row.id}
                    </span>
                    <span
                      style={{
                        textAlign: "right",
                        color: toneColor(row.total),
                        fontWeight: "var(--weight-semibold)" as never,
                      }}
                    >
                      {formatStanding(row.total)}
                    </span>
                    {regimes.map((r) => {
                      const v = row.byRegime[r];
                      return (
                        <span
                          key={r}
                          style={{
                            textAlign: "right",
                            font: "var(--text-xs) var(--font-mono)",
                            color:
                              v === undefined
                                ? "var(--text-disabled)"
                                : toneColor(v),
                          }}
                        >
                          {v === undefined ? "—" : formatStanding(v)}
                        </span>
                      );
                    })}
                    {/* Net PnL prices both ends at the run's final marks, so it has no value "at
                        round k" — while the cursor is mid-competition the finished number is shown
                        dimmed rather than under a round label. */}
                    <span
                      title={
                        scrubbing
                          ? "final value — net PnL is only defined at a run's end"
                          : undefined
                      }
                      style={{
                        textAlign: "right",
                        font: "var(--text-xs) var(--font-mono)",
                        color: scrubbing
                          ? "var(--text-disabled)"
                          : toneColor(standings.netPnlByAgent[row.id] ?? 0),
                      }}
                    >
                      {formatPnlUsdc(standings.netPnlByAgent[row.id] ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </main>
      </div>
    </div>
  );
}
