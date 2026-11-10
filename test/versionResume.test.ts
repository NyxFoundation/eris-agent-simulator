// A revert to version 0 across an epoch boundary.
//
// `revertTo: 0` installs a new version that runs the shipped strategy. Its source is the whole of
// agent.ts, not a decide body, and it used to be persisted as such: the next epoch compiled it as an
// executor, failed on the import statement, logged `revision_resume_failed` and dropped the version
// from the history the model is given. The running strategy was still right (a newest version that
// fails falls back to version 0), but the history was not, and `revertTo` that version number was
// refused. Reported by a participant on 600579e: spike#101 -> calm#101 with v1 = revert to v0,
// v2 = a body, v3 = revert to v0 resumed with versionsCarried 1 / versionsRefused 2.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileExecutor, type StrategyVersion } from "../example/agents/runtime/improve.js";
import {
  AgentStateStore,
  VERSIONS_FILE,
  type PersistedVersion,
} from "../example/agents/runtime/state.js";
import {
  persistedVersion,
  resumeVersions,
  revertNotes,
  type PrepareSource,
} from "../example/agents/runtime/versionResume.js";

const AGENT_TS = readFileSync("example/agents/venue-arb/agent.ts", "utf8");
// The participant edited agent.ts between the epochs.
const EDITED_AGENT_TS = `${AGENT_TS}\n// tuned between epochs\n`;
const BODY = "return null;";

// The executor compile the TypeScript resume uses, counting its calls.
function prepare(): { fn: PrepareSource<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: async (source) => {
      calls.push(source);
      const compiled = compileExecutor(source);
      return compiled.ok ? { ok: true, source } : compiled;
    },
  };
}

function version(
  n: number,
  fields: { source?: string; shipped?: true; notes?: string },
): PersistedVersion {
  const meta = {
    version: n,
    notes: fields.notes ?? `v${n}`,
    installedAtBlock: n * 60,
    valueAtInstall: 25_000,
    epochId: "epoch-1",
  };
  return fields.shipped ? { ...meta, shipped: true } : { ...meta, source: fields.source ?? BODY };
}

test("the shipped strategy's text is not a decide body, which is the whole bug", () => {
  const compiled = compileExecutor(AGENT_TS);
  assert.ok(!compiled.ok);
  assert.match(compiled.reason, /import statement outside a module/);
});

test("a revert to version 0 is persisted as a marker, without agent.ts", () => {
  const shipped: StrategyVersion = {
    version: 0,
    source: AGENT_TS,
    notes: "the strategy as submitted",
    installedAtBlock: 0,
    valueAtInstall: null,
    shipped: true,
  };
  // What botMain's revert does: copy the target and renumber it.
  const revert: StrategyVersion = {
    ...shipped,
    version: 1,
    notes: revertNotes(0, "back to what was shipped"),
    installedAtBlock: 60,
  };
  const body: StrategyVersion = { ...revert, shipped: undefined, version: 2, source: BODY };
  const dir = mkdtempSync(join(tmpdir(), "eris-version-resume-"));
  const store = AgentStateStore.open({ dir, onProblem: assert.fail })!;
  store.save({
    schema: 1,
    epochs: ["epoch-1"],
    versions: [revert, body].map((v) => persistedVersion(v, "epoch-1")),
  });
  const written = readFileSync(join(dir, VERSIONS_FILE), "utf8");
  assert.ok(!written.includes("import"), "agent.ts is not copied into the state");
  const loaded = store.load();
  assert.ok(loaded.ok === true);
  assert.equal(loaded.state.versions[0].shipped, true);
  assert.equal(loaded.state.versions[0].source, undefined);
  assert.equal(loaded.state.versions[0].epochId, "epoch-1");
  assert.equal(loaded.state.versions[1].shipped, undefined);
  assert.equal(loaded.state.versions[1].source, BODY);
});

test("a marked version resumes as the shipped strategy, even after agent.ts was edited", async () => {
  const { fn, calls } = prepare();
  const resumed = await resumeVersions(
    [
      version(1, { shipped: true, notes: revertNotes(0, "a") }),
      version(2, { source: BODY }),
      version(3, { shipped: true, notes: revertNotes(1, "b") }),
    ],
    { shippedSource: EDITED_AGENT_TS, language: "typescript", prepare: fn },
  );
  assert.deepEqual(
    resumed.map((r) => [r.version.version, r.kind, r.kind === "shipped" ? r.via : null]),
    [
      [1, "shipped", "marker"],
      [2, "compiled", null],
      [3, "shipped", "marker"],
    ],
  );
  // A marker is never compiled: the shipped strategy runs as the module it is.
  assert.deepEqual(calls, [BODY]);
});

test("state written before the marker: the reported sequence carries all three versions", async () => {
  // v1 and v3 hold agent.ts verbatim, as the participant found in the checkpoint.
  const { fn } = prepare();
  const resumed = await resumeVersions(
    [
      version(1, { source: AGENT_TS, notes: revertNotes(0, "a") }),
      version(2, { source: BODY, notes: "ENTRY_MARGIN 10 -> 50 bps" }),
      version(3, { source: AGENT_TS, notes: revertNotes(0, "b") }),
    ],
    { shippedSource: AGENT_TS, language: "typescript", prepare: fn },
  );
  assert.deepEqual(
    resumed.map((r) => [r.version.version, r.kind, r.kind === "shipped" ? r.via : null]),
    [
      [1, "shipped", "legacy-source"],
      [2, "compiled", null],
      [3, "shipped", "legacy-source"],
    ],
  );
});

test("state written before the marker, agent.ts edited since: the revert notes carry it", async () => {
  // v3 reverts to v1, which itself was a revert to v0: the chain is followed.
  const { fn } = prepare();
  const resumed = await resumeVersions(
    [
      version(1, { source: AGENT_TS, notes: revertNotes(0, "a") }),
      version(2, { source: BODY }),
      version(3, { source: AGENT_TS, notes: revertNotes(1, "b") }),
    ],
    { shippedSource: EDITED_AGENT_TS, language: "typescript", prepare: fn },
  );
  assert.deepEqual(
    resumed.map((r) => [r.version.version, r.kind, r.kind === "shipped" ? r.via : null]),
    [
      [1, "shipped", "legacy-notes"],
      [2, "compiled", null],
      [3, "shipped", "legacy-notes"],
    ],
  );
});

test("the legacy path never re-reads a working body as the shipped strategy", async () => {
  // A model can put "reverted to v0: " at the front of its own notes. The legacy path is only taken
  // once the compile has failed, so a body that compiles runs as the body.
  const { fn } = prepare();
  const resumed = await resumeVersions(
    [version(1, { source: BODY, notes: revertNotes(0, "not really") })],
    { shippedSource: AGENT_TS, language: "typescript", prepare: fn },
  );
  assert.equal(resumed[0].kind, "compiled");
});

test("a body that does not compile and is no revert is still refused", async () => {
  const { fn } = prepare();
  const resumed = await resumeVersions(
    [
      version(1, { source: "this is not ( javascript" }),
      // A revert to a version that did not run the shipped strategy is not one either.
      version(2, { source: "nor ( this", notes: revertNotes(1, "c") }),
      version(3, {
        source: `await ctx.publicClient.request({ method: "anvil_setBalance" }); return null;`,
      }),
    ],
    { shippedSource: AGENT_TS, language: "typescript", prepare: fn },
  );
  assert.deepEqual(resumed.map((r) => r.kind), ["refused", "refused", "refused"]);
  assert.ok(resumed[2].kind === "refused");
  assert.match(resumed[2].reason, /privileged calls/);
});

test("parseState: a marker is the literal true, and only a marked version may omit its source", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-version-resume-"));
  const load = (v: Record<string, unknown>) => {
    writeFileSync(
      join(dir, VERSIONS_FILE),
      JSON.stringify({ schema: 1, epochs: [], versions: [{ version: 1, notes: "", epochId: "e", ...v }] }),
    );
    return AgentStateStore.open({ dir, onProblem: assert.fail })!.load();
  };
  assert.equal(load({ shipped: true }).ok, true);
  assert.equal(load({ source: BODY }).ok, true);
  assert.equal(load({}).ok, false);
  assert.equal(load({ shipped: "yes", source: BODY }).ok, false);
  assert.equal(load({ shipped: false, source: BODY }).ok, false);
  // A marker wins over a stray source: the source is never what runs.
  const both = load({ shipped: true, source: "return 1;" });
  assert.ok(both.ok === true);
  assert.equal(both.state.versions[0].source, undefined);
});
