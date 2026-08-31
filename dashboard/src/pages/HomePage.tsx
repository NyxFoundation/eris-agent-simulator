// The home: the competition standings.
//
// One table, under the one rule the competition is scored by. The score column shows the score in
// its own units (bps per round); the rank order comes from the official aggregation, whose value
// sits in the score cell's tooltip. A row opens the agent's page, where the round-level
// distribution behind its place lives. Everything obeys the round cursor, so scrubbing the bar
// replays the competition from here.

import { useEffect, useMemo } from "react";
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
import { buildStandings, rankMoves } from "@/data/standings";
import { setCursorRange, useCursor } from "@/data/roundCursor";
import { getSelectedRunId, setSelectedRunId } from "@/data/runSelection";
import { useCompetitionSnapshot } from "@/data/useCompetitionSnapshot";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { formatBps, formatPnlUsdc } from "@/lib/format";
import { navigate } from "@/navigation";
import { ScenarioPage } from "./ScenarioPage";

const PAGE_MAX_WIDTH = "1180px";

/** "full-calm" reads as noise once every column is a regime; the shared prefix goes. */
const shortRegime = (r: string) => r.replace(/^full-/, "");

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
            <div
              style={{ display: "flex", alignItems: "center", gap: "10px" }}
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
        </main>
      </div>
    </div>
  );
}
