// Carrying the installed versions across an epoch boundary (issue #77), one persisted version at a
// time.
//
// Two kinds of version are persisted. Most are the model's decide bodies, which are untrusted input
// and are compiled again every epoch. The other kind is a revert to version 0: it runs the strategy
// the participant shipped, which is a whole module (agent.ts) rather than a decide body, so it cannot
// go through the executor compile at all. Those are written with `shipped: true` and no source, and
// are rebuilt here from the agent.ts the epoch already has -- so they survive the participant editing
// agent.ts between epochs, exactly as version 0 itself does.
//
// The marker is safe to trust from a file the agent can write: all it can select is the
// participant's own shipped strategy, never code that skipped the compile.
//
// State written before the marker existed carried such a revert as a copy of agent.ts, which failed
// the compile on resume and dropped out of the history. Those are recognised only after the compile
// has failed, so a decide body is never re-read as the shipped strategy: by its source matching the
// current agent.ts, or by the notes the runtime writes on a revert (`revertNotes`) naming version 0
// or a version that was itself recognised as one.
import type { StrategyVersion } from "./improve.js";
import type { PersistedVersion } from "./state.js";

const REVERT_NOTES = /^reverted to v(\d+): /;

/// The notes the runtime gives a version created by `revertTo`. Read back by the legacy path below,
/// so the two are kept in one place.
export function revertNotes(target: number, notes: string): string {
  return `reverted to v${target}: ${notes}`;
}

/// What the epoch boundary keeps of an installed version. One that runs the shipped strategy keeps
/// the marker and not its source: the source is the whole of agent.ts, which the resume could not
/// compile, and which the next epoch has anyway -- possibly edited, which the marker survives.
export function persistedVersion(v: StrategyVersion, epochId: string): PersistedVersion {
  const { shipped, source, ...meta } = v;
  const withEpoch = { ...meta, epochId: v.epochId ?? epochId };
  return shipped ? { ...withEpoch, shipped: true } : { ...withEpoch, source };
}

export type PrepareSource<E> = (
  source: string,
) => Promise<{ ok: true; source: E } | { ok: false; reason: string }>;

export type ResumedVersion<E> =
  | {
      kind: "shipped";
      version: PersistedVersion;
      // `marker` is the current format; the other two are state written before it.
      via: "marker" | "legacy-source" | "legacy-notes";
    }
  | {
      kind: "compiled";
      version: PersistedVersion & { source: string };
      executor: E;
    }
  | { kind: "refused"; version: PersistedVersion; reason: string };

export async function resumeVersions<E>(
  persisted: readonly PersistedVersion[],
  opts: {
    // The text of the strategy the epoch was started with (agent.ts / strategy.py).
    shippedSource: string;
    language: "typescript" | "python";
    prepare: PrepareSource<E>;
  },
): Promise<ResumedVersion<E>[]> {
  // Versions known to run the shipped strategy. Persisted in install order, so a revert's target is
  // always classified before the revert itself.
  const runsShipped = new Set<number>([0]);
  const out: ResumedVersion<E>[] = [];
  for (const v of persisted) {
    if (v.shipped === true) {
      runsShipped.add(v.version);
      out.push({ kind: "shipped", version: v, via: "marker" });
      continue;
    }
    const persistedLanguage = v.language ?? "typescript";
    if (persistedLanguage !== opts.language) {
      out.push({
        kind: "refused",
        version: v,
        reason: `persisted language ${persistedLanguage} does not match ${opts.language}`,
      });
      continue;
    }
    // Untrusted input, every epoch. It compiled last epoch under a check that may since have been
    // tightened, and "it was fine yesterday" is not a property of generated code.
    const compiled = await opts.prepare(v.source);
    if (compiled.ok) {
      out.push({ kind: "compiled", version: v, executor: compiled.source });
      continue;
    }
    const via = legacyShipped(v, opts.shippedSource, runsShipped);
    if (via) {
      runsShipped.add(v.version);
      out.push({ kind: "shipped", version: v, via });
      continue;
    }
    out.push({ kind: "refused", version: v, reason: compiled.reason });
  }
  return out;
}

function legacyShipped(
  v: PersistedVersion & { source: string },
  shippedSource: string,
  runsShipped: ReadonlySet<number>,
): "legacy-source" | "legacy-notes" | null {
  if (v.source === shippedSource) return "legacy-source";
  const m = REVERT_NOTES.exec(v.notes);
  if (m && runsShipped.has(Number(m[1]))) return "legacy-notes";
  return null;
}
