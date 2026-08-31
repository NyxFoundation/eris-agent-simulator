// What the environment did, placed on the round axis.
//
// A round-by-round view of a competition is thin without this: the standings move at round 14 and
// the reason is that a crash window opened there. The schedule is drawn from the seed before the
// first block, so it is one line near the top of each scenario's events.jsonl — read as a 128KB head
// rather than as the whole 3MB file, which is what makes it affordable across 35 scenarios.
//
// Windows are converted from the run-relative blocks the schedule records into rounds, because the
// round is the axis everything else is on. Four event types are deliberately absent from the
// per-block record (crash / spike / cexDrift / flowTrend change the price walk itself rather than
// overlaying it), so this is the plan, and "planned" is what it says.

import { scenarioRunId, type Competition } from "./competition";

const HEAD_BYTES = 128 * 1024;

export interface ScheduledWindow {
  type: string;
  /** 1-based, inclusive. */
  fromRound: number;
  toRound: number;
  venue?: string;
  stable?: string;
}

export interface ScenarioSchedule {
  regime: string;
  seed: number;
  runId: string;
  epochBlocks: number;
  windows: ScheduledWindow[];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function loadHead(runId: string): Promise<string> {
  const res = await fetch(
    `/runs/${encodeURIComponent(runId)}/tail/events.jsonl?offset=0&limit=${HEAD_BYTES}`,
  );
  if (!res.ok) return "";
  const body = (await res.json()) as { text?: string };
  return body.text ?? "";
}

export async function loadSchedules(
  competition: Competition,
): Promise<Map<string, ScenarioSchedule>> {
  const entries = await Promise.all(
    competition.file.scenarios.map(async (s) => {
      const runId = scenarioRunId(competition.id, s.runDir);
      // Keyed by runDir, which is the only unique field: a matrix can repeat (regime, seed) under
      // --repeat, and a practice period's segments can share a display label (ADR 0021 §6).
      const key = s.runDir;
      try {
        const head = await loadHead(runId);
        let epochBlocks = 0;
        let windows: ScheduledWindow[] = [];
        for (const line of head.split("\n")) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // The last line of a capped read is usually torn. Nothing else to do with it.
            continue;
          }
          if (event.type === "run_started_realtime")
            epochBlocks = num(event.epochBlocks) ?? 0;
          if (event.type === "stress_schedule" && Array.isArray(event.events)) {
            windows = (event.events as Record<string, unknown>[]).flatMap(
              (w) => {
                const start = num(w.startBlock);
                const end = num(w.endBlock);
                if (start === null || end === null || epochBlocks <= 0)
                  return [];
                return [
                  {
                    type: String(w.type ?? "event"),
                    // The schedule's blocks are relative to the run's first block, so the round is a
                    // direct division rather than an offset from the first boundary.
                    fromRound: Math.max(1, Math.ceil(start / epochBlocks)),
                    toRound: Math.max(1, Math.ceil(end / epochBlocks)),
                    ...(typeof w.venue === "string" ? { venue: w.venue } : {}),
                    ...(typeof w.stable === "string"
                      ? { stable: w.stable }
                      : {}),
                  },
                ];
              },
            );
          }
        }
        if (epochBlocks <= 0) return null;
        return [
          key,
          { regime: s.regime, seed: s.seed, runId, epochBlocks, windows },
        ] as const;
      } catch {
        // A scenario whose events were not collected simply contributes no windows.
        return null;
      }
    }),
  );
  return new Map(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}

export interface OpenWindow {
  key: string;
  regime: string;
  seed: number;
  runId: string;
  window: ScheduledWindow;
  /** True on the round the window opens, which is the one worth calling out. */
  opening: boolean;
}

/** Every scheduled window covering a round, across the whole competition. */
export function windowsAtRound(
  schedules: Map<string, ScenarioSchedule>,
  round: number,
): OpenWindow[] {
  const out: OpenWindow[] = [];
  for (const [key, s] of schedules) {
    for (const w of s.windows) {
      if (round < w.fromRound || round > w.toRound) continue;
      out.push({
        key,
        regime: s.regime,
        seed: s.seed,
        runId: s.runId,
        window: w,
        opening: round === w.fromRound,
      });
    }
  }
  // Opening windows first: a window that has been open for three rounds is context, one that just
  // opened is the news.
  out.sort((a, b) => Number(b.opening) - Number(a.opening));
  return out;
}
