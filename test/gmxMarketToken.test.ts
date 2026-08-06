// GM (GMX market token) liquidity valuation (issue #41).
//
// The scorer read only perp positions, so GM liquidity -- reachable through rawTx -- was worth
// exactly zero. The adapter's staged generator needs no client: every read is yielded, so the stages
// can be driven with canned results.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { gmxAdapter } from "@eris/sdk/protocols/gmx.js";
import { GMX_MARKETS, TOKENS } from "@eris/sdk/constants.js";

const MARKET = GMX_MARKETS.ETH_USD;
const AGENTS = [
  {
    id: "holder",
    address: "0x00000000000000000000000000000000000000a1" as Address,
  },
  {
    id: "empty",
    address: "0x00000000000000000000000000000000000000a2" as Address,
  },
];
const FAIR = { WETH: 3000 };

const marketProps = {
  marketToken: MARKET,
  indexToken: TOKENS.WETH.address,
  longToken: TOKENS.WETH.address,
  shortToken: TOKENS.USDC.address,
};

// Drive the generator with canned stage results, recording what it asked for.
async function drive(stages: Array<(reads: unknown[]) => unknown[]>) {
  const run = gmxAdapter.valueAtBlock!({
    publicClient: undefined as never,
    blockNumber: 1,
    agents: AGENTS,
    activeStables: [TOKENS.USDC.address as Address],
    fairByBase: () => FAIR,
  });
  const asked: unknown[][] = [];
  let input: unknown[] | undefined;
  for (;;) {
    const step = await run.next(input as never);
    if (step.done) return { values: step.value, asked };
    asked.push(step.value);
    const respond = stages[asked.length - 1];
    if (!respond)
      throw new Error(`no canned results for stage ${asked.length}`);
    input = respond(step.value);
  }
}

// stage 1 = [positions per agent, getMarket per market, GM balance per agent per market]
const stage1 = (gmBalances: bigint[]) => () => [
  undefined, // holder has no perp positions
  undefined, // empty has none either
  marketProps,
  ...gmBalances,
];

test("GM holdings are valued at the reader's market token price (#41)", async () => {
  // 1e30 == $1.00 per GM token.
  const { values, asked } = await drive([
    stage1([2n * 10n ** 18n, 0n]),
    () => [[10n ** 30n, {}]],
  ]);
  assert.equal(asked.length, 2);
  assert.ok(Math.abs(values.holder.valueUsdc - 2) < 1e-9);
  assert.ok(Math.abs(values.holder.liquidatableValueUsdc - 2) < 1e-9);
  assert.deepEqual(values.holder.unpriced, []);
  assert.equal(values.empty.valueUsdc, 0);
});

test("GM valuation scales with the reader's 30-decimal price", async () => {
  const { values } = await drive([
    stage1([10n ** 18n, 0n]),
    () => [[3n * 10n ** 30n, {}]], // $3.00 per GM token
  ]);
  // Float, not exact: the 1e30 -> USD conversion goes through Number.
  assert.ok(Math.abs(values.holder.valueUsdc - 3) < 1e-9);
});

test("a non-positive market token price marks the holding at zero, not negative", async () => {
  // The pool being underwater cannot hand an agent a negative balance sheet entry.
  const { values } = await drive([
    stage1([10n ** 18n, 0n]),
    () => [[-(10n ** 30n), {}]],
  ]);
  assert.equal(values.holder.valueUsdc, 0);
});

test("GM prices are not read when nobody holds any", async () => {
  // The second stage is pure overhead for the common case, so it must not run.
  const { values, asked } = await drive([stage1([0n, 0n])]);
  assert.equal(asked.length, 1);
  assert.equal(values.holder.valueUsdc, 0);
});

test("an unreadable market reports the holding instead of zeroing it (#41)", async () => {
  const { values, asked } = await drive([
    // getMarket failed -> undefined, so the market cannot be priced.
    () => [undefined, undefined, undefined, 5n * 10n ** 18n, 0n],
  ]);
  assert.equal(asked.length, 1, "no price read without market props");
  assert.equal(values.holder.valueUsdc, 0);
  assert.deepEqual(values.holder.unpriced, [
    {
      token: MARKET,
      amountRaw: (5n * 10n ** 18n).toString(),
      source: "gmx-gm",
    },
  ]);
});

test("a failed price read reports the holding instead of zeroing it (#41)", async () => {
  const { values } = await drive([
    stage1([5n * 10n ** 18n, 0n]),
    () => [undefined],
  ]);
  assert.equal(values.holder.valueUsdc, 0);
  assert.deepEqual(values.holder.unpriced, [
    {
      token: MARKET,
      amountRaw: (5n * 10n ** 18n).toString(),
      source: "gmx-gm",
    },
  ]);
});

test("gmx accounts for its market tokens so they are not double-reported", async () => {
  const accounted = await gmxAdapter.accountedTokens!(undefined as never);
  assert.deepEqual(
    accounted.map((t) => t.toLowerCase()),
    [MARKET.toLowerCase()],
  );
});
