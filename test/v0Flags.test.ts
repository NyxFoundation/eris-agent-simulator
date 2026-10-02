// Issue #207: what matrix.json says next to P about where its V_0 came from.
//
// The coordinator writes, per agent, how V_0 was derived (`v0Source`) and the numbers behind it:
// the V_0 P used, the chain state at the first boundary, the endowment at that boundary's marks.
// scoresFromSummary turns a gap between the last two into a flag (the path the issue names), and a
// pnlUsdc − netPnlUsdc that sits off the field's constant into another (any path it does not).
// Neither changes P: flags are for the operator to read, not for the arithmetic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  scoresFromSummary,
  PNL_GAP_TOLERANCE_FRAC,
  PNL_GAP_TOLERANCE_USDC,
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

test("pnlUsdc − netPnlUsdc off the field's constant is flagged, whatever moved it", () => {
  // The same attack seen through the other detector: a V_0 that is 70k too low makes P 70k too
  // high while netPnlUsdc (off the endowment) is honest, so this agent's difference sits 70k off
  // the field's. Nothing here reads the v0* fields.
  const bypass: AgentSummary = {
    id: "bypass",
    pnlUsdc: 50 + 70_000,
    netPnlUsdc: 50 - 150,
    initialValueUsdc: BASKET + 150,
    finalValueUsdc: BASKET + 150 + 50,
  };
  const scores = scoresFromSummary(
    summary([bypass, honest("a", 100), honest("b", -20), honest("c", 5)]),
    [],
  );
  const flags = flagsOf(scores, "bypass");
  assert.equal(flags.length, 1, flags.join("\n"));
  assert.match(
    flags[0],
    /^pnlUsdc − netPnlUsdc is 70,000 USDC off the field's constant \(70,150 vs median 150\)/,
  );
  for (const id of ["a", "b", "c"]) assert.equal(flagsOf(scores, id).length, 0);
});

test("the field's tolerance is for V_K read noise, and needs a field to be a constant", () => {
  // 2% of the basket: three blocks of fair drift on a full basket in a stress tail stays inside it.
  assert.equal(PNL_GAP_TOLERANCE_FRAC, 0.02);
  assert.equal(PNL_GAP_TOLERANCE_USDC, 100);
  const within = scoresFromSummary(
    summary([honest("a", 100, 900), honest("b", -20, -900), honest("c", 5), honest("d", 1)]),
    [],
  );
  for (const s of within) assert.equal(s.flags, undefined, `${s.id}: ${s.flags}`);
  const beyond = scoresFromSummary(
    summary([honest("a", 100, 2_000), honest("b", -20), honest("c", 5), honest("d", 1)]),
    [],
  );
  assert.equal(flagsOf(beyond, "a").length, 1);
  // Two agents: a median of two numbers is not a field constant, so nothing is said.
  const two = scoresFromSummary(
    summary([honest("a", 100, 5_000), honest("b", -20)]),
    [],
  );
  for (const s of two) assert.equal(s.flags, undefined, `${s.id}: ${s.flags}`);
});
