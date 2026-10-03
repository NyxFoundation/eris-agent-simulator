// Issue #207: what matrix.json says next to P about where its V_0 came from.
//
// The coordinator writes, per agent, how V_0 was derived (`v0Source`) and the numbers behind it:
// the V_0 P used, the chain state at the first boundary, the endowment at that boundary's marks.
// scoresFromSummary turns a gap between the last two into a flag -- the path the issue names, read
// off one agent's own numbers. It does not change P: flags are for the operator to read, not for
// the arithmetic. A second detector off pnlUsdc − netPnlUsdc was tried and removed; scenarioScores
// says why.
import test from "node:test";
import assert from "node:assert/strict";
import {
  scoresFromSummary,
  type AgentSummary,
  type RunSummary,
} from "../core/src/backtest/scenarioScores.js";

const BASKET = 73_000;

// An honest field: V_0 at the endowment, netPnlUsdc a constant 150 USDC away from P (the basket
// marked at the final fair rather than the opening one), and a little V_K read noise per agent.
function honest(id: string, pnl: number, noise = 0): AgentSummary {
  return {
    id,
    pnlUsdc: pnl,
    netPnlUsdc: pnl - 150 + noise,
    initialValueUsdc: BASKET + 150,
    finalValueUsdc: BASKET + 150 + pnl + noise,
    v0Source: "endowment",
    v0Usdc: BASKET,
    v0MeasuredUsdc: BASKET - 2,
    v0EndowmentUsdc: BASKET,
  };
}

function summary(agents: AgentSummary[]): RunSummary {
  return { runDir: "runs/x", agents, violations: [] };
}

const flagsOf = (scores: ReturnType<typeof scoresFromSummary>, id: string) =>
  scores.find((s) => s.id === id)?.flags ?? [];

test("an honest field carries no V_0 flag, and v0Source travels into the record", () => {
  const scores = scoresFromSummary(
    summary([
      honest("a", 120, 30),
      honest("b", -80, -40),
      honest("c", 10),
      { ...honest("noop", 0), baseline: true },
    ]),
    [],
  );
  for (const s of scores) assert.equal(s.flags, undefined, `${s.id}: ${s.flags}`);
  assert.equal(scores.find((s) => s.id === "a")?.v0Source, "endowment");
  assert.equal(scores.find((s) => s.id === "a")?.pnlUsdc, 120);
});

test("a basket that left before the first boundary is flagged, and P is untouched", () => {
  // The issue's attack: 70k parked before boundary 0, brought back during the epoch. With V_0 at
  // the endowment P is the honest +50 -- the flag is what tells the operator it was tried.
  const parked: AgentSummary = {
    ...honest("parker", 50),
    v0MeasuredUsdc: BASKET - 70_000,
  };
  const scores = scoresFromSummary(
    summary([parked, honest("a", 100), honest("b", -20), honest("c", 5)]),
    [],
  );
  const flags = flagsOf(scores, "parker");
  assert.equal(flags.length, 1, flags.join("\n"));
  assert.match(flags[0], /^V_0 measured at the first boundary was 70,000 USDC below the endowment/);
  assert.match(flags[0], /V_0 was taken at the endowment/);
  assert.equal(scores.find((s) => s.id === "parker")?.pnlUsdc, 50);
  assert.equal(flagsOf(scores, "a").length, 0);
});

test("value above the endowment at the first boundary is flagged the other way", () => {
  const carried: AgentSummary = {
    ...honest("carrier", 10),
    v0Source: "measured",
    v0Usdc: BASKET + 30_000,
    v0MeasuredUsdc: BASKET + 30_000,
  };
  const scores = scoresFromSummary(
    summary([carried, honest("a", 100), honest("b", -20), honest("c", 5)]),
    [],
  );
  const flags = flagsOf(scores, "carrier");
  assert.ok(
    flags.some((f) => /30,000 USDC above the endowment/.test(f) && /taken as measured/.test(f)),
    flags.join("\n"),
  );
  assert.equal(scores.find((s) => s.id === "carrier")?.v0Source, "measured");
});

test("a run recorded before the field has no V_0 numbers and raises no V_0 flag", () => {
  const old: AgentSummary = { id: "a", pnlUsdc: 10, netPnlUsdc: 5 };
  const scores = scoresFromSummary(summary([old]), []);
  assert.equal(scores[0].flags, undefined);
  assert.equal(scores[0].v0Source, undefined);
});

test("V_K read noise raises no flag: the one detector reads V_0, not the field", () => {
  // The field-constant detector is gone (see scenarioScores.ts): netPnlUsdc and P read different
  // valuations, so the difference is not a constant for anything but pure spot, and both bands
  // tried flagged honest play. What remains compares one agent's measured V_0 against its own
  // endowment, so noise at V_K -- however large, and whatever the rest of the field holds -- says
  // nothing about V_0 and raises nothing.
  for (const noise of [900, -900, 2_000, 50_000]) {
    const scores = scoresFromSummary(
      summary([honest("a", 100, noise), honest("b", -20), honest("c", 5), honest("d", 1)]),
      [],
    );
    for (const s of scores) assert.equal(s.flags, undefined, `noise ${noise}, ${s.id}`);
  }
  // And a field of two, which has no median to speak of, is no different.
  const two = scoresFromSummary(summary([honest("a", 100, 5_000), honest("b", -20)]), []);
  for (const s of two) assert.equal(s.flags, undefined, `${s.id}: ${s.flags}`);
});


