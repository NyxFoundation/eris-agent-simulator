// A lending position is found through the agent's own index, never through a slice of the market
// list (issue #212 / #216 item 1).
//
// `createMarket` is permissionless and costs its caller nothing but gas, so the length of the market
// list is anybody's choice. The valuation used to read `marketIds()` whole (an eth_call that stops
// answering past a few thousand entries) and keep the newest 512 before dropping the empty ones --
// so 512 empty markets opened after a victim's market pushed the victim's position out of the
// valuation, and the zero that replaced it looked like a trading loss. Now the contract records
// which markets each address entered, the valuation reads that list per agent, and the observation
// walks the market list in pages of `marketIdAt`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Address, PublicClient } from "viem";
import { TOKENS } from "../sdk/src/constants.js";
import { PAR_STABLE_PRICES } from "../sdk/src/stables.js";
import {
  LENDING_ID_PAGE_SIZE,
  LENDING_OBSERVATION_LIMIT,
  lendingAdapter,
  MARKET_SCAN_LIMIT,
  observeLending,
  readLendingState,
  setLendingSingleton,
  simpleLendingAbi,
  USER_MARKET_LIMIT,
} from "../sdk/src/protocols/lending.js";
import type {
  SimContext,
  ValuationContext,
  ValuationRead,
  ValuationRun,
} from "../sdk/src/protocols/types.js";

const SINGLETON = "0x00000000000000000000000000000000000000ee" as Address;
const VICTIM = {
  id: "victim",
  address: "0x00000000000000000000000000000000000000aa" as Address,
};
const SPAMMER = {
  id: "spammer",
  address: "0x00000000000000000000000000000000000000bb" as Address,
};
const ORACLE = "0x000000000000000000000000000000000000000c" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const USDC = TOKENS.USDC.address;
const WETH = TOKENS.WETH.address;
const WAD = 10n ** 18n;
const SUPPLY = 10_000_000_000n; // 10,000 USDC

const marketId = (i: number) =>
  `0x${(i + 1).toString(16).padStart(64, "0")}` as `0x${string}`;
const PARAMS = [USDC, WETH, ORACLE, ZERO, (8n * WAD) / 10n] as const;
const EMPTY_TOTALS = [0n, 0n, 0n, 0n, 1n, 0n];

type Call = { functionName: string; args?: readonly unknown[] };

// A chain with `n` markets, of which only the first is inhabited: the victim supplied 10,000 USDC
// to market 0 and the other n-1 were opened empty, after it, by somebody else.
function chain(opts: {
  n: number;
  victimIndexTotal?: number;
  failing?: Set<string>;
}) {
  const calls: Call[] = [];
  const victimIds = [marketId(0)];
  const answer = (c: Call): unknown => {
    calls.push(c);
    if (opts.failing?.has(c.functionName)) throw new Error("read failed");
    const [a0, a1, a2] = c.args ?? [];
    switch (c.functionName) {
      case "marketCount":
        return BigInt(opts.n);
      case "marketIdAt":
        return marketId(Number(a0));
      case "userMarketIdsFrom": {
        const isVictim = (a0 as string).toLowerCase() === VICTIM.address;
        const ids = isVictim ? victimIds : [];
        const total = isVictim ? (opts.victimIndexTotal ?? ids.length) : 0;
        const start = Number(a1);
        const limit = Number(a2);
        return [ids.slice(start, start + limit), BigInt(total)];
      }
      case "market":
        return a0 === marketId(0) ? [SUPPLY, SUPPLY, 0n, 0n, 1n, 0n] : EMPTY_TOTALS;
      case "marketParams":
        return PARAMS;
      case "expectedPosition": {
        const user = (a1 as string).toLowerCase();
        const p = a0 as { loanToken: string };
        return user === VICTIM.address && p.loanToken === USDC
          ? [SUPPLY, 0n, 0n]
          : [0n, 0n, 0n];
      }
      case "isHealthy":
        return true;
      case "liquidationIncentiveFactor":
        return (105n * WAD) / 100n;
      case "price":
        return 10n ** 36n;
      case "owner":
        throw new Error("no owner()");
      case "marketIds":
        throw new Error("marketIds() must never be read");
      default:
        throw new Error(`unexpected read ${c.functionName}`);
    }
  };
  const multicalls: Call[][] = [];
  const client = {
    readContract: async (c: Call) => answer(c),
    multicall: async ({ contracts }: { contracts: Call[] }) => {
      multicalls.push(contracts);
      return contracts.map((c) => {
        try {
          return { status: "success" as const, result: answer(c) };
        } catch {
          return { status: "failure" as const };
        }
      });
    },
  } as unknown as PublicClient;
  const ctx = {
    lending: SINGLETON,
    publicClient: client,
    fairPrices: { WETH: 2000 },
  } as unknown as SimContext;
  return { calls, multicalls, answer, client, ctx };
}

function valuationCtx(): ValuationContext {
  return {
    publicClient: {} as never,
    blockNumber: 100,
    horizonBlock: 100,
    agents: [VICTIM, SPAMMER],
    activeStables: [USDC],
    fairByBase: () => ({ WETH: 2000 }),
    stablePrices: () => PAR_STABLE_PRICES,
  };
}

// Drive the staged generator the way the scorer does, answering each stage's reads from the fake.
async function drive(run: ValuationRun, answer: (c: Call) => unknown) {
  const stages: ValuationRead[][] = [];
  let step = await run.next();
  while (!step.done) {
    stages.push(step.value);
    const results = step.value.map((r) => {
      try {
        return answer(r);
      } catch {
        return undefined;
      }
    });
    step = await run.next(results);
  }
  return { values: step.value, stages };
}

function valueAtBlock(answer: (c: Call) => unknown) {
  setLendingSingleton(SINGLETON);
  try {
    return drive(lendingAdapter.valueAtBlock!(valuationCtx()), answer);
  } finally {
    setLendingSingleton(undefined);
  }
}

test("a position behind 600 newer empty markets is still valued, at a cost that does not grow with them", async () => {
  const small = chain({ n: 601 });
  const { values, stages } = await valueAtBlock(small.answer);
  assert.ok(Math.abs(values.victim.valueUsdc - 10_000) < 1e-6, `got ${values.victim.valueUsdc}`);
  assert.equal(values.victim.liquidatableValueUsdc, values.victim.valueUsdc);
  assert.deepEqual(values.victim.unpriced, []);
  assert.equal(values.spammer.valueUsdc, 0);

  const read = stages.flat().map((r) => r.functionName);
  assert.ok(!read.includes("marketIds"), "the whole list must never be read");
  assert.ok(!read.includes("marketIdAt"), "the valuation does not walk the list at all");
  // Positions are read for the pairs the index names, not for markets x agents.
  assert.equal(read.filter((f) => f === "expectedPosition").length, 1);

  // Ten times the spam, the same reads: the market count is not in the cost.
  const large = chain({ n: 6_001 });
  const again = await valueAtBlock(large.answer);
  assert.deepEqual(
    again.stages.flat().map((r) => [r.functionName, r.args]),
    stages.flat().map((r) => [r.functionName, r.args]),
  );
  assert.ok(Math.abs(again.values.victim.valueUsdc - 10_000) < 1e-6);
});

test("an agent whose own index outgrows the per-agent bound is told so, and the rest is still valued", async () => {
  const c = chain({ n: 10, victimIndexTotal: USER_MARKET_LIMIT + 5 });
  const { values, stages } = await valueAtBlock(c.answer);
  assert.ok(Math.abs(values.victim.valueUsdc - 10_000) < 1e-6);
  const cut = values.victim.unpriced.find((u) => u.source === "lending-unscanned");
  assert.ok(cut, "the cut must be reported");
  assert.equal(cut.reason, "read-failed");
  assert.match(cut.read ?? "", new RegExp(`of ${USER_MARKET_LIMIT + 5} markets`));
  // The bound is what was asked of the contract, so nobody can make the page bigger.
  const page = stages[0].find((r) => r.functionName === "userMarketIdsFrom");
  assert.equal(page?.args?.[2], BigInt(USER_MARKET_LIMIT));
  assert.deepEqual(values.spammer.unpriced, []);
});

test("a market the scorer could not read is reported for the agent in it, not zeroed", async () => {
  const c = chain({ n: 3, failing: new Set(["market"]) });
  const { values } = await valueAtBlock(c.answer);
  assert.equal(values.victim.valueUsdc, 0);
  assert.deepEqual(
    values.victim.unpriced.map((u) => [u.source, u.reason]),
    [[`lending-market:${marketId(0).slice(0, 10)}`, "read-failed"]],
  );
  // An agent in no market has nothing to report.
  assert.deepEqual(values.spammer.unpriced, []);
});

test("a failed index read is unknown, not an empty position list", async () => {
  const c = chain({ n: 3, failing: new Set(["userMarketIdsFrom"]) });
  const { values } = await valueAtBlock(c.answer);
  for (const id of ["victim", "spammer"])
    assert.deepEqual(
      values[id].unpriced.map((u) => [u.source, u.reason, u.read]),
      [["lending-markets", "read-failed", "SimpleLending.userMarketIdsFrom"]],
    );
});

test("the observation walks the list newest first in bounded pages and never calls marketIds()", async () => {
  const c = chain({ n: 1_000 });
  const state = await readLendingState(c.ctx);
  assert.ok(!c.calls.some((x) => x.functionName === "marketIds"));
  const idPages = c.multicalls.filter((m) => m[0]?.functionName === "marketIdAt");
  assert.ok(idPages.length >= 2, "more than one page at 512 ids");
  for (const page of idPages) assert.ok(page.length <= LENDING_ID_PAGE_SIZE);
  assert.equal(idPages.flat().length, MARKET_SCAN_LIMIT);
  assert.equal(idPages[0][0].args?.[0], 999n, "newest first");
  // The window: 32 of the newest 512 (all empty here), and the count dropped is the rest.
  assert.equal(state.marketIds.length, LENDING_OBSERVATION_LIMIT);
  assert.equal(state.marketIds[0], marketId(999));
  assert.equal(state.dropped, 1_000 - LENDING_OBSERVATION_LIMIT);
  assert.ok(!state.marketIds.includes(marketId(0)), "the inhabited market is behind the window");
});

test("the observation puts the agent's own market back in front of it when the window dropped it", async () => {
  const c = chain({ n: 1_000 });
  const state = await readLendingState(c.ctx);
  const obs = await observeLending(c.ctx, state, VICTIM.address);
  assert.ok(obs);
  assert.equal(obs.markets[0].marketId, marketId(0));
  assert.equal(obs.markets[0].supplyAssets, SUPPLY.toString());
  assert.equal(obs.markets.length, LENDING_OBSERVATION_LIMIT + 1);
  assert.equal(obs.dropped, state.dropped - 1);
  // Another agent sees the window as it was.
  const other = await observeLending(c.ctx, state, SPAMMER.address);
  assert.equal(other?.markets.length, LENDING_OBSERVATION_LIMIT);
  assert.equal(other?.dropped, state.dropped);
});

test("the end-of-run value reads the same index, so netPnlUsdc agrees with the scored series", async () => {
  const c = chain({ n: 1_000 });
  const value = await lendingAdapter.valueUsdc(c.ctx, VICTIM.address, null, 2000);
  assert.ok(Math.abs(value - 10_000) < 1e-6, `got ${value}`);
  assert.ok(!c.calls.some((x) => x.functionName === "marketIds"));
  assert.ok(!c.calls.some((x) => x.functionName === "marketIdAt"));
  assert.equal(await lendingAdapter.valueUsdc(c.ctx, SPAMMER.address, null, 2000), 0);
});

test("marketIds() is not in the SDK's ABI, so nothing here can regress to it", () => {
  assert.ok(
    !simpleLendingAbi.some((e) => (e as { name?: string }).name === "marketIds"),
  );
  const source = readFileSync(
    new URL("../sdk/src/protocols/lending.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /functionName: "marketIds"/);
});
