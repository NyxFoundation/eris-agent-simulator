// The competition: the outer unit everything on the dashboard belongs to.
//
//   competition ⊃ scenario (one run, "regime#seed") ⊃ round (one scoring epoch)
//
// A competition is normally a scenario matrix written by `npm run backtest -- --scenarios ...`
// (runs/<id>/matrix.json), whose scenarios are sibling run dirs. A standalone `sim:realtime` run is
// the same thing with one scenario in it — `competitionFromRun` wraps it into the identical shape,
// so every page downstream of this file processes exactly one kind of object.

import { t } from "@/i18n/messages";

/**
 * The regime name the server substitutes while a competition is in progress and being shown to the
 * public (server/runsApi.ts audience mode): rules §3.3 does not announce an epoch's scenario, and
 * with equal regime counts the ones already run would give away the ones left. Such a scenario is
 * named by its ordinal instead.
 */
export const HIDDEN_REGIME = "hidden";

export function isHiddenScenario(s: { regime: string }): boolean {
  return s.regime === HIDDEN_REGIME;
}

export interface ScenarioAgentResult {
  id: string;
  netPnlUsdc: number;
  alphaUsdc: number;
  /** Rules §2.2: the participant unit this agent is one submission of. Absent on older matrices. */
  participant?: string;
  /**
   * Facts recorded beside the number by the backtest runner (core/src/cli/backtest.ts): a fee-cap
   * violation, a process that exited early, transactions the runtime never logged. None of them
   * changes P (rules §4.4.2); §8 matters are the operator's to judge.
   */
  flags?: string[];
  /** P(a, s) of rules §4.4.1: V_K − V_0, each end at its own marks. Absent on a matrix recorded
   * before it existed, where netPnlUsdc (both ends at the final marks) stands in. */
  pnlUsdc?: number;
  /** The benchmark (§4.3): valued and shown, never in the population. */
  baseline?: boolean;
  initialValueUsdc: number;
  finalValueUsdc: number;
}

export interface CompetitionScenario {
  /** Scheduled ordinal (rules §4.4.1); the epoch's weight is a function of it. Position + 1 when absent. */
  s?: number;
  regime: string;
  seed: number;
  agents: ScenarioAgentResult[];
  /** Path to that scenario's run dir, relative to the poc root that produced it. */
  runDir: string;
  /** The plan's intended start for this epoch (ISO 8601), when the plan had a timetable. */
  startsAt?: string;
  /**
   * What to call this instead of "regime#seed". A scenario matrix has no use for it — "crash#303"
   * already names a distribution and a draw. A practice period's segments do: they are cuts of one
   * continuous world (ADR 0021 §6), and "segment#3" names nothing a participant cares about, where
   * "2026-09-02" does.
   */
  label?: string;
}

/** Shape of matrix.json, written by core/src/cli/backtest.ts. Parsed defensively: schema 2 carries
 * `k` and per-agent P; a schema-1 file has neither and is scored on netPnlUsdc with k = its size. */
export interface CompetitionFile {
  schema?: number;
  createdAt?: string;
  sourceCommit?: string;
  scenarioSet?: string;
  resetUnit?: string;
  /** The schedule length the epoch weights are taken over (rules §4.4.1). */
  k?: number;
  repeat?: number;
  scenariosPlanned?: number;
  /**
   * The plan's timetable, when it had one: every planned ordinal with its intended start. Written
   * by the backtest runner for the epochs not run yet, so the standings can say when the next one
   * starts (rules §4.7.1). Ordinal and time only — no scenario.
   */
  schedule?: { s: number; startsAt?: string }[];
  scenarios: CompetitionScenario[];
}

export interface Competition {
  id: string;
  file: CompetitionFile;
  /** Built from one run rather than read from a matrix.json — see competitionFromRun. */
  fromSingleRun?: boolean;
}

/**
 * A scenario's `runDir` is relative to the root of whatever machine produced it ("runs/<id>"), so it
 * cannot be used as an id here: a competition collected from a remote box lives at
 * runs/<collection>/runs/matrix-<x>/, and the id has to be relative to *this* machine's runs/.
 *
 * Two layouts, because the two kinds of competition nest differently:
 *
 *   a scenario matrix writes its scenarios *beside* the index (runs/matrix-x/ + runs/<scenario>/)
 *   a practice period writes its segments *inside* it   (runs/<period>/ + runs/<period>/<day>/)
 *
 * Resolving both through the competition's own path covers each. Assuming the sibling layout for
 * everything left a segmented period fetching runs/<day>/summary.json — a 404 per segment, and a
 * standings page stuck on "Loading…".
 */
export function scenarioRunId(competitionId: string, runDir: string): string {
  const rel = runDir.replace(/^\.?\/?runs\//, "").replace(/^\/+/, "");
  const prefixCut = competitionId.lastIndexOf("/");
  const prefix = prefixCut === -1 ? "" : competitionId.slice(0, prefixCut + 1);
  const competitionName = competitionId.slice(prefixCut + 1);
  // Nested: the run dir names the competition it lives in.
  if (competitionName && rel.startsWith(`${competitionName}/`))
    return `${prefix}${rel}`;
  const name = rel.split("/").filter(Boolean).pop() ?? rel;
  return `${prefix}${name}`;
}

/**
 * A single run, as a competition of one scenario.
 *
 * Everything is read from the run's own summary.json, so this asserts nothing the run did not
 * record. A run still in progress has no summary.json and therefore no scenario — its results do
 * not exist yet, which is a fact about the run rather than a gap in this function.
 */
export function competitionFromRun(
  runId: string,
  summary: {
    resetUnit?: string;
    agents?: {
      id: string;
      initialValueUsdc: number;
      finalValueUsdc: number;
      netPnlUsdc: number;
      alphaUsdc?: number;
      pnlUsdc?: number;
      baseline?: boolean;
    }[];
  },
  seed: number,
): Competition {
  const agents: ScenarioAgentResult[] = (summary.agents ?? []).map((a) => ({
    id: a.id,
    netPnlUsdc: a.netPnlUsdc,
    alphaUsdc: a.alphaUsdc ?? 0,
    ...(a.pnlUsdc !== undefined ? { pnlUsdc: a.pnlUsdc } : {}),
    ...(a.baseline ? { baseline: true } : {}),
    initialValueUsdc: a.initialValueUsdc,
    finalValueUsdc: a.finalValueUsdc,
  }));
  return {
    id: runId,
    fromSingleRun: true,
    file: {
      schema: 2,
      scenarioSet: runId,
      resetUnit: summary.resetUnit ?? "continuous",
      k: 1,
      scenariosPlanned: 1,
      // The run carries no regime name — a regime is a config the backtest runner names, and a
      // standalone run was not launched through it. The seed is what the run does record.
      scenarios: [{ regime: "run", seed, agents, runDir: runId }],
    },
  };
}

// ---------------------------------------------------------------------------
// display names
//
// A competition's heading is a name, not a storage detail: the scenario set it ran ("full-8h"),
// never the yaml path that configured it or the timestamped directory it landed in. The raw id
// stays available as a tooltip for anyone who needs to find the files.

/** "config/scenarios/full-8h.yaml" -> "full-8h"; already-clean names pass through. */
function nameFromScenarioSet(set: string): string {
  const base = set.split("/").filter(Boolean).pop() ?? set;
  return base.replace(/\.ya?ml$/i, "");
}

/** "2026-08-29T16-03-52-390Z" (a run dir basename) -> "2026-08-29 16:03"; else the basename. */
export function runDisplayName(runId: string): string {
  const base = runId.split("/").filter(Boolean).pop() ?? runId;
  const m = base.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : base;
}

/**
 * What a scenario is called: its own label when it has one, otherwise the regime and seed it was
 * drawn from. One function, so every place that names a scenario names it the same way.
 */
export function scenarioLabel(s: {
  regime: string;
  seed: number;
  label?: string;
  s?: number;
}): string {
  if (s.label) return s.label;
  // The public view of a competition in progress: the epoch is named by its ordinal, because which
  // scenario it was is exactly what is not announced (rules §3.3).
  if (isHiddenScenario(s))
    return t("scenario.hidden", { s: String(s.s ?? "?") });
  return `${s.regime}#${s.seed}`;
}

/** The competition's human name. A single-run competition is named by its run's timestamp. */
export function competitionName(c: Competition): string {
  if (!c.fromSingleRun && c.file.scenarioSet)
    return nameFromScenarioSet(c.file.scenarioSet);
  if (c.fromSingleRun) return runDisplayName(c.id);
  return c.id.split("/").filter(Boolean).pop() ?? c.id;
}

/**
 * "full-8h · 8/29" — the picker label; the date separates re-runs of the same set. `withTime` adds
 * the clock ("practice · 9/25 14:02") for the case the date does not separate: a practice period
 * restarted the same day opens a new competition directory (ADR 0021 §6), and two entries called
 * "practice · 9/25" tell a reader nothing about which is which.
 */
export function competitionLabel(
  c: Competition,
  locale: string,
  options: { withTime?: boolean } = {},
): string {
  const name = competitionName(c);
  if (!c.file.createdAt) return name;
  const date = new Date(c.file.createdAt);
  if (Number.isNaN(date.getTime())) return name;
  const tag = locale === "ja" ? "ja-JP" : "en-US";
  const day = date.toLocaleDateString(tag, {
    month: "numeric",
    day: "numeric",
  });
  if (!options.withTime) return `${name} · ${day}`;
  const time = date.toLocaleTimeString(tag, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${name} · ${day} ${time}`;
}

const cache = new Map<string, Promise<Competition>>();

export function loadCompetition(id: string): Promise<Competition> {
  const cached = cache.get(id);
  if (cached) return cached;

  const loading = (async (): Promise<Competition> => {
    const res = await fetch(`/runs/${encodeURIComponent(id)}/matrix.json`);
    if (!res.ok) throw new Error(`matrix.json ${res.status} for ${id}`);
    const file = (await res.json()) as CompetitionFile;
    if (!Array.isArray(file.scenarios)) {
      throw new Error(`matrix.json has no scenarios: ${id}`);
    }
    return { id, file };
  })();

  loading.catch(() => cache.delete(id));
  cache.set(id, loading);
  return loading;
}
