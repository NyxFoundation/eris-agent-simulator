// Which competition is in view, as a select beside the competition's name on the overview and the
// standings page. It used to be the top of a sidebar on every page (issue #183).
//
// Shown only where there is something to choose. The public view never shows it: the server decides
// what is published (ERIS_DASHBOARD_COMPETITIONS), and the newest competition it serves is the one
// in view (competitionSelection.ts ignores a stored choice there). Locally it appears when there are
// two or more competitions, or one competition and runs outside it -- a participant switching
// between their own backtests and a `sim:realtime` run.
//
// "— single run —" is not a second mode. It makes the selected run the outer unit, which the pages
// read as a competition of one scenario; the run itself is then chosen in the second select here,
// or with the world switcher on the scenario-level pages.

import { useEffect, useMemo, useState } from "react";
import {
  competitionLabel,
  loadCompetition,
  runDisplayName,
  scenarioRunId,
  type Competition,
} from "@/data/competition";
import {
  resolveCompetitionId,
  setSelectedCompetitionId,
  SINGLE_RUNS,
  useSelectedCompetitionId,
} from "@/data/competitionSelection";
import { useMode } from "@/data/mode";
import { isSeedProvider } from "@/data/provider";
import { setSelectedRound } from "@/data/roundSelection";
import { competitionEntries, runEntries } from "@/data/runArtifacts";
import { setSelectedRunId, useSelectedRunId } from "@/data/runSelection";
import { useRunIndex } from "@/data/useRunIndex";
import { Select } from "@/design-system/Select";
import { useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";

const SINGLE_RUNS_OPTION = " single";

/** A run collected from a remote box has a nested id (`<collection>/runs/<id>`); show the run's own
 * name with where it came from, rather than the raw path. */
export function runLabel(id: string): string {
  const parts = id.split("/");
  if (parts.length === 1) return runDisplayName(id);
  return `${runDisplayName(id)}  ← ${parts[0]}`;
}

export function CompetitionPicker({
  row = false,
}: {
  /** Render as its own right-aligned row (where there is no heading to sit beside). */
  row?: boolean;
} = {}) {
  const entries = useRunIndex();
  const mode = useMode();
  const locale = useLocale();
  const stored = useSelectedCompetitionId();
  const selectedRun = useSelectedRunId();
  // competition id -> the loaded competition (null when it could not be read).
  const [loaded, setLoaded] = useState<Map<string, Competition | null>>(
    new Map(),
  );

  const competitions = useMemo(
    () => (entries ? competitionEntries(entries) : []),
    [entries],
  );
  const runs = useMemo(() => (entries ? runEntries(entries) : []), [entries]);
  // Ids and modification times: a competition that is still growing (a practice period gains a day,
  // a live week an epoch) has to be read again, or its newest runs look like runs outside it.
  const competitionKey = competitions
    .map((c) => `${c.id}@${c.mtimeMs ?? ""}`)
    .join("\n");

  // Every listed competition, for its display name and for which runs belong to it (cached loads).
  useEffect(() => {
    if (mode.audience || isSeedProvider) return;
    let cancelled = false;
    Promise.all(
      competitions.map(async (entry) => {
        try {
          return [
            entry.id,
            await loadCompetition(entry.id, { mtimeMs: entry.mtimeMs ?? null }),
          ] as const;
        } catch {
          return [entry.id, null] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setLoaded(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
    // competitionKey stands for the list: the array itself is new on every poll.
  }, [competitionKey, mode.audience]);

  if (mode.audience || isSeedProvider || !entries) return null;

  // Two competitions that come out with the same label (a practice period restarted the same day)
  // get the clock appended, so the select never shows two identical rows.
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const entry of competitions) {
    const c = loaded.get(entry.id);
    const label = c ? competitionLabel(c, locale) : entry.id;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    labels.set(entry.id, label);
  }
  for (const entry of competitions) {
    const c = loaded.get(entry.id);
    if (c && (counts.get(labels.get(entry.id) as string) ?? 0) > 1)
      labels.set(entry.id, competitionLabel(c, locale, { withTime: true }));
  }

  const inCompetitions = new Set<string>();
  for (const c of loaded.values()) {
    if (!c) continue;
    for (const s of c.file.scenarios)
      if (typeof s.runDir === "string")
        inCompetitions.add(scenarioRunId(c.id, s.runDir));
  }
  const allLoaded = competitions.every((c) => loaded.has(c.id));
  const looseRuns = allLoaded
    ? runs.filter((r) => !inCompetitions.has(r.id))
    : [];

  const competitionValue = resolveCompetitionId(entries);
  const showCompetitions =
    competitions.length > 0 &&
    (competitions.length >= 2 ||
      looseRuns.length > 0 ||
      stored === SINGLE_RUNS);
  // Outside a competition the outer unit is one run, and choosing it is this select's job too.
  const showRuns = competitionValue === null && runs.length >= 2;
  if (!showCompetitions && !showRuns) return null;

  const runValue =
    selectedRun && runs.some((r) => r.id === selectedRun)
      ? selectedRun
      : (runs[0]?.id ?? "");

  const picker = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "6px",
        font: "var(--text-xs) var(--font-mono)",
        color: "var(--text-tertiary)",
        textTransform: "none",
        letterSpacing: "normal",
      }}
    >
      {showCompetitions && (
        <Select
          ariaLabel={t("picker.competition")}
          compact
          value={competitionValue ?? SINGLE_RUNS_OPTION}
          options={[
            ...competitions.map((m) => ({
              label: labels.get(m.id) ?? m.id,
              value: m.id,
              title: m.id,
            })),
            { label: t("picker.singleRun"), value: SINGLE_RUNS_OPTION },
          ]}
          onChange={(e) => {
            const picked = e.target.value;
            setSelectedRound(null);
            setSelectedCompetitionId(
              picked === SINGLE_RUNS_OPTION ? SINGLE_RUNS : picked,
            );
            // Point the scenario selection inside the new competition, so the run-level pages
            // are not left showing a world that belongs to a different competition.
            if (picked !== SINGLE_RUNS_OPTION) {
              const c = loaded.get(picked);
              const first = c?.file.scenarios.find(
                (s) => typeof s.runDir === "string",
              );
              setSelectedRunId(
                c && first?.runDir ? scenarioRunId(c.id, first.runDir) : null,
              );
            }
          }}
          style={{ maxWidth: "240px" }}
        />
      )}
      {showRuns && (
        <Select
          ariaLabel={t("picker.scenario")}
          compact
          value={runValue}
          options={runs.map((r) => ({
            label: `${r.live ? "● " : ""}${runLabel(r.id)}${r.live ? ` (${t("common.live")})` : ""}`,
            value: r.id,
            title: r.id,
          }))}
          onChange={(e) => {
            // A round index only means something inside one run.
            setSelectedRound(null);
            setSelectedRunId(e.target.value);
          }}
          style={{ maxWidth: "240px" }}
        />
      )}
    </span>
  );
  return row ? (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>{picker}</div>
  ) : (
    picker
  );
}
