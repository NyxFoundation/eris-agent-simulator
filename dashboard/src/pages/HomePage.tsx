// The home: the whole competition at a glance.
//
// Three questions, in the order they get asked. Who is winning (standings), where they won it
// (regimes), and whether the win is spread or concentrated (scenarios). Each card is the top of a
// table that lives in full on /standings — the home states the headline under the default ranking
// rule, and /standings is where the rule itself is interrogated.
//
// Everything obeys the round cursor, so scrubbing the bar replays the competition from the home.

import { RoundCursorBar } from "@/components/RoundCursorBar";
import { Sidebar } from "@/components/Sidebar";
import {
  formatMetric,
  formatTotal,
  MoveCell,
  Panel,
  plural,
  Stat,
  toneColor,
} from "@/components/matrixUi";
import { useMemo } from "react";
import { scenarioRunId } from "@/data/matrixArtifacts";
import { windowsAtRound } from "@/data/matrixSchedule";
import {
  buildStandings,
  DEFAULT_AGGREGATOR,
  DEFAULT_LAMBDA,
  DEFAULT_METRIC,
  DEFAULT_RHO,
  METRICS,
  rankMoves,
} from "@/data/matrixScoring";
import { setCursorRange, useCursor } from "@/data/roundCursor";
import { setSelectedRunId } from "@/data/runSelection";
import { useMatrixSnapshot } from "@/data/useMatrixSnapshot";
import { navigate } from "@/navigation";
import { ScenarioPage } from "./ScenarioPage";

const PAGE_MAX_WIDTH = "1320px";
const TOP_N = 6;

export function HomePage() {
  const { data, loading, error } = useMatrixSnapshot();
  const cursor = useCursor();

  const maxRound = useMemo(() => {
    if (!data) return 0;
    let max = 0;
    for (const series of data.rounds.values())
      for (const returns of Object.values(series.byAgent))
        max = Math.max(max, returns.length);
    return max;
  }, [data]);

  useMemo(() => setCursorRange(maxRound), [maxRound]);

  // The home reports the default ranking rule and says so. Changing it is what /standings is for:
  // a headline that quietly depends on a choice the reader cannot see is the thing this whole page
  // set exists to avoid.
  const standings = useMemo(() => {
    if (!data) return null;
    return buildStandings(
      data.matrix,
      data.rounds,
      DEFAULT_METRIC,
      DEFAULT_AGGREGATOR,
      { lambda: DEFAULT_LAMBDA, rho: DEFAULT_RHO },
      cursor.round,
    );
  }, [data, cursor.round]);

  const moves = useMemo(() => {
    if (!data || !standings) return new Map<string, number | null>();
    return rankMoves(data.matrix, data.rounds, standings);
  }, [data, standings]);

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

  const file = data.matrix.file;
  const leader = standings.rows[0];
  const metricLabel =
    METRICS.find((m) => m.key === standings.metric)?.label ?? standings.metric;

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
              {file.scenarioSet ?? data.matrix.id}
            </h1>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                gap: "14px",
              }}
            >
              <Stat label="scenarios" value={String(file.scenarios.length)} />
              <Stat label="regimes" value={String(standings.regimes.length)} />
              <Stat label="agents" value={String(standings.agentIds.length)} />
              <Stat
                label="rounds"
                value={
                  cursor.round === null
                    ? `${maxRound} · final`
                    : `${cursor.round} of ${maxRound}`
                }
              />
              <Stat label="ranked by" value={metricLabel} />
            </div>
          </header>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
              gap: "18px",
              alignItems: "start",
            }}
          >
            <StandingsCard standings={standings} moves={moves} />
            <RegimesCard standings={standings} />
            <ConsistencyCard standings={standings} leaderId={leader.id} />
          </div>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StandingsCard({
  standings,
  moves,
}: {
  standings: ReturnType<typeof buildStandings>;
  moves: Map<string, number | null>;
}) {
  return (
    <Panel
      title={
        standings.throughRound === null
          ? "Standings"
          : `Standings · through round ${standings.throughRound}`
      }
      subtitle="M9 × z-score, the default rule. Open the full table to change it."
      action={{ label: "see all →", onClick: () => navigate("/standings") }}
    >
      <div style={{ padding: "4px 0" }}>
        {standings.rows.slice(0, TOP_N).map((row, i) => (
          <div
            key={row.id}
            onClick={() => navigate(`/agent/${encodeURIComponent(row.id)}`)}
            style={{
              display: "grid",
              gridTemplateColumns: "28px 40px 1fr 84px",
              alignItems: "center",
              padding: "9px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              font: "var(--text-sm) var(--font-mono)",
              cursor: "pointer",
            }}
          >
            <span style={{ color: "var(--text-tertiary)" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <MoveCell move={moves.get(row.id) ?? null} />
            <span
              style={{
                color: "var(--text-link)",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {row.id}
            </span>
            <span style={{ textAlign: "right", color: toneColor(row.total) }}>
              {formatTotal(row.total, standings.aggregator, standings.metric)}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RegimesCard({
  standings,
}: {
  standings: ReturnType<typeof buildStandings>;
}) {
  // Who leads each regime. A strategy that wins the total by winning one regime and losing six is a
  // different result from one that is never worst anywhere, and the total alone cannot tell them apart.
  const rows = standings.regimes.map((regime) => {
    let best: { id: string; value: number } | null = null;
    for (const row of standings.rows) {
      const v = row.byRegime[regime];
      if (v === undefined) continue;
      if (!best || v > best.value) best = { id: row.id, value: v };
    }
    return { regime, best };
  });

  return (
    <Panel
      title="Who leads each regime"
      subtitle="Regimes are weighted equally in the total, whatever their seed count (ADR 0017 §3)."
      action={{ label: "see all →", onClick: () => navigate("/standings") }}
    >
      <div style={{ padding: "4px 0" }}>
        {rows.map(({ regime, best }) => (
          <div
            key={regime}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 76px",
              gap: "8px",
              alignItems: "center",
              padding: "9px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              font: "var(--text-xs) var(--font-mono)",
            }}
          >
            <span style={{ color: "var(--text-secondary)" }}>
              {regime.replace(/^full-/, "")}
            </span>
            <span
              style={{
                color: "var(--text-link)",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={best?.id}
            >
              {best?.id ?? "—"}
            </span>
            <span
              style={{
                textAlign: "right",
                color: best ? toneColor(best.value) : "var(--text-disabled)",
              }}
            >
              {best
                ? formatTotal(
                    best.value,
                    standings.aggregator,
                    standings.metric,
                  )
                : "—"}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ConsistencyCard({
  standings,
  leaderId,
}: {
  standings: ReturnType<typeof buildStandings>;
  leaderId: string;
}) {
  // One cell per scenario, coloured by how the leader did in it. This is the question a single total
  // cannot answer: a standing built on 35 ordinary results and one built on two blowouts read the
  // same at the top and mean different things.
  const byRegime = new Map<string, typeof standings.cells>();
  for (const cell of standings.cells) {
    const list = byRegime.get(cell.regime) ?? [];
    list.push(cell);
    byRegime.set(cell.regime, list);
  }

  const zOf = (cell: (typeof standings.cells)[number]): number | null => {
    const values = Object.values(cell.byAgent);
    const own = cell.byAgent[leaderId];
    if (typeof own !== "number" || values.length < 2) return null;
    const mu = values.reduce((a, b) => a + b, 0) / values.length;
    const sd =
      Math.sqrt(
        values.reduce((s, v) => s + (v - mu) ** 2, 0) / values.length,
      ) || 1;
    return (own - mu) / sd;
  };

  return (
    <Panel
      title={`Where ${leaderId} won it`}
      subtitle="One cell per scenario, shaded by the leader's standing within that scenario's field."
      action={{ label: "see all →", onClick: () => navigate("/standings") }}
    >
      <div
        style={{
          padding: "12px 16px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "5px",
        }}
      >
        {[...byRegime.entries()].map(([regime, cells]) => (
          <div
            key={regime}
            style={{
              display: "grid",
              gridTemplateColumns: "108px 1fr",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <span
              style={{
                font: "var(--text-xs) var(--font-mono)",
                color: "var(--text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {regime.replace(/^full-/, "")}
            </span>
            <div style={{ display: "flex", gap: "3px" }}>
              {cells.map((cell) => {
                const z = zOf(cell);
                const strength =
                  z === null ? 0 : Math.min(1, Math.abs(z) / 2.5);
                const hue =
                  z === null
                    ? "var(--bg-sunken)"
                    : z >= 0
                      ? "var(--green-500)"
                      : "var(--red-500)";
                return (
                  <button
                    key={cell.seed}
                    type="button"
                    title={
                      z === null
                        ? `${cell.regime}#${cell.seed} · no value`
                        : `${cell.regime}#${cell.seed}\n${leaderId}: ${formatMetric(cell.byAgent[leaderId], standings.metric)} (z ${z.toFixed(2)})\nclick to open this scenario`
                    }
                    onClick={() => {
                      setSelectedRunId(cell.runId);
                      navigate("/scenario");
                    }}
                    style={{
                      flex: 1,
                      height: "17px",
                      border: "none",
                      borderRadius: "2px",
                      cursor: "pointer",
                      background:
                        z === null
                          ? "var(--bg-sunken)"
                          : `color-mix(in oklch, ${hue}, transparent ${Math.round(100 - strength * 88)}%)`,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Kept so the scenario-run mapping stays in one place if the home ever links deeper. */
export { scenarioRunId };
