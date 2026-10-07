// Issue #196: a boundary read fails at two granularities. A read that fails is already that holding's
// (allowFailure, #44) -- and viem turns a failed multicall chunk into one failure per read. What
// still took the whole boundary down was a venue's valuation *throwing* for the field: one agent's
// state the venue's code cannot decode, and the boundary is dropped for everybody. Now the venue is
// re-run one agent at a time, the agent whose state threw carries the failure in its value, and
// the boundary stands for the rest. Only when it throws for every agent alone is it the boundary's.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { runValuations } from "../core/src/realtime/reconstruct.js";
import type {
  AgentProtocolValue,
  ValuationRead,
  ValuationRun,
} from "../sdk/src/protocols/types.js";

const agents = ["good", "evil", "fine"].map((id, i) => ({
  id,
  address: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
}));

const read = (tag: string): ValuationRead =>
  ({ address: agents[0].address, abi: [], functionName: tag }) as unknown as ValuationRead;

// A venue that reads one thing per agent and values each at 100, but whose decode throws on
// `evil`'s state -- for the field and alone.
async function* brittle(forAgents: typeof agents): ValuationRun {
  const results = yield forAgents.map((a) => read(`holding:${a.id}`));
  const out: Record<string, AgentProtocolValue> = {};
  forAgents.forEach((a, i) => {
    if (a.id === "evil") throw new Error(`cannot decode ${String(results[i])}`);
    out[a.id] = { valueUsdc: 100, liquidatableValueUsdc: 100, unpriced: [] };
  });
  return out;
}

async function* steady(forAgents: typeof agents): ValuationRun {
  yield forAgents.map((a) => read(`steady:${a.id}`));
  const out: Record<string, AgentProtocolValue> = {};
  for (const a of forAgents) out[a.id] = { valueUsdc: 7, liquidatableValueUsdc: 7, unpriced: [] };
  return out;
}

const call = async (contracts: ValuationRead[]) => contracts.map((c) => `r:${c.functionName}`);

test("a venue that throws for one agent's state is re-run per agent, and only that agent carries it", async () => {
  const values = await runValuations({
    runs: [
      { id: "uniswap", start: (a) => brittle(a as typeof agents) },
      { id: "balancer", start: (a) => steady(a as typeof agents) },
    ],
    agents,
    scorerReads: [],
    call: call as never,
    blockNumber: 1n,
    onStageZero: () => {},
  });
  const uni = values.get("uniswap")!;
  assert.equal(uni.good.valueUsdc, 100);
  assert.equal(uni.fine.valueUsdc, 100);
  assert.equal(uni.evil.valueUsdc, 0);
  assert.equal(uni.evil.unpriced.length, 1);
  assert.equal(uni.evil.unpriced[0].source, "uniswap");
  assert.match(uni.evil.unpriced[0].read ?? "", /valuation threw for this agent: cannot decode/);
  // The other venue, batched in the same stages, is untouched.
  const bal = values.get("balancer")!;
  assert.deepEqual(Object.values(bal).map((v) => v.valueUsdc), [7, 7, 7]);
});

test("a venue that throws for every agent alone is the boundary's failure, not a zero for the field", async () => {
  async function* broken(): ValuationRun {
    yield [read("marketList")];
    throw new Error("market list unreadable");
  }
  await assert.rejects(
    runValuations({
      runs: [{ id: "curve", start: () => broken() }],
      agents,
      scorerReads: [],
      call: call as never,
      blockNumber: 1n,
      onStageZero: () => {},
    }),
    /market list unreadable/,
  );
});
