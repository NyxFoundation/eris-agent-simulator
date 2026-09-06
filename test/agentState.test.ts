// Cross-epoch agent state (issue #77).
//
// The feature is a promise: what the model installed in epoch 3 is still running in epoch 4. The
// tests are about the ways that promise can go wrong rather than the happy path -- a half-written
// file loaded as a strategy, a persisted rewrite that no longer passes the cheatcode check, a full
// disk that stops the agent trading, a re-run that inherits the state of the attempt it is meant to
// replace, and a roster id that names a directory outside its own root.
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentStateStore,
  capBytesFromEnv,
  clampMemory,
  DEFAULT_STATE_CAP_BYTES,
  MAX_EPOCHS_KEPT,
  MAX_MEMORY_CHARS,
  VERSIONS_FILE,
  type PersistedState,
} from "../example/agents/runtime/state.js";
import { compileExecutor } from "../example/agents/runtime/improve.js";
import {
  prepareAgentState,
  restoreAgentState,
  restoreAllAgentState,
  snapshotAllAgentState,
  SNAPSHOT_DIR,
} from "../core/src/realtime/agentState.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eris-agent-state-"));
}

const noProblem = (): void => {};

function state(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    schema: 1,
    epochs: ["epoch-1"],
    versions: [
      {
        version: 1,
        source: "return null;",
        notes: "widened the entry threshold",
        installedAtBlock: 120,
        valueAtInstall: 25_100,
        epochId: "epoch-1",
      },
    ],
    ...overrides,
  };
}

test("AgentStateStore: no directory configured is not an error, it is a run without persistence", () => {
  // Every path that existed before #77 -- a single backtest, the practice devnet, a matrix without
  // --agent-state-root -- has to keep starting each agent from agent.ts.
  assert.equal(
    AgentStateStore.open({ dir: undefined, onProblem: noProblem }),
    null,
  );
});

test("AgentStateStore: a round trip carries the versions, the epochs and the memory", () => {
  const dir = tmp();
  const store = AgentStateStore.open({ dir, onProblem: noProblem })!;
  assert.equal(store.load().ok, "absent");
  store.save(state({ memory: "the depeg window closed before I could size up" }));

  const reopened = AgentStateStore.open({ dir, onProblem: noProblem })!;
  const loaded = reopened.load();
  assert.equal(loaded.ok, true);
  assert.ok(loaded.ok === true);
  assert.equal(loaded.state.versions[0].notes, "widened the entry threshold");
  // The epoch a version went in is what makes "this version has now lost two epochs in a row"
  // visible instead of inferred.
  assert.equal(loaded.state.versions[0].epochId, "epoch-1");
  assert.match(loaded.state.memory ?? "", /depeg window/);
});

test("AgentStateStore: a half-written file is never loaded as a strategy", () => {
  // The epoch can be killed between any two blocks. The write is to a sibling and a rename, so a
  // truncated file cannot exist under the real name -- and if one somehow does, it is refused.
  const dir = tmp();
  writeFileSync(join(dir, VERSIONS_FILE), '{"schema":1,"versions":[{"vers');
  const problems: string[] = [];
  const store = AgentStateStore.open({ dir, onProblem: (r) => problems.push(r) })!;
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.ok(loaded.ok === false);
  assert.match(loaded.reason, /unreadable/);
});

test("AgentStateStore: a file from something else is refused rather than half-read", () => {
  const dir = tmp();
  writeFileSync(join(dir, VERSIONS_FILE), JSON.stringify({ schema: 99, versions: [] }));
  const loaded = AgentStateStore.open({ dir, onProblem: noProblem })!.load();
  assert.ok(loaded.ok === false);
  assert.match(loaded.reason, /not a state file/);
});

test("AgentStateStore: filling the cap stops the persistence, not the agent", () => {
  // A full disk is a degraded epoch. An agent that stops trading because it could not write a file
  // has lost the epoch for a reason that has nothing to do with trading.
  const dir = tmp();
  const problems: string[] = [];
  const store = AgentStateStore.open({
    dir,
    capBytes: 64,
    onProblem: (r) => problems.push(r),
  })!;
  store.save(state({ memory: "x".repeat(2_000) }));
  assert.equal(existsSync(join(dir, VERSIONS_FILE)), false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cap/);
  // Reported once, then silent: a per-block warning would bury the run's log in the failure it is
  // already reporting.
  store.save(state());
  assert.equal(problems.length, 1);
  assert.equal(store.enabled, false);
});

test("AgentStateStore: the memory is bounded, so it cannot become the state", () => {
  // It exists so the model has somewhere to put a conclusion that is not code. Unbounded it is a
  // place to put the observation log, which the cap would then have to absorb.
  const dir = tmp();
  const store = AgentStateStore.open({ dir, onProblem: noProblem })!;
  store.save(state({ memory: "y".repeat(MAX_MEMORY_CHARS * 2) }));
  const written = JSON.parse(
    readFileSync(join(dir, VERSIONS_FILE), "utf8"),
  ) as PersistedState;
  assert.equal(written.memory?.length, MAX_MEMORY_CHARS);
});

test("a persisted strategy is untrusted input at load, not code that was already checked", () => {
  // It compiled last epoch, under a check that may since have been tightened, and it was written by
  // a model. "It was fine yesterday" is not a property of generated code, so the resume runs the
  // cheatcode check and the vm compile again -- and a failure falls back to agent.ts.
  const carried = compileExecutor(
    `await ctx.publicClient.request({ method: "anvil_setBalance" }); return null;`,
  );
  assert.ok(!carried.ok);
  assert.match(carried.reason, /privileged calls/);
});

test("prepareAgentState: the snapshot is what the epoch started with, not what it ended with", () => {
  // Rules §4.4.2 re-runs a voided epoch with the same seed. A re-run that inherits the state the
  // first attempt *finished* with is a different experiment.
  const root = tmp();
  const dir = prepareAgentState(root, "venue-arb", "epoch-7");
  writeFileSync(join(dir, VERSIONS_FILE), "before");
  // Second call, same epoch: the first attempt's ending state must not become the snapshot.
  prepareAgentState(root, "venue-arb", "epoch-7");
  assert.equal(
    existsSync(join(root, SNAPSHOT_DIR, "epoch-7", "venue-arb", VERSIONS_FILE)),
    false,
  );

  writeFileSync(join(dir, VERSIONS_FILE), "after");
  assert.equal(restoreAgentState(root, "venue-arb", "epoch-7"), true);
  assert.equal(existsSync(join(dir, VERSIONS_FILE)), false);
});

test("prepareAgentState: an epoch that never ran under persistence cannot be re-run under it", () => {
  const root = tmp();
  assert.equal(restoreAgentState(root, "venue-arb", "never-ran"), false);
});

test("prepareAgentState: a roster id cannot name a directory outside its own root", () => {
  // The id comes from the roster and is joined onto a path. On a shared box a traversal would let
  // one entry point at another participant's state. Refused rather than sanitized: a rewritten id
  // would silently point two agents at one directory.
  const root = tmp();
  for (const bad of ["../escape", "a/b", "..", ""])
    assert.throws(() => prepareAgentState(root, bad, "epoch-1"), /state directory name/);
  assert.throws(
    () => prepareAgentState(root, "venue-arb", "../elsewhere"),
    /state directory name/,
  );
});


test("repeats of one scenario each start from the same state, or they are not repeats", () => {
  // `backtest --repeat N` exists to show how far a scenario moves run to run. With state carrying,
  // repeat 2 starting from what repeat 1 left behind measures a sequence and reports it as a spread.
  const root = tmp();
  const alice = prepareAgentState(root, "venue-arb", "epoch-1");
  const bob = prepareAgentState(root, "peg-arb", "epoch-1");
  writeFileSync(join(alice, VERSIONS_FILE), "carried in");
  writeFileSync(join(bob, VERSIONS_FILE), "carried in");

  snapshotAllAgentState(root, "repeat-base-calm-101");
  writeFileSync(join(alice, VERSIONS_FILE), "what repeat 1 left behind");
  assert.equal(restoreAllAgentState(root, "repeat-base-calm-101"), true);
  assert.equal(readFileSync(join(alice, VERSIONS_FILE), "utf8"), "carried in");
  assert.equal(readFileSync(join(bob, VERSIONS_FILE), "utf8"), "carried in");

  // An agent that only appeared during the repeat is removed by the restore, not left behind as a
  // ninth agent nobody ran.
  const late = prepareAgentState(root, "my-arb", "epoch-1");
  writeFileSync(join(late, VERSIONS_FILE), "appeared later");
  restoreAllAgentState(root, "repeat-base-calm-101");
  assert.equal(existsSync(join(late, VERSIONS_FILE)), false);
});

test("restoreAllAgentState: a label that was never snapshotted says so rather than wiping the root", () => {
  const root = tmp();
  const dir = prepareAgentState(root, "venue-arb", "epoch-1");
  writeFileSync(join(dir, VERSIONS_FILE), "kept");
  assert.equal(restoreAllAgentState(root, "no-such-label"), false);
  assert.equal(readFileSync(join(dir, VERSIONS_FILE), "utf8"), "kept");
});


test("capBytesFromEnv: a malformed cap falls back to the default, an explicit zero does not", () => {
  // Falling back on garbage is the safe direction: an unbounded state directory on a shared box is
  // one agent's problem becoming everybody's. But 0 is an operator saying "no persistence", and
  // overriding that would be the runtime ignoring the operator.
  for (const bad of [undefined, "", "  ", "lots", "-1", "Infinity", "NaN"])
    assert.equal(capBytesFromEnv(bad), DEFAULT_STATE_CAP_BYTES);
  assert.equal(capBytesFromEnv("0"), 0);
  assert.equal(capBytesFromEnv("1048576"), 1_048_576);
});

test("AgentStateStore: the epoch list is bounded, so a restarting devnet cannot grow the file", () => {
  const dir = tmp();
  const store = AgentStateStore.open({ dir, onProblem: noProblem })!;
  const many = Array.from({ length: MAX_EPOCHS_KEPT + 50 }, (_, i) => `epoch-${i}`);
  store.save(state({ epochs: many }));
  const loaded = store.load();
  assert.ok(loaded.ok === true);
  assert.equal(loaded.state.epochs.length, MAX_EPOCHS_KEPT);
  // The newest are the ones kept: "which epoch is this" is the question the list answers.
  assert.equal(loaded.state.epochs.at(-1), `epoch-${MAX_EPOCHS_KEPT + 49}`);
});


test("parseState: version numbers are integers or the file is not ours", () => {
  // parseRevision holds `revertTo` to that standard and this is the same numbering. A persisted 1.5
  // makes the next version 2.5, and every number in the log and the context fractional from then on.
  const dir = tmp();
  for (const bad of [1.5, -1, "2"]) {
    writeFileSync(
      join(dir, VERSIONS_FILE),
      JSON.stringify({
        schema: 1,
        epochs: [],
        versions: [{ version: bad, source: "return null;", epochId: "e" }],
      }),
    );
    const loaded = AgentStateStore.open({ dir, onProblem: noProblem })!.load();
    assert.ok(loaded.ok === false, `expected refusal for version ${bad}`);
  }
});

test("parseState: a version with no epoch id is refused, not labelled unknown", () => {
  // This runtime always writes one. Coercing it to "unknown" would degrade the cross-epoch history
  // to the state the feature exists to fix, and nothing would say why.
  const dir = tmp();
  writeFileSync(
    join(dir, VERSIONS_FILE),
    JSON.stringify({
      schema: 1,
      epochs: [],
      versions: [{ version: 1, source: "return null;" }],
    }),
  );
  const loaded = AgentStateStore.open({ dir, onProblem: noProblem })!.load();
  assert.ok(loaded.ok === false);
  assert.match(loaded.reason, /not a state file/);
});

test("AgentStateStore: an orphaned tmp file from a killed epoch is cleaned up on open", () => {
  // An epoch killed between the write and the rename leaves the sibling. Nothing reads it, and it
  // counts against the cap -- one per killed epoch is a directory that fills itself.
  const dir = tmp();
  writeFileSync(join(dir, `${VERSIONS_FILE}.tmp`), "half a file");
  AgentStateStore.open({ dir, onProblem: noProblem });
  assert.equal(existsSync(join(dir, `${VERSIONS_FILE}.tmp`)), false);
});

test("clampMemory bounds the note where it is set, not only where it is written", () => {
  assert.equal(clampMemory("short"), "short");
  assert.equal(clampMemory("z".repeat(MAX_MEMORY_CHARS + 10)).length, MAX_MEMORY_CHARS);
});

test("snapshots are pruned, so a competition of them cannot fill the disk", () => {
  // One copy of a 64 MiB directory per agent per epoch is tens of gigabytes over k = 40, and §4.4.2
  // voids an epoch and re-runs it promptly or not at all.
  const root = tmp();
  for (let i = 0; i < 12; i++) prepareAgentState(root, "venue-arb", `epoch-${String(i).padStart(2, "0")}`);
  const kept = readdirSync(join(root, SNAPSHOT_DIR));
  assert.equal(kept.length, 8);
  // The newest survive: an old epoch is the one nobody is going to re-run.
  assert.ok(kept.includes("epoch-11"));
  assert.ok(!kept.includes("epoch-00"));
});

test("a restore leaves no half-copied directory behind under its own name", () => {
  // The obvious rm -rf then cp -r destroys the state first and restores it second; a copy that
  // fails halfway leaves nothing at all. The staging directories are not agents either -- copying
  // one into the next snapshot would make it one.
  const root = tmp();
  const dir = prepareAgentState(root, "venue-arb", "epoch-1");
  writeFileSync(join(dir, VERSIONS_FILE), "start of epoch 1");
  prepareAgentState(root, "venue-arb", "epoch-2");
  writeFileSync(join(dir, VERSIONS_FILE), "end of epoch 2");
  assert.equal(restoreAgentState(root, "venue-arb", "epoch-2"), true);
  assert.equal(readFileSync(join(dir, VERSIONS_FILE), "utf8"), "start of epoch 1");
  assert.deepEqual(
    readdirSync(root).filter((n) => n !== SNAPSHOT_DIR),
    ["venue-arb"],
  );
});
