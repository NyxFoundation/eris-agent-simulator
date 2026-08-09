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
    horizonBlock: 1,
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
// An account with no perps decodes to an empty array; undefined is reserved for a read that failed
// (issue #44), so these fixtures must not use it to mean "holds nothing".
const stage1 = (gmBalances: bigint[]) => () => [
  [], // holder has no perp positions
  [], // empty has none either
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
    () => [[], [], undefined, 5n * 10n ** 18n, 0n],
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

test("an unreadable position list is reported, not scored as holding no perps (#44)", async () => {
  // undefined, unlike the empty array a real read returns for an account with no perps.
  const { values } = await drive([() => [undefined, [], marketProps, 0n, 0n]]);
  assert.equal(values.holder.valueUsdc, 0);
  assert.deepEqual(values.holder.unpriced, [
    {
      source: "gmx-position",
      amountRaw: "",
      reason: "read-failed",
      read: "GmxReader.getAccountPositions",
    },
  ]);
  // The agent whose read succeeded is left alone.
  assert.deepEqual(values.empty.unpriced, []);
});

test("an unreadable GM balance is reported, not scored as holding none (#44)", async () => {
  const { values } = await drive([() => [[], [], marketProps, undefined, 0n]]);
  assert.deepEqual(values.holder.unpriced, [
    {
      token: MARKET,
      amountRaw: "",
      source: "gmx-gm",
      reason: "read-failed",
      read: "ERC20.balanceOf",
    },
  ]);
  assert.deepEqual(values.empty.unpriced, []);
});

test("gmx accounts for its market tokens so they are not double-reported", async () => {
  const accounted = await gmxAdapter.accountedTokens!(undefined as never);
  assert.deepEqual(
    accounted.map((t) => t.toLowerCase()),
    [MARKET.toLowerCase()],
  );
});

// ---------------------------------------------------------------------------
// Perp positions across markets (#41)
//
// The scorer valued the WETH market alone -- a constraint of the old reconstruct, which could pass a
// single price -- so a perp on any other market scored zero.
// ---------------------------------------------------------------------------

const FLOAT = 10n ** 30n;
function perp(
  market: Address,
  sizeUsd: bigint,
  sizeTokens: bigint,
  collateral: bigint,
) {
  return {
    addresses: {
      account: AGENTS[0].address,
      market,
      collateralToken: TOKENS.USDC.address,
    },
    numbers: {
      sizeInUsd: sizeUsd,
      sizeInTokens: sizeTokens,
      collateralAmount: collateral,
    },
    flags: { isLong: true },
  };
}

test("a perp in a configured market is valued at its base's fair price", () => {
  // 1 WETH long entered at $3,000 with 1,000 USDC collateral, marked at $3,000: PnL 0.
  const position = perp(MARKET, 3000n * FLOAT, 10n ** 18n, 1000n * 10n ** 6n);
  return drive([() => [[position], [], marketProps, 0n, 0n]]).then(
    ({ values }) => {
      assert.ok(Math.abs(values.holder.valueUsdc - 1000) < 1e-6);
      assert.deepEqual(values.holder.unpriced, []);
    },
  );
});

test("a perp in an unconfigured market is reported, not scored at zero (#41)", async () => {
  // Before the fix this whole position -- collateral included -- silently vanished.
  const other = "0x000000000000000000000000000000000000be7f" as Address;
  const position = perp(other, 5000n * FLOAT, 10n ** 18n, 2000n * 10n ** 6n);
  const { values } = await drive([() => [[position], [], marketProps, 0n, 0n]]);
  assert.equal(values.holder.valueUsdc, 0);
  assert.deepEqual(values.holder.unpriced, [
    {
      token: other,
      amountRaw: (5000n * FLOAT).toString(),
      source: "gmx-position",
    },
  ]);
});

test("a perp whose base has no fair price is reported, not scored at zero", async () => {
  const position = perp(MARKET, 3000n * FLOAT, 10n ** 18n, 1000n * 10n ** 6n);
  const run = gmxAdapter.valueAtBlock!({
    publicClient: undefined as never,
    blockNumber: 1,
    horizonBlock: 1,
    agents: AGENTS,
    activeStables: [TOKENS.USDC.address as Address],
    fairByBase: () => ({}), // price feed read failed for every base
  });
  const first = await run.next();
  const done = await run.next([[position], [], marketProps, 0n, 0n] as never);
  assert.equal(first.done, false);
  assert.equal(done.done, true);
  const values = done.value as never as Record<
    string,
    { valueUsdc: number; unpriced: unknown[] }
  >;
  assert.equal(values.holder.valueUsdc, 0);
  assert.deepEqual(values.holder.unpriced, [
    {
      token: MARKET,
      amountRaw: (3000n * FLOAT).toString(),
      source: "gmx-position",
    },
  ]);
});
