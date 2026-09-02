// The home: the competition standings.
//
// One table, under the one rule the competition is scored by. The score column shows the score in
// its own units (bps per round); the rank order comes from the official aggregation, whose value
// sits in the score cell's tooltip. A row opens the agent's page, where the round-level
// distribution behind its place lives. Everything obeys the round cursor, so scrubbing the bar
// replays the competition from here.

import { useEffect, useMemo } from "react";
import { InfoTabs } from "@/components/InfoTabs";
import { RoundCursorBar } from "@/components/RoundCursorBar";
import { Sidebar } from "@/components/Sidebar";
import {
  formatStanding,
  MoveCell,
  Panel,
  Stat,
  toneColor,
} from "@/components/competitionUi";
import { competitionName, scenarioRunId } from "@/data/competition";
import { windowsAtRound } from "@/data/schedule";
import { buildScenarioList, type ScenarioListRow } from "@/data/scenarioList";
import { buildStandings, rankMoves } from "@/data/standings";
import { setCursorRange, useCursor } from "@/data/roundCursor";
import { setSelectedRound } from "@/data/roundSelection";
import { getSelectedRunId, setSelectedRunId } from "@/data/runSelection";
import { useCompetitionSnapshot } from "@/data/useCompetitionSnapshot";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { formatBps, formatPnlUsdc } from "@/lib/format";
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

function ScenarioRow({
  row,
  scrubbing,
}: {
  row: ScenarioListRow;
  scrubbing: boolean;
}) {
  const open = () => {
    // A round index belongs to one run; carrying it into another scopes the next explorer view to a
    // block window that means nothing there.
    setSelectedRound(null);
    setSelectedRunId(row.runId);
    navigate("/scenario");
  };
  return (
    <div
      className="row-link"
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
          color: "var(--text-link)",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={row.runId}
      >
        {row.label}
      </span>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: row.ended ? "var(--text-disabled)" : "var(--text-secondary)",
        }}
        title={row.ended ? t("home.scenarios.endedTitle") : undefined}
      >
        {scrubbing
          ? t("home.scenarios.roundsAt", {
              at: row.roundsSoFar,
              n: row.rounds,
            })
          : String(row.rounds)}
        {row.ended && ` · ${t("home.scenarios.ended")}`}
      </span>
      {row.leader ? (
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
              color: toneColor(row.leader.score),
            }}
          >
            {formatBps(row.leader.score * 10_000)}
          </span>
        </span>
      ) : (
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-disabled)",
          }}
        >
          {row.missing
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
        {row.events.length === 0 ? (
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

export function HomePage() {
  const { data, loading, error } = useCompetitionSnapshot();
  const cursor = useCursor();
  const locale = useLocale();

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
        {t("common.loading")}
      </div>
    );
  }

  // Nothing to rank: seed-provider mode, an empty runs/, or a run still in progress — a live run's
  // results are written when it finishes. The scenario view is the right home for all three.
  if (error || !data || !standings || standings.rows.length === 0)
    return <ScenarioPage />;

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
  const regimes = standings.regimes.length > 1 ? standings.regimes : [];
  const scrubbing = at !== null;
  const recordedAt =
    file.createdAt && !Number.isNaN(new Date(file.createdAt).getTime())
      ? new Date(file.createdAt).toLocaleDateString(
          locale === "ja" ? "ja-JP" : "en-US",
          { year: "numeric", month: "short", day: "numeric" },
        )
      : null;
  // Built without repeat(): `repeat(0, ...)` is invalid CSS and would break the whole grid for a
  // single-run competition, which has no regime columns.
  const columns = [
    "30px",
    ...(scrubbing ? ["44px"] : []),
    "minmax(140px, 1fr)",
    "96px",
    ...regimes.map(() => "minmax(66px, 92px)"),
    "104px",
  ].join(" ");

  const scoreBps = (raw: number | undefined): string =>
    raw === undefined ? "—" : formatBps(raw * 10_000);

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
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
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
                <span
                  title={t("home.practiceNote")}
                  style={{
                    font: "var(--weight-medium) 10px var(--font-mono)",
                    letterSpacing: "var(--tracking-widest)",
                    textTransform: "uppercase",
                    color: "var(--text-tertiary)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    padding: "3px 7px",
                  }}
                >
                  {t("home.practiceBadge")}
                </span>
              )}
            </div>
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
              {regimes.length > 0 && (
                <Stat
                  label={t("home.stat.regimes")}
                  value={String(regimes.length)}
                />
              )}
              <Stat
                label={t("home.stat.agents")}
                value={String(standings.agentIds.length)}
              />
              <Stat
                label={t("home.stat.rounds")}
                value={
                  at === null
                    ? t("home.roundsFinal", { n: maxRound })
                    : t("home.roundsAt", { at, n: maxRound })
                }
              />
              {recordedAt && (
                <Stat label={t("home.stat.recorded")} value={recordedAt} />
              )}
            </div>
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

          <Panel
            title={
              at === null
                ? t("home.standingsFinal")
                : t("home.standingsThrough", { at })
            }
            subtitle={
              practice
                ? `${t("home.practiceNote")} ${t("home.subtitle")}`
                : t("home.subtitle")
            }
          >
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: `${380 + regimes.length * 74}px` }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    columnGap: "8px",
                    padding: "9px 16px",
                    borderBottom: "1px solid var(--border-subtle)",
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    letterSpacing: "var(--tracking-wide)",
                    textTransform: "uppercase",
                  }}
                >
                  <span>#</span>
                  {scrubbing && (
                    <span style={{ textAlign: "center" }}>
                      {t("home.col.move")}
                    </span>
                  )}
                  <span>{t("home.col.agent")}</span>
                  <span style={{ textAlign: "right" }}>
                    {t("home.col.score")}
                  </span>
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
                  <span
                    style={{ textAlign: "right" }}
                    title={t("home.netPnlTitle")}
                  >
                    {t("home.col.netPnl")}
                  </span>
                </div>

                {standings.rows.map((row, i) => {
                  const score = standings.scoreByAgent[row.id];
                  return (
                    <div
                      key={row.id}
                      className="row-link"
                      onClick={() =>
                        navigate(`/agent/${encodeURIComponent(row.id)}`)
                      }
                      style={{
                        display: "grid",
                        gridTemplateColumns: columns,
                        columnGap: "8px",
                        padding: "10px 16px",
                        borderBottom: "1px solid var(--border-subtle)",
                        font: "var(--text-sm) var(--font-mono)",
                      }}
                    >
                      <span style={{ color: "var(--text-tertiary)" }}>
                        {i + 1}
                      </span>
                      {scrubbing && (
                        <MoveCell move={moves.get(row.id) ?? null} />
                      )}
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
                        title={t("home.scoreTitle", {
                          z: formatStanding(row.total),
                        })}
                        style={{
                          textAlign: "right",
                          color: toneColor(score?.overall ?? 0),
                          fontWeight: "var(--weight-semibold)" as never,
                        }}
                      >
                        {scoreBps(score?.overall)}
                      </span>
                      {regimes.map((r) => {
                        const v = score?.byRegime[r];
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
                            {scoreBps(v)}
                          </span>
                        );
                      })}
                      {/* Net PnL prices both ends at the run's final marks, so it has no value "at
                          round k" — while the cursor is mid-competition the finished number is
                          shown dimmed rather than under a round label. */}
                      <span
                        title={scrubbing ? t("home.netPnlScrub") : undefined}
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
                  );
                })}
              </div>
            </div>
          </Panel>

          {/* Choosing a world to look at, from the list rather than from a dropdown of names. */}
          <Panel
            title={t("home.scenarios.title")}
            subtitle={t("home.scenarios.subtitle")}
          >
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: "560px" }}>
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
                  <span>{t("home.scenarios.col.leader")}</span>
                  <span title={t("home.scenarios.eventsTitle")}>
                    {t("home.scenarios.col.events")}
                  </span>
                </div>
                {scenarioRows.map((row) => (
                  <ScenarioRow key={row.key} row={row} scrubbing={scrubbing} />
                ))}
              </div>
            </div>
          </Panel>

          <Panel title={t("units.title")}>
            <UnitLadder />
          </Panel>

          {/* Overview / Environment / Scoring / Data. It lived at the bottom of a single scenario,
              where the explanation of what a scenario is could only be found by first picking one. */}
          <InfoTabs />
        </main>
      </div>
    </div>
  );
}
